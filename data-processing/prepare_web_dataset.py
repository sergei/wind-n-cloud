#!/usr/bin/env python3

import argparse
import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CSV_TIME_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
]


def parse_time(value: str) -> datetime:
    value = value.strip()

    if value.endswith("Z"):
        value = value[:-1] + "+0000"

    if re.search(r"[+-]\d{2}:\d{2}$", value):
        value = value[:-3] + value[-2:]

    for fmt in CSV_TIME_FORMATS:
        try:
            parsed = datetime.strptime(value, fmt)

            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)

            return parsed
        except ValueError:
            pass

    raise ValueError(f"Unsupported timestamp format: {value!r}")


def format_iso_utc(value: datetime) -> str:
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def to_time_ms(value: datetime) -> int:
    return int(value.replace(tzinfo=timezone.utc).timestamp() * 1000)


def parse_optional_float(value: str | None) -> float | None:
    if value is None:
        return None

    value = value.strip()

    if not value:
        return None

    try:
        return float(value)
    except ValueError:
        return None


def parse_time_into_clip_seconds(value: str | None) -> float | None:
    if value is None:
        return None

    value = value.strip()

    if not value:
        return None

    parts = value.split(":")

    try:
        if len(parts) == 3:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = float(parts[2])
            return hours * 3600 + minutes * 60 + seconds

        if len(parts) == 2:
            minutes = int(parts[0])
            seconds = float(parts[1])
            return minutes * 60 + seconds

        return float(value)
    except ValueError:
        return None


def mp4_name_for_clip(clip_name: str) -> str:
    clip_path = Path(clip_name)
    return f"{clip_path.stem}.mp4"


def public_url_join(prefix: str, filename: str) -> str:
    return f"{prefix.rstrip('/')}/{filename}"


def read_frame_csv(csv_path: Path) -> list[dict[str, Any]]:
    print(f"Reading frame-matched CSV: {csv_path}")

    rows: list[dict[str, Any]] = []

    with csv_path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames:
            raise ValueError(f"CSV file has no header: {csv_path}")

        required_columns = ["Time", "TWD", "TWS", "clip_name", "time_into_clip"]
        missing_columns = [
            column for column in required_columns if column not in reader.fieldnames
        ]

        if missing_columns:
            raise ValueError(
                "CSV is missing required column(s): "
                + ", ".join(missing_columns)
                + ". Make sure this is the CSV produced by extract_insv_frame_csv.py."
            )

        for row_number, row in enumerate(reader, start=2):
            raw_time = row.get("Time")
            clip_name = row.get("clip_name")
            time_into_clip = row.get("time_into_clip")

            if not raw_time or not clip_name or not time_into_clip:
                print(f"Warning: skipping incomplete row {row_number}")
                continue

            sample_time = parse_time(raw_time)
            time_into_clip_seconds = parse_time_into_clip_seconds(time_into_clip)

            if time_into_clip_seconds is None:
                print(
                    f"Warning: could not parse time_into_clip={time_into_clip!r} "
                    f"on row {row_number}; skipping"
                )
                continue

            rows.append(
                {
                    "time": format_iso_utc(sample_time),
                    "timeMs": to_time_ms(sample_time),
                    "clipName": clip_name,
                    "mp4Name": mp4_name_for_clip(clip_name),
                    "timeIntoClip": time_into_clip,
                    "timeIntoClipSeconds": time_into_clip_seconds,
                    "twd": parse_optional_float(row.get("TWD")),
                    "tws": parse_optional_float(row.get("TWS")),
                    "heading": parse_optional_float(row.get("Heading")),
                    "sog": parse_optional_float(row.get("SOG")),
                    "cog": parse_optional_float(row.get("COG")),
                    "awa": parse_optional_float(row.get("AWA")),
                    "aws": parse_optional_float(row.get("AWS")),
                    "twa": parse_optional_float(row.get("TWA")),
                }
            )

    rows.sort(key=lambda item: item["timeMs"])

    print(f"Loaded {len(rows)} frame-matched row(s)")

    return rows


def find_mp4_file(mp4_dir: Path, mp4_name: str) -> Path | None:
    direct_path = mp4_dir / mp4_name
    if direct_path.is_file():
        return direct_path

    matches = [
        path
        for path in mp4_dir.rglob("*")
        if path.is_file() and path.name == mp4_name
    ]

    if not matches:
        return None

    return sorted(matches)[0]


def build_video_segments(
    rows: list[dict[str, Any]],
    mp4_dir: Path,
    public_video_prefix: str,
    fail_on_missing_video: bool,
) -> list[dict[str, Any]]:
    print(f"Building video segment metadata from MP4 directory: {mp4_dir}")

    if not mp4_dir.is_dir():
        raise ValueError(f"MP4 directory does not exist: {mp4_dir}")

    by_clip: dict[str, list[dict[str, Any]]] = {}

    for row in rows:
        by_clip.setdefault(row["clipName"], []).append(row)

    segments: list[dict[str, Any]] = []

    for index, clip_name in enumerate(sorted(by_clip), start=1):
        clip_rows = sorted(by_clip[clip_name], key=lambda item: item["timeMs"])

        first_row = clip_rows[0]
        last_row = clip_rows[-1]

        mp4_name = first_row["mp4Name"]
        mp4_path = find_mp4_file(mp4_dir, mp4_name)

        if mp4_path is None:
            message = (
                f"MP4 file not found for {clip_name}: expected {mp4_name} "
                f"under {mp4_dir}"
            )

            if fail_on_missing_video:
                raise ValueError(message)

            print(f"Warning: {message}; skipping segment")
            continue

        start_time_ms = first_row["timeMs"] - int(
            first_row["timeIntoClipSeconds"] * 1000
        )

        last_sample_time_ms = last_row["timeMs"]
        last_offset_ms = int(last_row["timeIntoClipSeconds"] * 1000)

        # Estimate segment end using available frame-matched data.
        # This is sufficient for timeline mapping because each row corresponds to a frame.
        estimated_duration_ms = last_offset_ms + max(
            0,
            last_sample_time_ms - (start_time_ms + last_offset_ms),
        )

        end_time_ms = max(last_sample_time_ms, start_time_ms + estimated_duration_ms)

        start_time = datetime.fromtimestamp(
            start_time_ms / 1000,
            tz=timezone.utc,
        ).replace(tzinfo=None)

        end_time = datetime.fromtimestamp(
            end_time_ms / 1000,
            tz=timezone.utc,
        ).replace(tzinfo=None)

        segment_id = f"segment-{index:06d}"

        segments.append(
            {
                "id": segment_id,
                "startTime": format_iso_utc(start_time),
                "endTime": format_iso_utc(end_time),
                "startTimeMs": start_time_ms,
                "endTimeMs": end_time_ms,
                "videoUrl": public_url_join(public_video_prefix, mp4_name),
            }
        )

    segments.sort(key=lambda item: item["startTimeMs"])

    print(f"Prepared {len(segments)} video segment(s)")

    return segments


def build_wind_samples(rows: list[dict[str, Any]]) -> dict[str, Any]:
    print("Building wind-samples.json data")

    return {
        "schemaVersion": 1,
        "format": "columnar",
        "count": len(rows),
        "time": [row["time"] for row in rows],
        "timeMs": [row["timeMs"] for row in rows],
        "twd": [row["twd"] for row in rows],
        "tws": [row["tws"] for row in rows],
        "heading": [row["heading"] for row in rows],
        "sog": [row["sog"] for row in rows],
        "cog": [row["cog"] for row in rows],
        "awa": [row["awa"] for row in rows],
        "aws": [row["aws"] for row in rows],
        "twa": [row["twa"] for row in rows],
    }


def get_time_range_ms(
    rows: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> tuple[int, int]:
    timestamps: list[int] = []

    if rows:
        timestamps.append(rows[0]["timeMs"])
        timestamps.append(rows[-1]["timeMs"])

    for segment in segments:
        timestamps.append(segment["startTimeMs"])
        timestamps.append(segment["endTimeMs"])

    if not timestamps:
        raise ValueError("Cannot determine dataset time range")

    return min(timestamps), max(timestamps)


def build_manifest(
    race_id: str,
    display_name: str,
    rows: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    wind_samples_url: str,
    default_history_minutes: int,
) -> dict[str, Any]:
    print("Building manifest.json")

    start_time_ms, end_time_ms = get_time_range_ms(rows, segments)

    start_time = datetime.fromtimestamp(
        start_time_ms / 1000,
        tz=timezone.utc,
    ).replace(tzinfo=None)

    end_time = datetime.fromtimestamp(
        end_time_ms / 1000,
        tz=timezone.utc,
    ).replace(tzinfo=None)

    return {
        "schemaVersion": 1,
        "raceId": race_id,
        "displayName": display_name,
        "timezone": "UTC",
        "startTime": format_iso_utc(start_time),
        "endTime": format_iso_utc(end_time),
        "startTimeMs": start_time_ms,
        "endTimeMs": end_time_ms,
        "defaults": {
            "windHistoryDurationMinutes": default_history_minutes,
            "availableWindHistoryDurationsMinutes": [5, 15, 30, 60, 120],
        },
        "data": {
            "windSamplesUrl": wind_samples_url,
            "windSampleCount": len(rows),
            "fields": [
                "time",
                "timeMs",
                "twd",
                "tws",
                "heading",
                "sog",
                "cog",
                "awa",
                "aws",
                "twa",
            ],
        },
        "videoSegments": segments,
    }


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2)
        file.write("\n")

    print(f"Wrote {path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare JSON files for the wind-n-cloud web app from the CSV produced "
            "by extract_insv_frame_csv.py."
        )
    )

    parser.add_argument(
        "--csv",
        dest="csv_path",
        type=Path,
        required=True,
        help="Path to the frame-matched CSV produced by extract_insv_frame_csv.py",
    )

    parser.add_argument(
        "--mp4-dir",
        type=Path,
        required=True,
        help=(
            "Directory containing MP4 files. Each MP4 must have the same base name "
            "as the corresponding .insv file in the clip_name column."
        ),
    )

    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where manifest.json and data/wind-samples.json will be written",
    )

    parser.add_argument(
        "--race-id",
        default="pacific-cup",
        help="Stable race/dataset identifier. Default: pacific-cup",
    )

    parser.add_argument(
        "--display-name",
        default="Pacific Cup",
        help="Human-readable dataset name. Default: Pacific Cup",
    )

    parser.add_argument(
        "--wind-samples-url",
        default="data/wind-samples.json",
        help=(
            "URL written into manifest for wind samples. "
            "Can be relative to manifest. Default: data/wind-samples.json"
        ),
    )

    parser.add_argument(
        "--public-video-prefix",
        default="video",
        help=(
            "URL prefix written into manifest for MP4 video files. "
            "Use an S3/CloudFront prefix later if desired. Default: video"
        ),
    )

    parser.add_argument(
        "--default-history-minutes",
        type=int,
        default=60,
        help="Default vertical wind history duration in minutes. Default: 60",
    )

    parser.add_argument(
        "--allow-missing-video",
        action="store_true",
        help="Skip missing MP4 files instead of failing",
    )

    args = parser.parse_args()

    csv_path = args.csv_path.expanduser().resolve()
    mp4_dir = args.mp4_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()

    if not csv_path.is_file():
        raise ValueError(f"CSV file does not exist: {csv_path}")

    rows = read_frame_csv(csv_path)

    if not rows:
        raise ValueError("No frame-matched rows were loaded from the CSV")

    segments = build_video_segments(
        rows=rows,
        mp4_dir=mp4_dir,
        public_video_prefix=args.public_video_prefix,
        fail_on_missing_video=not args.allow_missing_video,
    )

    if not segments:
        raise ValueError("No video segments were prepared")

    wind_samples = build_wind_samples(rows)

    manifest = build_manifest(
        race_id=args.race_id,
        display_name=args.display_name,
        rows=rows,
        segments=segments,
        wind_samples_url=args.wind_samples_url,
        default_history_minutes=args.default_history_minutes,
    )

    write_json(output_dir / "data" / "wind-samples.json", wind_samples)
    write_json(output_dir / "manifest.json", manifest)

    print("Done")


if __name__ == "__main__":
    main()
