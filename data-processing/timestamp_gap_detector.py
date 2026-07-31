#!/usr/bin/env python3

import argparse
import csv
import re
from datetime import datetime, timezone
from pathlib import Path


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

    for time_format in CSV_TIME_FORMATS:
        try:
            parsed = datetime.strptime(value, time_format)

            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)

            return parsed
        except ValueError:
            pass

    raise ValueError(f"Unsupported timestamp format: {value!r}")


def read_timestamps(csv_path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []

    with csv_path.open("r", newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames:
            raise ValueError(f"CSV file has no header: {csv_path}")

        if "Time" not in reader.fieldnames:
            raise ValueError(f"CSV file must contain a 'Time' column: {csv_path}")

        for row_number, row in enumerate(reader, start=2):
            raw_time = row.get("Time")

            if not raw_time:
                continue

            timestamp = parse_time(raw_time)

            rows.append(
                {
                    "row_number": row_number,
                    "time": timestamp,
                    "time_text": raw_time,
                }
            )

    rows.sort(key=lambda item: item["time"])

    return rows


def find_time_gaps(
    rows: list[dict[str, object]],
    threshold_seconds: float,
) -> list[dict[str, object]]:
    gaps: list[dict[str, object]] = []

    for previous, current in zip(rows, rows[1:]):
        previous_time = previous["time"]
        current_time = current["time"]

        if not isinstance(previous_time, datetime):
            raise TypeError("previous time is not a datetime")

        if not isinstance(current_time, datetime):
            raise TypeError("current time is not a datetime")

        delta_seconds = (current_time - previous_time).total_seconds()

        if delta_seconds > threshold_seconds:
            gaps.append(
                {
                    "previous_time": previous_time.isoformat(sep=" "),
                    "current_time": current_time.isoformat(sep=" "),
                    "delta_seconds": f"{delta_seconds:.3f}",
                    "previous_row": previous["row_number"],
                    "current_row": current["row_number"],
                }
            )

    return gaps


def write_gaps(output_path: Path, gaps: list[dict[str, object]]) -> None:
    fieldnames = [
        "previous_time",
        "current_time",
        "delta_seconds",
        "previous_row",
        "current_row",
    ]

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(gaps)


def main() -> None:
    parser = argparse.ArgumentParser(
        fromfile_prefix_chars="@",
        description="Find timestamp gaps greater than a threshold in a CSV file."
    )

    parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="Input CSV file containing a Time column",
    )

    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output CSV file for detected gaps",
    )

    parser.add_argument(
        "--threshold",
        type=float,
        default=1.0,
        help="Gap threshold in seconds. Default: 1.0",
    )

    args = parser.parse_args()

    input_path = args.input.expanduser().resolve()
    output_path = args.output.expanduser().resolve()

    if not input_path.is_file():
        raise ValueError(f"Input CSV file does not exist: {input_path}")

    rows = read_timestamps(input_path)
    gaps = find_time_gaps(rows, threshold_seconds=args.threshold)
    write_gaps(output_path, gaps)

    print(f"Read {len(rows)} timestamped row(s)")
    print(f"Found {len(gaps)} gap(s) greater than {args.threshold} second(s)")
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
