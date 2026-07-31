#!/usr/bin/env python3

import argparse
import csv
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path

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


def parse_csv_time(value: str) -> datetime:
    """Parse timestamp from CSV with support for multiple formats."""
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


def format_clip_timecode(seconds: float) -> str:
    """Format seconds as clip timecode H:MM:SS (no leading zero for hours).
    
    Args:
        seconds: Time in seconds
    
    Returns:
        Formatted string as 'H:MM:SS' (e.g., '1:23:45' for 1 hour 23 minutes 45 seconds)
    """
    try:
        total_seconds = float(seconds)
        hours = int(total_seconds // 3600)
        minutes = int((total_seconds % 3600) // 60)
        secs = int(total_seconds % 60)
        return f"{hours}:{minutes:02d}:{secs:02d}"
    except (ValueError, TypeError):
        return ""


def get_tack(twa: float) -> str:
    """Determine tack from True Wind Angle.
    
    Args:
        twa: True Wind Angle in degrees (0-360)
    
    Returns:
        'starboard' if TWA in [10, 170)
        'port' if TWA in [190, 360) or [0, 10)
        'undefined' if TWA in [170, 190)
        None if TWA is not a valid number
    """
    try:
        twa_val = float(twa)
    except (ValueError, TypeError):
        return None

    if 30 <= twa_val < 200:
        return "starboard"
    elif 200 <= twa_val < 340:
        return "port"
    else:
        return "undefined"


def detect_gybes(
    rows: list[dict],
    min_tack_duration: float,
    time_column: str = "Time",
) -> list[int]:
    """Detect gybe events (tack transitions) with noise filtering.
    
    A gybe is only marked if BOTH the previous tack AND the new tack have been
    sustained for at least min_tack_duration seconds. This prevents false positives
    from TWA noise oscillations and ensures stable tack changes on both sides.
    
    Args:
        rows: List of CSV rows with instrument data
        min_tack_duration: Minimum sustained tack duration in seconds before and after marking transition
        time_column: Name of the time column
    
    Returns:
        List of indices where gybes occur (first record of new tack)
    """
    gybes = []
    prev_valid_tack = None
    tack_start_idx = None
    pending_gybe = None  # Track a candidate gybe awaiting validation of new tack duration

    for i, row in enumerate(rows):
        twa = row.get("TWA(med)", "")
        current_tack = get_tack(twa)

        # Skip undefined transitions; only work with valid tacks
        if current_tack != "undefined" and current_tack is not None:
            if prev_valid_tack is None:
                # First valid tack
                prev_valid_tack = current_tack
                tack_start_idx = i
            elif prev_valid_tack != current_tack:
                # Tack transition detected - validate previous tack duration
                if tack_start_idx is not None and tack_start_idx < len(rows):
                    try:
                        start_time = parse_csv_time(rows[tack_start_idx][time_column])
                        current_time = parse_csv_time(row[time_column])
                        prev_tack_duration = (current_time - start_time).total_seconds()

                        if prev_tack_duration >= min_tack_duration:
                            # Previous tack is valid; mark as pending until we confirm new tack duration
                            logging.debug(
                                f"Transition at row {i}: {prev_valid_tack} → {current_tack} "
                                f"(previous tack lasted {prev_tack_duration:.1f}s, pending validation of new tack)"
                            )
                            
                            # If we had a previous pending gybe, finalize it now that new tack lasted long enough
                            if pending_gybe is not None:
                                prev_pending_idx, prev_from_tack, prev_to_tack, prev_start_idx, prev_start_time = pending_gybe
                                new_tack_duration = prev_tack_duration
                                logging.debug(
                                    f"Finalizing previous gybe at row {prev_pending_idx}: {prev_from_tack} → {prev_to_tack} "
                                    f"(new tack lasted {new_tack_duration:.1f}s)"
                                )
                                gybes.append(prev_pending_idx)
                            
                            # Mark current transition as pending
                            pending_gybe = (i, prev_valid_tack, current_tack, tack_start_idx, start_time)
                        else:
                            # Previous tack too short - discard any pending gybe and don't create new one
                            if pending_gybe is not None:
                                prev_pending_idx, prev_from_tack, prev_to_tack, _, _ = pending_gybe
                                logging.debug(
                                    f"Discarding pending gybe at row {prev_pending_idx}: {prev_from_tack} → {prev_to_tack} "
                                    f"(new tack only lasted {prev_tack_duration:.1f}s, need {min_tack_duration}s)"
                                )
                                pending_gybe = None
                            
                            logging.debug(
                                f"Ignoring transition at row {i}: {prev_valid_tack} → {current_tack} "
                                f"(previous tack only lasted {prev_tack_duration:.1f}s, need {min_tack_duration}s)"
                            )
                    except (ValueError, KeyError):
                        logging.warning(f"Could not parse time at row {tack_start_idx} or {i}")
                        # On parsing error, conservatively discard pending gybe
                        pending_gybe = None

                prev_valid_tack = current_tack
                tack_start_idx = i

    # Note: any remaining pending_gybe at end of data is discarded (new tack duration cannot be verified)
    if pending_gybe is not None:
        pending_idx, from_tack, to_tack, _, _ = pending_gybe
        logging.debug(
            f"Discarding pending gybe at row {pending_idx}: {from_tack} → {to_tack} "
            f"(reached end of data; new tack duration cannot be verified)"
        )

    return gybes


def extract_window_records(
    rows: list[dict],
    gybe_indices: list[int],
    window_seconds: float,
    time_column: str = "Time",
) -> set[int]:
    """Extract record indices within time windows around gybe events.
    
    Args:
        rows: List of CSV rows
        gybe_indices: Indices where gybes occur
        window_seconds: Time window size in seconds (±window_seconds around gybe)
        time_column: Name of the time column in CSV
    
    Returns:
        Set of row indices to include in output
    """
    window_indices = set()

    for gybe_idx in gybe_indices:
        if gybe_idx >= len(rows):
            continue

        try:
            gybe_time = parse_csv_time(rows[gybe_idx][time_column])
        except (ValueError, KeyError):
            logging.warning(f"Could not parse time at gybe index {gybe_idx}")
            continue

        window_start = gybe_time - timedelta(seconds=window_seconds)
        window_end = gybe_time + timedelta(seconds=window_seconds)

        logging.debug(f"Gybe at index {gybe_idx}, time {gybe_time}: window [{window_start}, {window_end}]")

        # Find all records within the time window
        for i, row in enumerate(rows):
            try:
                record_time = parse_csv_time(row[time_column])
                if window_start <= record_time <= window_end:
                    window_indices.add(i)
            except (ValueError, KeyError):
                pass

    return window_indices


def load_csv(csv_path: Path) -> tuple[list[str], list[dict]]:
    """Load CSV file.
    
    Args:
        csv_path: Path to CSV file
    
    Returns:
        Tuple of (fieldnames, list of row dicts)
    """
    logging.info(f"Loading CSV: {csv_path}")

    rows = []
    fieldnames = None

    with csv_path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames

        if not fieldnames or "Time" not in fieldnames:
            raise ValueError(f"CSV must have a 'Time' column: {csv_path}")

        if "TWA(med)" not in fieldnames:
            raise ValueError(f"CSV must have a 'TWA(med)' column: {csv_path}")

        for i, row in enumerate(reader):
            rows.append(row)

    logging.info(f"Loaded {len(rows)} records from CSV")
    return fieldnames, rows


def write_csv(
    output_path: Path,
    fieldnames: list[str],
    rows: list[dict],
    gybe_indices: set[int],
    has_clip_timecode: bool = False,
) -> None:
    """Write output CSV with gybe event markers and optional formatted clip_timecode.
    
    Args:
        output_path: Path to output CSV file
        fieldnames: Column names (will add 'gybe_event' and optionally 'clip_timecode_formatted')
        rows: Records to write
        gybe_indices: Set of row indices that are gybe points
        has_clip_timecode: Whether input has a clip_timecode column to reformat
    """
    output_fieldnames = fieldnames + ["gybe_event"]
    if has_clip_timecode:
        output_fieldnames = output_fieldnames + ["clip_timecode_formatted"]

    with output_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=output_fieldnames)
        writer.writeheader()

        for i, row in enumerate(rows):
            row["gybe_event"] = "yes" if i in gybe_indices else ""
            if has_clip_timecode and "clip_timecode" in row:
                row["clip_timecode_formatted"] = format_clip_timecode(row["clip_timecode"])
            writer.writerow(row)

    logging.info(f"Wrote {len(rows)} records to {output_path}")


def main():
    parser = argparse.ArgumentParser(
        fromfile_prefix_chars="@",
        description="Extract gybe (tack change) events from wind-and-instrument CSV data"
    )
    parser.add_argument(
        "--csv",
        dest="csv_path",
        type=Path,
        required=True,
        help="Path to input CSV file (produced by extract_insv_frame_csv.py)",
    )
    parser.add_argument(
        "--output",
        dest="output_path",
        type=Path,
        required=True,
        help="Path to output CSV file (will contain gybe windows)",
    )
    parser.add_argument(
        "--window",
        dest="window_seconds",
        type=float,
        default=30.0,
        help="Time window around each gybe in seconds (default: 30)",
    )
    parser.add_argument(
        "--min-tack-duration",
        dest="min_tack_duration",
        type=float,
        default=None,
        help="Minimum sustained tack duration in seconds required BOTH before AND after gybe to mark as valid (default: same as --window). "
             "Prevents false positives from TWA noise oscillations by ensuring stable tacks on both sides of the transition.",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable debug logging",
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    csv_path = args.csv_path.expanduser().resolve()
    output_path = args.output_path.expanduser().resolve()

    # Default min_tack_duration to window size if not specified
    min_tack_duration = args.min_tack_duration if args.min_tack_duration is not None else args.window_seconds

    if not csv_path.is_file():
        raise ValueError(f"CSV file does not exist: {csv_path}")

    logging.info(f"Gybe detection parameters: window_seconds={args.window_seconds}, min_tack_duration={min_tack_duration}")
    logging.info("Gybes will be marked only if BOTH the previous and new tacks meet the minimum duration requirement.")

    # Load data
    fieldnames, rows = load_csv(csv_path)

    # Detect gybes with noise filtering
    logging.info("Detecting gybe events...")
    gybe_indices = detect_gybes(rows, min_tack_duration)
    logging.info(f"Found {len(gybe_indices)} gybe events")

    for idx in gybe_indices:
        if idx < len(rows):
            twa = rows[idx].get("TWA(med)", "?")
            time = rows[idx].get("Time", "?")
            logging.info(f"  Gybe {idx}: time={time}, TWA={twa}")

    # Extract window records
    logging.info("Extracting time windows around gybes...")
    window_indices = extract_window_records(rows, gybe_indices, args.window_seconds)
    logging.info(f"Extracted {len(window_indices)} records within gybe windows")

    # Create output rows (only records in windows)
    output_rows = [rows[i] for i in sorted(window_indices)]

    # Adjust indices for output (since we're filtering rows)
    output_gybe_indices = set()
    sorted_window_indices = sorted(window_indices)
    for i, orig_idx in enumerate(sorted_window_indices):
        if orig_idx in gybe_indices:
            output_gybe_indices.add(i)

    # Write output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    has_clip_timecode = "clip_timecode" in fieldnames
    if has_clip_timecode:
       logging.info("Found 'clip_timecode' column in input; will add 'clip_timecode_formatted' (H:MM:SS) to output")
    write_csv(output_path, fieldnames, output_rows, output_gybe_indices, has_clip_timecode)
    logging.info(f"Done! Output written to {output_path}")


if __name__ == "__main__":
    main()
