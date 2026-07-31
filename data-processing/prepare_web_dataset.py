#!/usr/bin/env python3

import argparse
import csv
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


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


def public_url_join(prefix: str | None, filename: str) -> str:
    if not prefix:
        return filename

    return f"{prefix.rstrip('/')}/{filename}"


def derive_s3_prefix(asset_base_url: str | None, explicit_prefix: str | None) -> str:
    if explicit_prefix:
        return explicit_prefix.strip("/")

    if not asset_base_url:
        return ""

    return urlparse(asset_base_url).path.strip("/")


def read_frame_csv(csv_path: Path) -> list[dict[str, Any]]:
    print(f"Reading frame-matched CSV: {csv_path}")

    rows: list[dict[str, Any]] = []

    with csv_path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames:
            raise ValueError(f"CSV file has no header: {csv_path}")

        required_columns = ["Time", "TWD(med)", "TWS(med)", "clip_name", "clip_timecode"]
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
            clip_timecode = row.get("clip_timecode")

            if not raw_time or not clip_name or clip_timecode is None or clip_timecode == "":
                print(f"Warning: skipping incomplete row {row_number}")
                continue

            sample_time = parse_time(raw_time)
            time_into_clip_seconds = parse_optional_float(clip_timecode)

            if time_into_clip_seconds is None:
                print(
                    f"Warning: could not parse clip_timecode={clip_timecode!r} "
                    f"on row {row_number}; skipping"
                )
                continue

            rows.append(
                {
                    "time": format_iso_utc(sample_time),
                    "timeMs": to_time_ms(sample_time),
                    "clipName": clip_name,
                    "mp4Name": mp4_name_for_clip(clip_name),
                    "timeIntoClip": clip_timecode,
                    "timeIntoClipSeconds": time_into_clip_seconds,
                    "twd": parse_optional_float(row.get("TWD(med)")),
                    "tws": parse_optional_float(row.get("TWS(med)")),
                    "heading": parse_optional_float(row.get("Heading")),
                    "sog": parse_optional_float(row.get("SOG")),
                    "cog": parse_optional_float(row.get("COG")),
                    "awa": parse_optional_float(row.get("AWA")),
                    "aws": parse_optional_float(row.get("AWS")),
                    "twa": parse_optional_float(row.get("TWA(med)")),
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


def run_ffprobe(path: Path) -> dict[str, Any] | None:
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
        print("Warning: ffprobe not found; MP4 duration cannot be detected")
        return None
    except subprocess.CalledProcessError:
        return None

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def get_mp4_duration_seconds(path: Path) -> float | None:
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


def infer_frame_interval_seconds(clip_rows: list[dict[str, Any]]) -> float:
    if len(clip_rows) < 2:
        return 0.0

    intervals: list[float] = []

    for previous, current in zip(clip_rows, clip_rows[1:]):
        interval = current["timeIntoClipSeconds"] - previous["timeIntoClipSeconds"]
        if interval > 0:
            intervals.append(interval)

    if not intervals:
        return 0.0

    intervals.sort()
    middle = len(intervals) // 2

    if len(intervals) % 2 == 1:
        return intervals[middle]

    return (intervals[middle - 1] + intervals[middle]) / 2


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

        video_duration_seconds = get_mp4_duration_seconds(mp4_path)

        if video_duration_seconds is None:
            message = f"Could not determine MP4 duration for {mp4_path}"

            if fail_on_missing_video:
                raise ValueError(message)

            print(f"Warning: {message}; skipping segment")
            continue

        start_time_ms = first_row["timeMs"] - int(
            first_row["timeIntoClipSeconds"] * 1000
        )

        frame_interval_seconds = infer_frame_interval_seconds(clip_rows)

        # This is the real-world duration represented by the time-lapse frames.
        # Calculate from actual timestamps (timeMs), not clip positions.
        # The last row is the timestamp of the last frame. Add one frame interval
        # so the segment covers the visual duration of that final frame too.
        race_duration_seconds = (last_row["timeMs"] - first_row["timeMs"]) / 1000 + frame_interval_seconds

        if race_duration_seconds <= 0:
            race_duration_seconds = max(
                0.0,
                (last_row["timeMs"] - start_time_ms) / 1000,
            )

        end_time_ms = start_time_ms + int(race_duration_seconds * 1000)

        race_seconds_per_video_second = (
            race_duration_seconds / video_duration_seconds
            if video_duration_seconds > 0
            else 1.0
        )

        start_time = datetime.fromtimestamp(
            start_time_ms / 1000,
            tz=timezone.utc,
        ).replace(tzinfo=None)

        end_time = datetime.fromtimestamp(
            end_time_ms / 1000,
            tz=timezone.utc,
        ).replace(tzinfo=None)

        segment_id = f"segment-{index:06d}"

        print(
            f"  {segment_id}: {mp4_name}, "
            f"frames {len(clip_rows)}, "
            f"frame interval {frame_interval_seconds:.3f}s, "
            f"race duration {race_duration_seconds:.3f}s, "
            f"video duration {video_duration_seconds:.3f}s, "
            f"scale {race_seconds_per_video_second:.6f} race-sec/video-sec"
        )

        segments.append(
            {
                "id": segment_id,
                "startTime": format_iso_utc(start_time),
                "endTime": format_iso_utc(end_time),
                "startTimeMs": start_time_ms,
                "endTimeMs": end_time_ms,
                "frameCount": len(clip_rows),
                "frameIntervalSeconds": round(frame_interval_seconds, 6),
                "raceDurationSeconds": round(race_duration_seconds, 6),
                "videoDurationSeconds": round(video_duration_seconds, 6),
                "raceSecondsPerVideoSecond": round(
                    race_seconds_per_video_second,
                    9,
                ),
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
        "schemaVersion": 2,
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


def upload_json_outputs(
    output_dir: Path,
    bucket_name: str,
    aws_profile: str | None,
    aws_region: str,
    s3_prefix: str,
    cloudfront_distribution_id: str | None,
    invalidate_cloudfront: bool,
) -> None:
    try:
        import boto3
    except ModuleNotFoundError as exc:
        raise RuntimeError("boto3 is required when --upload-to-s3 is used") from exc

    session_kwargs: dict[str, str] = {"region_name": aws_region}
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile

    session = boto3.Session(**session_kwargs)
    s3_client = session.client("s3")

    uploaded_keys: list[str] = []

    for file_path in sorted(output_dir.rglob("*.json")):
        relative_key = file_path.relative_to(output_dir).as_posix()
        key = public_url_join(s3_prefix or None, relative_key)
        cache_control = "no-cache,no-store,must-revalidate"
        if relative_key != "manifest.json":
            cache_control = "max-age=60"

        s3_client.put_object(
            Bucket=bucket_name,
            Key=key,
            Body=file_path.read_bytes(),
            ContentType="application/json",
            CacheControl=cache_control,
        )
        uploaded_keys.append(key)
        print(f"Uploaded s3://{bucket_name}/{key}")

    if invalidate_cloudfront and cloudfront_distribution_id:
        s3_client_cf = session.client("cloudfront")
        paths = [f"/{key}" for key in uploaded_keys]
        s3_client_cf.create_invalidation(
            DistributionId=cloudfront_distribution_id,
            InvalidationBatch={
                "Paths": {"Quantity": len(paths), "Items": paths},
                "CallerReference": datetime.now(timezone.utc).isoformat(),
            },
        )
        print(f"Invalidated CloudFront distribution {cloudfront_distribution_id}")
    elif invalidate_cloudfront:
        raise ValueError("--cloudfront-distribution-id is required when --invalidate-cloudfront is set")


def main() -> None:
    parser = argparse.ArgumentParser(
        fromfile_prefix_chars="@",
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
        default=None,
        help=(
            "URL written into manifest for wind samples. "
            "Can be relative to manifest or absolute. "
            "If omitted, it defaults to data/wind-samples.json or "
            "<asset-base-url>/data/wind-samples.json when --asset-base-url is set."
        ),
    )

    parser.add_argument(
        "--public-video-prefix",
        default=None,
        help=(
            "URL prefix written into manifest for MP4 video files. "
            "If omitted, it defaults to video or <asset-base-url>/video when "
            "--asset-base-url is set."
        ),
    )

    parser.add_argument(
        "--asset-base-url",
        default=None,
        help=(
            "Optional base URL for both data and video assets. "
            "When set, default manifest URLs become <asset-base-url>/data/wind-samples.json "
            "and <asset-base-url>/video."
        ),
    )

    parser.add_argument(
        "--upload-to-s3",
        action="store_true",
        help="Upload generated JSON files to S3 after writing them locally.",
    )

    parser.add_argument(
        "--aws-profile",
        default=None,
        help="AWS profile to use for S3 upload when --upload-to-s3 is enabled.",
    )

    parser.add_argument(
        "--aws-region",
        default=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2",
        help="AWS region to use for S3 upload. Default: env AWS_REGION/AWS_DEFAULT_REGION or us-west-2",
    )

    parser.add_argument(
        "--s3-bucket",
        default=None,
        help="S3 bucket name used when --upload-to-s3 is enabled.",
    )

    parser.add_argument(
        "--s3-prefix",
        default=None,
        help="Optional S3 prefix for uploaded JSON files.",
    )

    parser.add_argument(
        "--cloudfront-distribution-id",
        default=None,
        help="CloudFront distribution ID to invalidate after upload.",
    )

    parser.add_argument(
        "--invalidate-cloudfront",
        action="store_true",
        help="Invalidate CloudFront after uploading JSON files.",
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
    asset_base_url = args.asset_base_url.rstrip("/") if args.asset_base_url else None
    s3_prefix = derive_s3_prefix(asset_base_url, args.s3_prefix)
    wind_samples_url = (
        args.wind_samples_url
        if args.wind_samples_url
        else public_url_join(asset_base_url, "data/wind-samples.json")
        if asset_base_url
        else "data/wind-samples.json"
    )
    public_video_prefix = (
        args.public_video_prefix
        if args.public_video_prefix
        else public_url_join(asset_base_url, "video")
        if asset_base_url
        else "video"
    )

    if not csv_path.is_file():
        raise ValueError(f"CSV file does not exist: {csv_path}")

    rows = read_frame_csv(csv_path)

    if not rows:
        raise ValueError("No frame-matched rows were loaded from the CSV")

    segments = build_video_segments(
        rows=rows,
        mp4_dir=mp4_dir,
        public_video_prefix=public_video_prefix,
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
        wind_samples_url=wind_samples_url,
        default_history_minutes=args.default_history_minutes,
    )

    write_json(output_dir / "data" / "wind-samples.json", wind_samples)
    write_json(output_dir / "manifest.json", manifest)

    if args.upload_to_s3:
        if not args.s3_bucket:
            raise ValueError("--s3-bucket is required when --upload-to-s3 is set")

        upload_json_outputs(
            output_dir=output_dir,
            bucket_name=args.s3_bucket,
            aws_profile=args.aws_profile,
            aws_region=args.aws_region,
            s3_prefix=s3_prefix,
            cloudfront_distribution_id=args.cloudfront_distribution_id,
            invalidate_cloudfront=args.invalidate_cloudfront,
        )

    print("Done")


if __name__ == "__main__":
    main()
