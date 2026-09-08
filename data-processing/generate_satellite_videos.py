#!/usr/bin/env python3
"""
generate_satellite_videos.py

Generates synchronized satellite MP4 videos from georeferenced GOES satellite
images and wind/boat overlays, matching each boat camera video segment 1:1 in
UTC time range and video duration.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from PIL import Image


CSV_TIME_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%SZ",
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

    # Try parsing YYYYMMDD_HHMM from filename
    match = re.search(r"(\d{8})_(\d{4})", value)
    if match:
        try:
            return datetime.strptime(f"{match.group(1)}_{match.group(2)}", "%Y%m%d_%H%M")
        except ValueError:
            pass

    raise ValueError(f"Unsupported timestamp format: {value!r}")


def to_time_ms(value: datetime) -> int:
    return int(value.replace(tzinfo=timezone.utc).timestamp() * 1000)


@dataclass
class SatelliteScan:
    scan_id: str
    time_ms: int
    iso_time: str
    base_image_path: Path
    overlay_image_path: Path | None
    xml_path: Path | None


def is_hidden_or_osx_file(path: Path) -> bool:
    """
    Checks if a file or directory is hidden or an OSX metadata file
    (e.g., .DS_Store, ._*, or hidden dotfiles).
    """
    return path.name.startswith(".") or path.name.startswith("._")


def canonicalize_scan_stem(stem: str) -> str:
    """
    Normalizes GOES image stems across product names like COMPOSITE and TRUECOLOR.
    Example: GOES18_COMPOSITE_20260707_1400 -> GOES18_20260707_1400
    """
    normalized = re.sub(r"(?i)_(?:COMPOSITE|TRUECOLOR)(?=_|$)", "", stem)
    normalized = re.sub(r"__+", "_", normalized).strip("_")
    return normalized


def load_satellite_scans(
    goes_dir: Path,
    overlays_dir: Path | None = None,
) -> list[SatelliteScan]:
    """
    Discovers all GOES satellite images and matching wind overlays.
    Extracts timestamps from XML metadata or filename patterns.
    Ignores hidden and OSX metadata files.
    """
    if not goes_dir.is_dir():
        raise ValueError(f"GOES directory not found: {goes_dir}")

    if overlays_dir is None:
        default_overlay_dir = goes_dir / "wind_overlays"
        if default_overlay_dir.is_dir():
            overlays_dir = default_overlay_dir

    scans: list[SatelliteScan] = []

    # Find all base PNG images (excluding hidden/OSX files and overlay files)
    for image_path in sorted(goes_dir.glob("*.png")):
        if is_hidden_or_osx_file(image_path):
            continue

        if "_overlay" in image_path.stem or "overlay" in image_path.stem.lower():
            continue

        stem = image_path.stem
        canonical_stem = canonicalize_scan_stem(stem)
        xml_path = goes_dir / f"{stem}.xml"
        scan_time: datetime | None = None

        if xml_path.is_file() and not is_hidden_or_osx_file(xml_path):
            try:
                tree = ET.parse(xml_path)
                root = tree.getroot()
                rev_elem = root.find("rev")
                if rev_elem is not None and rev_elem.text:
                    scan_time = parse_time(rev_elem.text)
            except Exception as e:
                print(f"Warning: Failed to parse XML {xml_path}: {e}")

        if scan_time is None:
            try:
                scan_time = parse_time(stem)
            except ValueError:
                try:
                    scan_time = parse_time(canonical_stem)
                except ValueError:
                    print(f"Warning: Could not determine timestamp for {image_path.name}; skipping")
                    continue

        time_ms = to_time_ms(scan_time)
        iso_time = scan_time.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")

        overlay_path: Path | None = None
        if overlays_dir and overlays_dir.is_dir():
            overlay_candidates = []
            for candidate_stem in {stem, canonical_stem}:
                overlay_candidates.extend(
                    [
                        overlays_dir / f"{candidate_stem}_wind_overlay.png",
                        overlays_dir / f"{candidate_stem}_overlay.png",
                        overlays_dir / f"{candidate_stem}.png",
                    ]
                )

            for candidate in overlay_candidates:
                if candidate.is_file() and not is_hidden_or_osx_file(candidate):
                    overlay_path = candidate
                    break

            if overlay_path is None:
                for overlay_file in sorted(overlays_dir.glob("*.png")):
                    if is_hidden_or_osx_file(overlay_file):
                        continue
                    if "overlay" not in overlay_file.stem.lower():
                        continue
                    overlay_base = overlay_file.stem
                    for suffix in ("_wind_overlay", "_overlay"):
                        if overlay_base.endswith(suffix):
                            overlay_base = overlay_base[: -len(suffix)]
                            break
                    if canonicalize_scan_stem(overlay_base) == canonical_stem:
                        overlay_path = overlay_file
                        break

        scans.append(
            SatelliteScan(
                scan_id=canonical_stem,
                time_ms=time_ms,
                iso_time=iso_time,
                base_image_path=image_path,
                overlay_image_path=overlay_path,
                xml_path=xml_path if (xml_path.is_file() and not is_hidden_or_osx_file(xml_path)) else None,
            )
        )

    scans.sort(key=lambda s: s.time_ms)
    print(f"Loaded {len(scans)} satellite scan(s) from {goes_dir}")
    return scans


def _apply_rgba_overlay(base: Image.Image, overlay_path: Path | None, target_size: tuple[int, int]) -> Image.Image:
    if not overlay_path or not overlay_path.is_file():
        return base

    overlay = Image.open(overlay_path).convert("RGBA")
    if overlay.size != target_size:
        overlay = overlay.resize(target_size, Image.Resampling.BILINEAR)

    if overlay.getchannel("A").getextrema() == (0, 0):
        return base

    return Image.alpha_composite(base, overlay)


def composite_scan_image(
    scan: SatelliteScan,
    output_dir: Path,
    cache: dict[str, Path],
    coastline_overlay_path: Path | None = None,
) -> Path:
    """
    Composites base satellite image and overlays (if present) into a single RGB image.
    Any coastline overlay is applied last so it appears as the top layer.
    Uses cached result if already rendered.
    """
    cache_key = f"{scan.scan_id}|{coastline_overlay_path.as_posix() if coastline_overlay_path else 'none'}"
    if cache_key in cache:
        return cache[cache_key]

    output_path = output_dir / f"comp_{scan.scan_id}.png"
    if coastline_overlay_path:
        output_path = output_dir / f"comp_{scan.scan_id}_coastline.png"
    if output_path.is_file():
        cache[cache_key] = output_path
        return output_path

    base = Image.open(scan.base_image_path).convert("RGBA")
    composited = _apply_rgba_overlay(base, scan.overlay_image_path, base.size)
    composited = _apply_rgba_overlay(composited, coastline_overlay_path, base.size)
    composited = composited.convert("RGB")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    composited.save(output_path, format="PNG")
    cache[cache_key] = output_path
    return output_path


def find_active_scan_at_time(
    scans: list[SatelliteScan],
    target_time_ms: int,
) -> SatelliteScan:
    """
    Finds the active satellite scan for a given timestamp.
    Returns the latest scan with scan_time <= target_time, or the first scan if before all.
    """
    if not scans:
        raise ValueError("No satellite scans available")

    best_scan = scans[0]
    for scan in scans:
        if scan.time_ms <= target_time_ms:
            best_scan = scan
        else:
            break
    return best_scan


def build_segment_scan_timeline(
    segment_start_ms: int,
    segment_end_ms: int,
    video_duration_seconds: float,
    scans: list[SatelliteScan],
) -> list[tuple[SatelliteScan, float]]:
    """
    Builds the timeline of (scan, duration_in_video_seconds) for a video segment.
    """
    if not scans:
        raise ValueError("No satellite scans available")

    race_duration_ms = max(1, segment_end_ms - segment_start_ms)
    race_duration_seconds = race_duration_ms / 1000.0

    # Collect transition points within the segment
    transitions: list[int] = [segment_start_ms]
    for scan in scans:
        if segment_start_ms < scan.time_ms < segment_end_ms:
            transitions.append(scan.time_ms)
    transitions.append(segment_end_ms)
    transitions = sorted(list(set(transitions)))

    intervals: list[tuple[SatelliteScan, float]] = []
    total_allocated_video_seconds = 0.0

    for i in range(len(transitions) - 1):
        t0 = transitions[i]
        t1 = transitions[i + 1]
        active_scan = find_active_scan_at_time(scans, t0)
        interval_race_seconds = (t1 - t0) / 1000.0
        interval_video_seconds = (
            interval_race_seconds / race_duration_seconds
        ) * video_duration_seconds

        intervals.append((active_scan, interval_video_seconds))
        total_allocated_video_seconds += interval_video_seconds

    # Adjust rounding discrepancy on the last interval if necessary
    if intervals and abs(total_allocated_video_seconds - video_duration_seconds) > 1e-4:
        last_scan, last_dur = intervals[-1]
        intervals[-1] = (
            last_scan,
            max(0.01, last_dur + (video_duration_seconds - total_allocated_video_seconds)),
        )

    return intervals


def encode_satellite_video(
    intervals: list[tuple[SatelliteScan, float]],
    composited_cache: dict[str, Path],
    comp_dir: Path,
    output_mp4_path: Path,
    video_duration_seconds: float,
    scale_filter: str | None = None,
    coastline_overlay_path: Path | None = None,
) -> None:
    """
    Encodes an MP4 video using ffmpeg and ffconcat demuxer.
    """
    output_mp4_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir:
        print(f"Intermediate temp directory: {tmp_dir}")
        concat_file = Path(tmp_dir) / "concat.txt"
        with concat_file.open("w", encoding="utf-8") as f:
            f.write("ffconcat version 1.0\n")
            for scan, duration in intervals:
                img_path = composite_scan_image(
                    scan,
                    comp_dir,
                    composited_cache,
                    coastline_overlay_path=coastline_overlay_path,
                )
                f.write(f"file '{img_path.resolve().as_posix()}'\n")
                f.write(f"duration {duration:.6f}\n")
            # FFmpeg concat demuxer requires last file repeated without duration
            last_scan, _ = intervals[-1]
            last_img = composite_scan_image(
                last_scan,
                comp_dir,
                composited_cache,
                coastline_overlay_path=coastline_overlay_path,
            )
            f.write(f"file '{last_img.resolve().as_posix()}'\n")

        # Build video filter: ensures even dimensions (H.264 requirement), 30fps cfr + optional scale
        vf_filters = ["pad=ceil(iw/2)*2:ceil(ih/2)*2", "fps=30"]
        if scale_filter:
            vf_filters.append(scale_filter)
        vf_string = ",".join(vf_filters)

        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-t",
            f"{video_duration_seconds:.6f}",
            "-vf",
            vf_string,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output_mp4_path),
        ]
        print(f"ffmpeg command: {' '.join(cmd)}")

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed to encode {output_mp4_path}:\n{result.stderr}"
            )


def generate_satellite_videos_for_manifest(
    manifest_path: Path,
    goes_dir: Path,
    overlays_dir: Path | None,
    output_dir: Path,
    public_satellite_prefix: str = "satellite-video",
    scale: str | None = None,
    coastline_overlay_path: Path | None = None,
    max_seconds: float | None = None,
) -> dict[str, Any]:
    """
    Generates synchronized satellite MP4 videos for all video segments in a manifest.
    Updates the manifest with satelliteVideoUrl for each segment and returns updated manifest.
    """
    if not manifest_path.is_file():
        raise ValueError(f"Manifest file not found: {manifest_path}")

    with manifest_path.open("r", encoding="utf-8") as f:
        manifest = json.load(f)

    segments = manifest.get("videoSegments", [])
    if not segments:
        print("Warning: No video segments found in manifest")
        return manifest

    if coastline_overlay_path is not None:
        coastline_overlay_path = coastline_overlay_path.expanduser().resolve()
        if not coastline_overlay_path.is_file():
            raise ValueError(f"Coastline overlay PNG not found: {coastline_overlay_path}")

    scans = load_satellite_scans(goes_dir, overlays_dir)
    if not scans:
        raise ValueError(f"No valid GOES satellite scans found in {goes_dir}")

    comp_dir = output_dir / ".composited_cache"
    comp_dir.mkdir(parents=True, exist_ok=True)
    composited_cache: dict[str, Path] = {}

    scale_filter = f"scale={scale}" if scale else None
    if max_seconds is not None:
        if max_seconds <= 0:
            raise ValueError(f"--max-seconds must be greater than 0, got {max_seconds}")
        print(f"Debug limit: generating only the first {max_seconds}s of each segment")

    print(f"Composite cache directory: {comp_dir}")
    print(f"Output directory: {output_dir}")
    print(f"\nGenerating {len(segments)} synchronized satellite video(s)...")

    for index, segment in enumerate(segments, start=1):
        segment_id = segment["id"]
        start_ms = segment["startTimeMs"]
        end_ms = segment["endTimeMs"]
        video_duration_s = segment.get("videoDurationSeconds")

        if video_duration_s is None or video_duration_s <= 0:
            race_duration_s = (end_ms - start_ms) / 1000.0
            video_duration_s = race_duration_s
        if max_seconds is not None:
            video_duration_s = min(video_duration_s, max_seconds)

        # Determine output satellite mp4 filename based on boat videoUrl
        boat_video_url = segment["videoUrl"]
        boat_filename = Path(boat_video_url).name
        sat_filename = f"sat_{boat_filename}"
        output_mp4_path = output_dir / sat_filename

        intervals = build_segment_scan_timeline(
            segment_start_ms=start_ms,
            segment_end_ms=end_ms,
            video_duration_seconds=video_duration_s,
            scans=scans,
        )

        scan_summary = ", ".join(f"{s.scan_id} ({dur:.1f}s)" for s, dur in intervals)
        print(
            f"  [{index}/{len(segments)}] {segment_id} -> {sat_filename} "
            f"(dur={video_duration_s:.2f}s, scans: {scan_summary})"
        )

        encode_satellite_video(
            intervals=intervals,
            composited_cache=composited_cache,
            comp_dir=comp_dir,
            output_mp4_path=output_mp4_path,
            video_duration_seconds=video_duration_s,
            scale_filter=scale_filter,
            coastline_overlay_path=coastline_overlay_path,
        )

        # Set satelliteVideoUrl in segment
        sat_video_url = (
            f"{public_satellite_prefix.rstrip('/')}/{sat_filename}"
            if public_satellite_prefix
            else sat_filename
        )
        segment["satelliteVideoUrl"] = sat_video_url

    # Write updated manifest
    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"\nSuccessfully generated satellite videos in: {output_dir}")
    print(f"Updated manifest saved to: {manifest_path}")

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        fromfile_prefix_chars="@",
        description="Generate synchronized satellite MP4 videos matching boat camera timelapses 1:1."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        required=True,
        help="Path to manifest.json containing videoSegments.",
    )
    parser.add_argument(
        "--goes-dir",
        type=Path,
        required=True,
        help="Directory containing GOES satellite PNGs and XML/PGW metadata.",
    )
    parser.add_argument(
        "--overlays-dir",
        type=Path,
        default=None,
        help="Directory containing wind_overlays PNGs (default: <goes-dir>/wind_overlays).",
    )
    parser.add_argument(
        "--coastline-overlay",
        type=Path,
        default=None,
        help="PNG layer to apply as the topmost overlay on every generated frame.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Output directory where satellite MP4 files will be written.",
    )
    parser.add_argument(
        "--public-satellite-prefix",
        default="satellite-video",
        help="URL prefix for satellite video paths written to manifest (default: satellite-video).",
    )
    parser.add_argument(
        "--scale",
        default=None,
        help="Optional video scale filter for ffmpeg, e.g. 1920:-2.",
    )
    parser.add_argument(
        "--max-seconds",
        type=float,
        default=None,
        help="Optional debug limit: generate only the first N seconds of each satellite video.",
    )

    args = parser.parse_args()

    generate_satellite_videos_for_manifest(
        manifest_path=args.manifest.expanduser().resolve(),
        goes_dir=args.goes_dir.expanduser().resolve(),
        overlays_dir=args.overlays_dir.expanduser().resolve() if args.overlays_dir else None,
        output_dir=args.output_dir.expanduser().resolve(),
        public_satellite_prefix=args.public_satellite_prefix,
        scale=args.scale,
        coastline_overlay_path=args.coastline_overlay.expanduser().resolve()
        if args.coastline_overlay
        else None,
        max_seconds=args.max_seconds,
    )


if __name__ == "__main__":
    main()
