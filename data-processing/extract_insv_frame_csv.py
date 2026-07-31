#!/usr/bin/env python3

import argparse
import csv
import json
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path


CSV_TIME_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
]


def parse_csv_time(value: str) -> datetime:
    value = value.strip()

    if value.endswith("Z"):
        value = value[:-1] + "+0000"

    if re.search(r"[+-]\d{2}:\d{2}$", value):
        value = value[:-3] + value[-2:]

    for fmt in CSV_TIME_FORMATS:
        try:
            dt = datetime.strptime(value, fmt)
            return dt.replace(tzinfo=None)
        except ValueError:
            pass

    raise ValueError(f"Unsupported CSV time format: {value!r}")


def format_time_into_clip(seconds: float) -> str:
    whole_seconds = int(seconds)
    hours = whole_seconds // 3600
    minutes = (whole_seconds % 3600) // 60
    secs = whole_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def run_ffprobe(path: Path) -> dict | None:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        return None
    except subprocess.CalledProcessError:
        return None

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def parse_ffprobe_creation_time(value: str | None) -> datetime | None:
    if not value:
        return None

    value = value.strip()

    if value.endswith("Z"):
        value = value[:-1] + "+0000"

    if re.search(r"[+-]\d{2}:\d{2}$", value):
        value = value[:-3] + value[-2:]

    for fmt in [
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S",
    ]:
        try:
            dt = datetime.strptime(value, fmt)
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt
        except ValueError:
            pass

    return None


def get_clip_start_from_metadata(path: Path) -> datetime | None:
    data = run_ffprobe(path)
    if not data:
        return None

    format_tags = data.get("format", {}).get("tags", {})
    creation_time = format_tags.get("creation_time")
    parsed = parse_ffprobe_creation_time(creation_time)
    if parsed:
        return parsed

    for stream in data.get("streams", []):
        stream_tags = stream.get("tags", {})
        creation_time = stream_tags.get("creation_time")
        parsed = parse_ffprobe_creation_time(creation_time)
        if parsed:
            return parsed

    return None


def get_clip_start_from_filename(path: Path) -> datetime | None:
    """
    Supports common Insta360-like filename patterns such as:

    VID_20260707_060320_00_001.insv
    VID_20260707_060320.insv
    """

    match = re.search(r"(?P<date>\d{8})[_-](?P<time>\d{6})", path.stem)
    if not match:
        return None

    raw_timestamp = match.group("date") + match.group("time")

    try:
        return datetime.strptime(raw_timestamp, "%Y%m%d%H%M%S")
    except ValueError:
        return None


def get_clip_start(path: Path) -> datetime | None:
    return get_clip_start_from_metadata(path) or get_clip_start_from_filename(path)


def get_clip_duration_seconds(path: Path) -> float | None:
    data = run_ffprobe(path)
    if not data:
        return None

    duration = data.get("format", {}).get("duration")
    if duration:
        try:
            return float(duration)
        except ValueError:
            pass

    for stream in data.get("streams", []):
        duration = stream.get("duration")
        if duration:
            try:
                return float(duration)
            except ValueError:
                pass

    return None


def get_video_frame_count(path: Path) -> int | None:
    data = run_ffprobe(path)
    if not data:
        return None

    for stream in data.get("streams", []):
        if stream.get("codec_type") != "video":
            continue

        nb_frames = stream.get("nb_frames")
        if nb_frames and nb_frames.isdigit():
            return int(nb_frames)

    return None


def load_source_csv(csv_path: Path) -> tuple[list[str], dict[datetime, dict[str, str]]]:
    print(f"Loading source CSV: {csv_path}")

    with csv_path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames:
            raise ValueError(f"CSV has no header: {csv_path}")

        if "Time" not in reader.fieldnames:
            raise ValueError(f"CSV must contain a 'Time' column: {csv_path}")

        rows_by_time: dict[datetime, dict[str, str]] = {}

        for row in reader:
            if not row.get("Time"):
                continue

            timestamp = parse_csv_time(row["Time"])
            rows_by_time[timestamp] = row

        print(f"Loaded {len(rows_by_time)} timestamped rows from CSV")

        return reader.fieldnames, rows_by_time


def find_row_for_time(
    rows_by_time: dict[datetime, dict[str, str]],
    timestamp: datetime,
    tolerance_seconds: float,
) -> dict[str, str] | None:
    exact = rows_by_time.get(timestamp)
    if exact:
        return exact

    if tolerance_seconds <= 0:
        return None

    best_row = None
    best_delta = None

    for row_time, row in rows_by_time.items():
        delta = abs((row_time - timestamp).total_seconds())

        if delta <= tolerance_seconds and (best_delta is None or delta < best_delta):
            best_delta = delta
            best_row = row

    return best_row


def collect_insv_files(input_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in input_dir.rglob("*")
        if path.is_file()
        and path.suffix.lower() == ".insv"
        and path.name.upper().startswith("VID")
    )


def build_output_rows(
    input_dir: Path,
    rows_by_time: dict[datetime, dict[str, str]],
    frame_interval_seconds: float,
    tolerance_seconds: float,
    max_frames: int | None,
    max_clips: int | None,
) -> list[dict[str, str]]:
    output_rows = []

    print(f"Searching for .insv clips under: {input_dir}")
    clip_paths = collect_insv_files(input_dir)
    print(f"Found {len(clip_paths)} matching .insv clip(s)")

    if max_clips is not None:
        clip_paths = clip_paths[:max_clips]
        print(f"Debug clip limit enabled: processing first {len(clip_paths)} clip(s)")

    total_clips = len(clip_paths)

    for clip_number, clip_path in enumerate(clip_paths, start=1):
        print(f"[{clip_number}/{total_clips}] Processing {clip_path.name}")

        clip_start = get_clip_start(clip_path)

        if not clip_start:
            print("  Warning: could not determine clip start time; skipping")
            continue

        print(f"  Clip start: {clip_start}")

        frame_count = get_video_frame_count(clip_path)

        if frame_count is None:
            duration = get_clip_duration_seconds(clip_path)
            if duration is not None:
                frame_count = int(duration // frame_interval_seconds) + 1
                print(f"  Estimated frame count from duration: {frame_count}")

        if frame_count is None:
            if max_frames is None:
                print(
                    "  Warning: could not determine frame count; "
                    "use --max-frames or install ffprobe"
                )
                continue

            frame_count = max_frames
            print(f"  Using fallback frame count from --max-frames: {frame_count}")
        else:
            print(f"  Frame count: {frame_count}")

        if max_frames is not None:
            original_frame_count = frame_count
            frame_count = min(frame_count, max_frames)

            if frame_count != original_frame_count:
                print(f"  Debug frame limit enabled: processing first {frame_count} frame(s)")

        matched_rows_before = len(output_rows)

        for frame_index in range(frame_count):
            time_into_clip_seconds = frame_index * frame_interval_seconds
            frame_timestamp = clip_start + timedelta(seconds=time_into_clip_seconds)

            rounded_timestamp = frame_timestamp.replace(microsecond=0)

            source_row = find_row_for_time(
                rows_by_time=rows_by_time,
                timestamp=rounded_timestamp,
                tolerance_seconds=tolerance_seconds,
            )

            if not source_row:
                continue

            output_row = dict(source_row)
            output_row["clip_name"] = clip_path.name
            output_row["time_into_clip"] = format_time_into_clip(time_into_clip_seconds)
            output_rows.append(output_row)

        matched_rows_for_clip = len(output_rows) - matched_rows_before
        print(f"  Matched CSV rows: {matched_rows_for_clip}")

    print(f"Finished processing clips. Total matched output rows: {len(output_rows)}")

    return output_rows


def write_output_csv(
    output_path: Path,
    source_fieldnames: list[str],
    output_rows: list[dict[str, str]],
) -> None:
    fieldnames = source_fieldnames + ["clip_name", "time_into_clip"]

    print(f"Writing output CSV: {output_path}")

    with output_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Extract rows from a YDVR-style CSV for every frame in Insta360 .insv "
            "time-lapse clips."
        )
    )

    parser.add_argument(
        "input_dir",
        type=Path,
        help="Directory containing .insv files",
    )

    parser.add_argument(
        "--csv",
        dest="csv_path",
        type=Path,
        required=True,
        help="Path to the source CSV file",
    )

    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Path to write the generated CSV file",
    )

    parser.add_argument(
        "--frame-interval",
        type=float,
        default=2.0,
        help="Seconds between time-lapse frames. Default: 2",
    )

    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.5,
        help="Allowed timestamp matching tolerance in seconds. Default: 0.5",
    )

    parser.add_argument(
        "--max-frames",
        type=int,
        default=None,
        help=(
            "Maximum frames to process per clip. Also used as fallback when frame "
            "count cannot be detected."
        ),
    )

    parser.add_argument(
        "--max-clips",
        type=int,
        default=None,
        help="Maximum number of .insv clips to process. Useful for debugging.",
    )

    args = parser.parse_args()

    input_dir = args.input_dir.expanduser().resolve()
    csv_path = args.csv_path.expanduser().resolve()
    output_path = args.output.expanduser().resolve()

    if not input_dir.is_dir():
        raise ValueError(f"Input directory does not exist: {input_dir}")

    if not csv_path.is_file():
        raise ValueError(f"CSV file does not exist: {csv_path}")

    source_fieldnames, rows_by_time = load_source_csv(csv_path)

    output_rows = build_output_rows(
        input_dir=input_dir,
        rows_by_time=rows_by_time,
        frame_interval_seconds=args.frame_interval,
        tolerance_seconds=args.tolerance,
        max_frames=args.max_frames,
        max_clips=args.max_clips,
    )

    write_output_csv(
        output_path=output_path,
        source_fieldnames=source_fieldnames,
        output_rows=output_rows,
    )

    print(f"Wrote {len(output_rows)} rows to {output_path}")


if __name__ == "__main__":
    main()
