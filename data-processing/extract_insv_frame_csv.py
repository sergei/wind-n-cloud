#!/usr/bin/env python3

import argparse
import csv
import json
import logging
import re
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)


CSV_TIME_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
]


def parse_csv_time(value: str, input_timezone: str = "UTC") -> datetime:
    value = value.strip()

    if value.endswith("Z"):
        value = value[:-1] + "+0000"

    if re.search(r"[+-]\d{2}:\d{2}$", value):
        value = value[:-3] + value[-2:]

    for fmt in CSV_TIME_FORMATS:
        try:
            dt = datetime.strptime(value, fmt)
            
            # If the parsed datetime already has timezone info, convert to UTC
            if dt.tzinfo is not None:
                return dt.astimezone(timezone.utc).replace(tzinfo=None)
            
            # Otherwise, treat as local time in the specified timezone and convert to UTC
            tz = ZoneInfo(input_timezone)
            dt_local = dt.replace(tzinfo=tz)
            dt_utc = dt_local.astimezone(timezone.utc)
            return dt_utc.replace(tzinfo=None)
        except ValueError:
            pass

    raise ValueError(f"Unsupported CSV time format: {value!r}")


def load_time_adjustments(csv_path: Path, input_timezone: str = "UTC") -> dict[str, float]:
    """Load per-clip time adjustments from CSV file.
    
    Reads a CSV file with columns: Clip, Instruments, Camera
    Calculates adjustment as: (Instruments_time - Camera_time) in seconds
    
    Note: Clip names are normalized by removing file extension for robust matching
    (CSV might have .mp4 while actual files are .insv)
    
    Args:
        csv_path: Path to adjustment CSV file
        input_timezone: Timezone for parsing times in CSV
    
    Returns:
        Dictionary mapping clip_name (without extension) to adjustment_seconds (float)
        
    Raises:
        ValueError: If CSV has missing columns or invalid time formats
    """
    logging.info(f"Loading time adjustments from: {csv_path}")
    
    adjustments = {}
    
    with csv_path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        
        if not reader.fieldnames:
            raise ValueError(f"Time adjustment CSV has no header: {csv_path}")
        
        # Normalize column names by stripping whitespace
        normalized_fieldnames = [name.strip() for name in (reader.fieldnames or [])]
        
        required_cols = {"Clip", "Instruments", "Camera"}
        missing = required_cols - set(normalized_fieldnames)
        if missing:
            raise ValueError(
                f"Time adjustment CSV missing required columns {missing}. "
                f"Found columns: {', '.join(normalized_fieldnames)}"
            )
        
        for row_num, row in enumerate(reader, start=2):
            # Normalize row keys to match normalized fieldnames
            normalized_row = {k.strip(): v for k, v in row.items()}
            
            clip_name = normalized_row.get("Clip", "").strip()
            if not clip_name:
                logging.warning(f"  Row {row_num}: skipping empty Clip name")
                continue
            
            # Strip extension from clip name for robust matching
            # (CSV might have .mp4 while files are .insv, or vice versa)
            clip_name_normalized = Path(clip_name).stem
            
            try:
                instruments_time = parse_csv_time(normalized_row["Instruments"], input_timezone=input_timezone)
                camera_time = parse_csv_time(normalized_row["Camera"], input_timezone=input_timezone)
                
                adjustment_seconds = (instruments_time - camera_time).total_seconds()
                adjustments[clip_name_normalized] = adjustment_seconds
                
                logging.info(
                    f"  {clip_name}: Instruments={instruments_time}, Camera={camera_time}, "
                    f"adjustment={adjustment_seconds:.2f}s"
                )
            except ValueError as e:
                logging.warning(f"  Row {row_num} ({clip_name}): {e}")
                continue
    
    logging.info(f"  Loaded adjustments for {len(adjustments)} clip(s)")
    return adjustments


def get_clip_adjustment(
    clip_name: str,
    adjustment_dict: dict[str, float] | None,
    previous_adjustment: float | None,
    first_adjustment: float | None,
) -> float:
    """Get time adjustment for a clip with fallback logic.
    
    Fallback chain:
    1. Use adjustment for this clip if available
    2. Use previous clip's adjustment if available
    3. Use first available adjustment
    4. Default to 0 (no adjustment)
    
    Clip names are normalized by removing extension for robust matching.
    
    Args:
        clip_name: Name of the clip file (e.g., "VID_20260712_105651_00_009.insv")
        adjustment_dict: Dictionary of clip_name_without_ext -> adjustment_seconds (or None if no CSV)
        previous_adjustment: Adjustment from previous clip (or None)
        first_adjustment: First available adjustment (or None)
    
    Returns:
        Adjustment in seconds to apply to this clip
    """
    if adjustment_dict is None:
        return 0.0
    
    # Normalize clip name by removing extension for lookup
    clip_name_normalized = Path(clip_name).stem
    
    if clip_name_normalized in adjustment_dict:
        adjustment = adjustment_dict[clip_name_normalized]
        logging.info(f"  Using adjustment from CSV for {clip_name}: {adjustment:.2f}s")
        return adjustment
    
    if previous_adjustment is not None:
        logging.info(
            f"  No CSV entry for {clip_name}; using previous clip adjustment: {previous_adjustment:.2f}s"
        )
        return previous_adjustment
    
    if first_adjustment is not None:
        logging.info(
            f"  No CSV entry for {clip_name}; using first available adjustment: {first_adjustment:.2f}s"
        )
        return first_adjustment
    
    logging.info(f"  No adjustment found for {clip_name}; using default: 0.0s")
    return 0.0


def format_time_into_clip(seconds: float) -> str:
    whole_seconds = int(seconds)
    hours = whole_seconds // 3600
    minutes = (whole_seconds % 3600) // 60
    secs = whole_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def seconds_to_timecode(seconds: float) -> str:
    """Convert floating point seconds to HH:MM:SS.mmm format."""
    whole_seconds = int(seconds)
    hours = whole_seconds // 3600
    minutes = (whole_seconds % 3600) // 60
    secs = whole_seconds % 60
    millis = int((seconds - whole_seconds) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def round_to_nearest_interval(dt: datetime, interval_seconds: float) -> datetime:
    """Round datetime to nearest frame interval.
    
    Args:
        dt: datetime to round
        interval_seconds: frame interval in seconds
    
    Returns:
        datetime rounded to nearest interval
    """
    if interval_seconds <= 0:
        return dt
    
    timestamp = dt.timestamp()
    rounded_timestamp = round(timestamp / interval_seconds) * interval_seconds
    return datetime.fromtimestamp(rounded_timestamp)


def get_video_metadata(path: Path, timeout_seconds: int = 30) -> dict | None:
    """Extract video metadata (fps, frame count, start time) from ffprobe.
    
    Uses -show_format -show_streams for fast metadata extraction (no frame iteration).
    
    Returns dict with 'fps' (float), 'frame_count' (int), 'start_time' (float).
    Returns None if extraction fails, falls back to estimated timing.
    """
    logging.debug(f"  Extracting video metadata from: {path.name}")
    
    try:
        # Create temporary file for ffprobe output
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as tmp:
            tmp_path = Path(tmp.name)
        
        try:
            start_time = time.time()
            
            # Build the ffprobe command - fast metadata only (no frame iteration)
            ffprobe_cmd = [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-select_streams",
                "v:0",
                str(path),
            ]
            
            # Log the command for manual debugging
            cmd_str = ' '.join(f'"{arg}"' if ' ' in arg else arg for arg in ffprobe_cmd)
            logging.debug(f"    ffprobe command: {cmd_str}")
            
            # Run ffprobe with output redirected to file
            with open(tmp_path, 'w') as output_file:
                result = subprocess.run(
                    ffprobe_cmd,
                    stdout=output_file,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=timeout_seconds,
                    check=True,
                )
            
            elapsed = time.time() - start_time
            logging.debug(f"    ffprobe metadata extraction completed in {elapsed:.2f}s")
            
        except FileNotFoundError:
            logging.debug(f"    ffprobe not found; falling back to estimated timing")
            return None
        except subprocess.TimeoutExpired:
            logging.warning(f"    ffprobe timed out after {timeout_seconds}s; falling back to estimated timing")
            return None
        except subprocess.CalledProcessError as e:
            logging.debug(f"    ffprobe failed: {e.stderr}; falling back to estimated timing")
            return None
        
        # Read and parse JSON from file
        logging.debug(f"    Reading ffprobe output from file")
        try:
            with open(tmp_path, 'r') as f:
                data = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            logging.debug(f"    Failed to parse ffprobe output: {e}; falling back to estimated timing")
            return None
        
        # Extract metadata from streams
        for stream in data.get("streams", []):
            if stream.get("codec_type") != "video":
                continue
            
            # Extract frame rate as float
            fps_str = stream.get("r_frame_rate", "30/1")
            try:
                if "/" in fps_str:
                    num, den = fps_str.split("/")
                    fps = float(num) / float(den)
                else:
                    fps = float(fps_str)
            except (ValueError, ZeroDivisionError):
                logging.debug(f"    Could not parse fps from '{fps_str}'; falling back to estimated timing")
                return None
            
            # Extract frame count
            frame_count = stream.get("nb_frames")
            if frame_count:
                try:
                    frame_count = int(frame_count)
                except ValueError:
                    logging.debug(f"    Could not parse frame count from '{frame_count}'; falling back to estimated timing")
                    return None
            else:
                logging.debug(f"    Frame count not available in stream metadata; falling back to estimated timing")
                return None
            
            # Extract start time (optional, defaults to 0)
            format_info = data.get("format", {})
            start_time_val = float(format_info.get("start_time", 0))
            
            logging.debug(f"    Extracted metadata: fps={fps:.2f}, frames={frame_count}, start_time={start_time_val:.3f}s")
            return {
                "fps": fps,
                "frame_count": frame_count,
                "start_time": start_time_val,
            }
        
        logging.debug(f"    No video stream found in metadata; falling back to estimated timing")
        return None
        
    except Exception as e:
        logging.debug(f"    Unexpected error extracting metadata: {e}; falling back to estimated timing")
        return None
    finally:
        # Clean up temp file
        try:
            tmp_path.unlink()
        except:
            pass


def get_frame_time_seconds(frame_idx: int, fps: float, start_time: float = 0.0) -> float:
    """Get frame time in seconds without string conversion.
    
    Much faster than calculating and parsing timecode strings.
    Formula: time[n] = start_time + (n / fps)
    
    Args:
        frame_idx: Frame index (0-based)
        fps: Frames per second (float)
        start_time: Video start time in seconds (default 0.0)
    
    Returns time in seconds as a float.
    """
    return start_time + (frame_idx / fps)


def get_frame_times_seconds(path: Path, timeout_seconds: int = 30) -> list[float] | None:
    """Extract frame times (in seconds) from video using ffprobe.
    
    Uses metadata-based approach: extracts fps and frame count, then calculates times in seconds.
    This avoids string formatting entirely, doing that only at output time.
    
    Returns a list of frame times in seconds, one per frame.
    Returns None if ffprobe is unavailable or metadata extraction fails.
    """
    logging.debug(f"  Extracting frame times from: {path.name}")
    
    # Get video metadata (fast: ~40ms for 60-second video)
    metadata = get_video_metadata(path, timeout_seconds)
    
    if metadata is None:
        logging.debug(f"    Frame time extraction failed; will use estimated timing")
        return None
    
    # Calculate frame times in seconds (instant, no string allocation)
    frame_count = metadata["frame_count"]
    fps = metadata["fps"]
    start_time = metadata["start_time"]
    
    frame_times = [start_time + (i / fps) for i in range(frame_count)]
    
    logging.debug(f"    Successfully calculated {len(frame_times)} frame times")
    return frame_times if frame_times else None


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


def get_all_clip_metadata(path: Path) -> dict | None:
    """Extract all metadata from a clip in one ffprobe call.
    
    Consolidates multiple ffprobe calls into one for efficiency.
    
    Returns dict with keys:
    - clip_start (datetime or None)
    - frame_count (int or None)
    - duration_seconds (float or None)
    - fps (float or None)
    
    Returns None if ffprobe is unavailable.
    """
    logging.debug(f"  Getting all metadata from: {path.name}")
    
    data = run_ffprobe(path)
    if not data:
        logging.debug(f"    ffprobe failed; returning None")
        return None
    
    result = {
        "clip_start": None,
        "frame_count": None,
        "duration_seconds": None,
        "fps": None,
        "frame_times": None,
    }
    
    # Get clip start time
    format_tags = data.get("format", {}).get("tags", {})
    creation_time = format_tags.get("creation_time")
    parsed = parse_ffprobe_creation_time(creation_time)
    if parsed:
        result["clip_start"] = parsed
    
    if not result["clip_start"]:
        for stream in data.get("streams", []):
            stream_tags = stream.get("tags", {})
            creation_time = stream_tags.get("creation_time")
            parsed = parse_ffprobe_creation_time(creation_time)
            if parsed:
                result["clip_start"] = parsed
                break
    
    # Extract video stream metadata (frame count, duration, fps)
    for stream in data.get("streams", []):
        if stream.get("codec_type") != "video":
            continue
        
        # Frame count
        nb_frames = stream.get("nb_frames")
        if nb_frames and nb_frames.isdigit():
            result["frame_count"] = int(nb_frames)
        
        # Duration
        if not result["duration_seconds"]:
            duration = stream.get("duration")
            if duration:
                try:
                    result["duration_seconds"] = float(duration)
                except ValueError:
                    pass
        
        # FPS
        if not result["fps"]:
            fps_str = stream.get("r_frame_rate", "30/1")
            try:
                if "/" in fps_str:
                    num, den = fps_str.split("/")
                    result["fps"] = float(num) / float(den)
                else:
                    result["fps"] = float(fps_str)
            except (ValueError, ZeroDivisionError):
                pass
    
    # Get format-level duration if not found in streams
    if not result["duration_seconds"]:
        duration = data.get("format", {}).get("duration")
        if duration:
            try:
                result["duration_seconds"] = float(duration)
            except ValueError:
                pass
    
    # Don't pre-calculate frame times here - they depend on frame_interval which we don't know
    # We'll calculate them properly in build_output_rows() using frame_interval
    
    fps_str = f"{result['fps']:.1f}" if result['fps'] else 'N/A'
    logging.debug(f"    Metadata: start={result['clip_start']}, frames={result['frame_count']}, fps={fps_str}")
    
    return result


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


def load_source_csv(csv_path: Path, input_timezone: str = "UTC") -> tuple[list[str], list[tuple[datetime, dict[str, str]]]]:
    logging.info(f"Loading source CSV: {csv_path}")
    logging.info(f"  Input timezone: {input_timezone}")

    with csv_path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames:
            raise ValueError(f"CSV has no header: {csv_path}")

        if "Time" not in reader.fieldnames:
            raise ValueError(f"CSV must contain a 'Time' column: {csv_path}")

        logging.debug(f"  CSV columns: {', '.join(reader.fieldnames)}")

        rows_list: list[tuple[datetime, dict[str, str]]] = []

        for row in reader:
            if not row.get("Time"):
                continue

            timestamp = parse_csv_time(row["Time"], input_timezone=input_timezone)
            rows_list.append((timestamp, row))

        logging.info(f"  Loaded {len(rows_list)} timestamped rows from CSV")

        return reader.fieldnames, rows_list


def find_row_for_time(
    rows_list: list[tuple[datetime, dict[str, str]]],
    timestamp: datetime,
    tolerance_seconds: float,
    start_index: int = 0,
) -> tuple[dict[str, str] | None, int]:
    """Find a row for the given timestamp, searching forward from start_index.
    
    Args:
        rows_list: List of (timestamp, row) tuples, sorted by timestamp
        timestamp: Target timestamp to match
        tolerance_seconds: Allowed tolerance in seconds
        start_index: Index to start searching from (for forward scan)
    
    Returns:
        Tuple of (matched_row or None, next_start_index)
        next_start_index can be used as start_index for next call for efficient forward scan
    """
    if tolerance_seconds <= 0:
        # Exact match only
        for idx in range(start_index, len(rows_list)):
            row_time, row = rows_list[idx]
            if row_time == timestamp:
                return row, idx + 1
        return None, start_index
    
    best_row = None
    best_delta = None
    last_checked_idx = start_index - 1

    for idx in range(start_index, len(rows_list)):
        row_time, row = rows_list[idx]
        delta = abs((row_time - timestamp).total_seconds())

        if delta <= tolerance_seconds:
            if best_delta is None or delta < best_delta:
                best_delta = delta
                best_row = row
                last_checked_idx = idx
        elif best_row is not None:
            # We found a match and now delta is increasing, safe to stop
            break
        elif row_time > timestamp:
            # Row is after our target time and we haven't found a match:
            # All future rows will be even later, so stop scanning.
            # Don't advance last_checked_idx past this point to allow re-matching
            # entries after a gap when future frame times go beyond this row.
            break
        
        last_checked_idx = idx

    return best_row, last_checked_idx + 1


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
    csv_fieldnames: list[str],
    rows_list: list[tuple[datetime, dict[str, str]]],
    frame_interval_seconds: float,
    tolerance_seconds: float,
    max_frames: int | None,
    max_clips: int | None,
    adjust_start_time_seconds: float = 0.0,
    time_adjust_dict: dict[str, float] | None = None,
) -> list[dict[str, str]]:
    output_rows = []

    logging.info(f"Searching for .insv clips under: {input_dir}")
    clip_paths = collect_insv_files(input_dir)
    logging.info(f"Found {len(clip_paths)} matching .insv clip(s)")

    if max_clips is not None:
        clip_paths = clip_paths[:max_clips]
        logging.info(f"Debug clip limit enabled: processing first {len(clip_paths)} clip(s)")

    total_clips = len(clip_paths)
    
    # Track adjustments for fallback logic
    previous_adjustment = None
    first_adjustment = None
    if time_adjust_dict:
        # Find the first available adjustment for fallback
        for clip_name, adj in time_adjust_dict.items():
            first_adjustment = adj
            break

    for clip_number, clip_path in enumerate(clip_paths, start=1):
        logging.info(f"[{clip_number}/{total_clips}] Processing {clip_path.name}")

        # Get all metadata in one ffprobe call - this consolidates multiple calls into one
        metadata = get_all_clip_metadata(clip_path)
        
        clip_start = metadata.get("clip_start") if metadata else None
        if not clip_start:
            # Try to get from filename as fallback
            clip_start = get_clip_start_from_filename(clip_path)
        
        if not clip_start:
            logging.warning(f"  Warning: could not determine clip start time; skipping")
            continue

        logging.debug(f"  Clip start: {clip_start}")

        # Use metadata frame count if available
        frame_count = metadata.get("frame_count") if metadata else None

        if frame_count is None:
            duration = metadata.get("duration_seconds") if metadata else None
            if duration is not None:
                frame_count = int(duration // frame_interval_seconds) + 1
                logging.debug(f"  Estimated frame count from duration: {frame_count}")

        if frame_count is None:
            if max_frames is None:
                logging.warning(
                    f"  Warning: could not determine frame count; "
                    "use --max-frames or install ffprobe"
                )
                continue

            frame_count = max_frames
            logging.debug(f"  Using fallback frame count from --max-frames: {frame_count}")
        else:
            logging.debug(f"  Frame count: {frame_count}")

        if max_frames is not None:
            original_frame_count = frame_count
            frame_count = min(frame_count, max_frames)

            if frame_count != original_frame_count:
                logging.debug(f"  Debug frame limit enabled: processing first {frame_count} frame(s)")

        # Use frame times from cached metadata (already calculated in get_all_clip_metadata)
        logging.debug(f"  Preparing frame times for {frame_count} frames...")
        frame_times_seconds = metadata.get("frame_times") if metadata else None
        use_actual_times = frame_times_seconds is not None and len(frame_times_seconds) >= frame_count
        
        if use_actual_times:
            logging.info(f"  Using frame times from cached metadata ({len(frame_times_seconds)} frames available)")
        else:
            if frame_times_seconds:
                logging.warning(f"  Metadata has fewer times ({len(frame_times_seconds)}) than expected frames ({frame_count}); falling back to estimated timing")
            else:
                logging.debug(f"  Frame times not available in metadata; falling back to estimated timing")

        # Round clip start to nearest frame_interval
        rounded_clip_start = round_to_nearest_interval(clip_start, frame_interval_seconds)
        logging.debug(f"  Clip start rounded from {clip_start} to {rounded_clip_start} (interval={frame_interval_seconds}s)")
        
        # Get per-clip adjustment (supports both old single value and new CSV-based approach)
        clip_adjustment = get_clip_adjustment(
            clip_path.name,
            time_adjust_dict,
            previous_adjustment,
            first_adjustment
        )
        
        # For backward compatibility, if single adjustment provided and no CSV dict, use it
        if time_adjust_dict is None and adjust_start_time_seconds != 0.0:
            clip_adjustment = adjust_start_time_seconds
            logging.info(f"  Using global start time adjustment: {clip_adjustment}s")
        
        # Apply time adjustment if specified
        if clip_adjustment != 0.0:
            adjusted_clip_start = rounded_clip_start + timedelta(seconds=clip_adjustment)
            logging.debug(f"  Applying start time adjustment: {clip_adjustment}s (from {rounded_clip_start} to {adjusted_clip_start})")
            rounded_clip_start = adjusted_clip_start
        
        # Track this adjustment for next clip's fallback
        previous_adjustment = clip_adjustment

        matched_rows_before = len(output_rows)
        logging.debug(f"  Starting frame generation (current output rows: {matched_rows_before})")

        # Forward-scan through CSV: maintain index pointer that only advances
        csv_index = 0
        matched_count = 0
        
        for frame_index in range(frame_count):
            # For time-lapse clips:
            # - Real-world time: frame was captured at rounded_clip_start + frame_index * frame_interval
            #   (not based on fps, which is video playback speed)
            # - Video playback time: frame_index / fps seconds into the video file
            
            # Calculate real-world time for CSV matching
            # Always use frame_interval_seconds for time-lapse (not video fps)
            time_into_clip_seconds = frame_index * frame_interval_seconds

            frame_timestamp = rounded_clip_start + timedelta(seconds=time_into_clip_seconds)
            frame_time_str = frame_timestamp.strftime("%Y-%m-%dT%H:%M:%S")

            logging.debug(f"    Frame {frame_index}: searching for {frame_timestamp} (csv_index={csv_index})")

            # Forward-scan lookup: maintain csv_index pointer
            source_row, csv_index = find_row_for_time(
                rows_list=rows_list,
                timestamp=frame_timestamp,
                tolerance_seconds=tolerance_seconds,
                start_index=csv_index,
            )

            # Calculate video playback time for clip_timecode (frame position in video file)
            # This is based on FPS, not frame_interval
            fps = metadata.get("fps") if metadata else None
            if fps and fps > 0:
                video_time_seconds = frame_index / fps
            else:
                # Fallback: use real-world time (will be slower than actual playback)
                video_time_seconds = time_into_clip_seconds
            
            # Output clip_timecode as floating point seconds
            clip_timecode = str(video_time_seconds)
            
            # Create output row for this frame
            output_row = {}
            
            # Initialize all source CSV columns with empty strings
            for col in csv_fieldnames:
                if col != "Time":  # Don't copy original Time column
                    output_row[col] = ""
            
            # If we found a matching row in CSV, populate the data
            if source_row:
                matched_count += 1
                logging.debug(f"      → MATCH found at csv_index={csv_index}")
                for col in csv_fieldnames:
                    if col != "Time":  # Don't copy original Time column
                        output_row[col] = source_row.get(col, "")
            else:
                logging.debug(f"      → No match found, output row has empty data")
            
            # Add our required columns
            output_row["Time"] = frame_time_str
            output_row["clip_timecode"] = clip_timecode
            output_row["clip_name"] = clip_path.name
            
            output_rows.append(output_row)

        total_rows_for_clip = len(output_rows) - matched_rows_before
        logging.info(f"  Generated {total_rows_for_clip} frame rows ({matched_count} with matched CSV data) (total output rows: {len(output_rows)})")

    logging.info(f"Finished processing clips. Total matched output rows: {len(output_rows)}")

    return output_rows


def write_output_csv(
    output_path: Path,
    source_fieldnames: list[str],
    output_rows: list[dict[str, str]],
) -> None:
    # Build the output fieldnames: Time first, then source columns (excluding original Time),
    # then clip_name and clip_timecode
    output_fieldnames = ["Time"]
    for col in source_fieldnames:
        if col != "Time":
            output_fieldnames.append(col)
    output_fieldnames.extend(["clip_name", "clip_timecode"])

    logging.info(f"Writing output CSV: {output_path}")

    with output_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=output_fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)
    
    logging.info(f"Successfully wrote {len(output_rows)} rows to output CSV")


def main() -> None:
    logging.info("=== Extract INSV Frame CSV Script Started ===")
    
    parser = argparse.ArgumentParser(
        fromfile_prefix_chars="@",
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

    parser.add_argument(
        "--input-timezone",
        type=str,
        default="UTC",
        help=(
            "Timezone of the input CSV Time column (e.g., 'UTC', 'America/New_York', "
            "'Europe/London'). Default: UTC"
        ),
    )

    parser.add_argument(
        "--time-adjust-csv",
        type=Path,
        default=None,
        help=(
            "Path to CSV file with per-clip time adjustments. "
            "CSV columns: Clip, Instruments, Camera. "
            "Adjustment is calculated as (Instruments_time - Camera_time). "
            "For clips not in CSV, uses previous clip's adjustment (if available), "
            "then first available adjustment. Default: None (no adjustment)"
        ),
    )

    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable DEBUG level logging",
    )

    args = parser.parse_args()

    # Set logging level if a debug flag is set
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    input_dir = args.input_dir.expanduser().resolve()
    csv_path = args.csv_path.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    time_adjust_csv_path = args.time_adjust_csv.expanduser().resolve() if args.time_adjust_csv else None

    logging.debug(f"Input directory: {input_dir}")
    logging.debug(f"CSV path: {csv_path}")
    logging.debug(f"Output path: {output_path}")
    logging.debug(f"Frame interval: {args.frame_interval}s")
    logging.debug(f"Tolerance: {args.tolerance}s")
    logging.debug(f"Input timezone: {args.input_timezone}")
    if time_adjust_csv_path:
        logging.debug(f"Time adjustment CSV: {time_adjust_csv_path}")

    if not input_dir.is_dir():
        raise ValueError(f"Input directory does not exist: {input_dir}")

    if not csv_path.is_file():
        raise ValueError(f"CSV file does not exist: {csv_path}")
    
    if time_adjust_csv_path and not time_adjust_csv_path.is_file():
        raise ValueError(f"Time adjustment CSV does not exist: {time_adjust_csv_path}")

    try:
        source_fieldnames, rows_list = load_source_csv(csv_path, input_timezone=args.input_timezone)
        
        # Load time adjustments from CSV if provided
        time_adjust_dict = None
        if time_adjust_csv_path:
            time_adjust_dict = load_time_adjustments(time_adjust_csv_path, input_timezone=args.input_timezone)

        output_rows = build_output_rows(
            input_dir=input_dir,
            csv_fieldnames=source_fieldnames,
            rows_list=rows_list,
            frame_interval_seconds=args.frame_interval,
            tolerance_seconds=args.tolerance,
            max_frames=args.max_frames,
            max_clips=args.max_clips,
            adjust_start_time_seconds=0.0,
            time_adjust_dict=time_adjust_dict,
        )

        write_output_csv(
            output_path=output_path,
            source_fieldnames=source_fieldnames,
            output_rows=output_rows,
        )

        logging.info(f"=== Script Completed Successfully ===")
        logging.info(f"Final result: {len(output_rows)} rows written to {output_path}")
    
    except Exception as e:
        logging.error(f"Script failed with error: {e}", exc_info=True)
        raise


if __name__ == "__main__":
    main()
