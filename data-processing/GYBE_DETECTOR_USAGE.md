# Gybe Detection Script

Extract gybe (tack change) events from wind-and-instrument CSV data, with time windows around each gybe for video synchronization.

## Overview

A **gybe** (or jibe) is a sailing maneuver where the boat transitions from one tack to another:
- **Starboard tack**: Wind coming from the right side, True Wind Angle (TWA) in [10°, 170°]
- **Port tack**: Wind coming from the left side, TWA in [190°, 360°)
- **Undefined**: Values in [170°, 190°) are ignored during transition detection

## Usage

```bash
./extract_gybe_windows.py --csv INPUT.csv --output OUTPUT.csv [--window SECONDS] [--min-tack-duration SECONDS] [--verbose]
```

### Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--csv` | Yes | — | Path to input CSV file (from `extract_insv_frame_csv.py`) |
| `--output` | Yes | — | Path to output CSV file |
| `--window` | No | 30 | Time window around each gybe in seconds (±N seconds around gybe point) |
| `--min-tack-duration` | No | Same as `--window` | Minimum sustained tack duration in seconds to mark as valid gybe. Prevents false positives from TWA noise |
| `--verbose`, `-v` | No | False | Enable debug logging |

### Input CSV Requirements

- Must have a `Time` column (various formats supported: `YYYY-MM-DD HH:MM:SS`, ISO 8601, etc.)
- Must have a `TWA` column (True Wind Angle in degrees)
- All other columns are preserved in output

### Output

The output CSV contains:
- All columns from the input CSV
- A new `gybe_event` column marking gybe points with "yes"
- **Only records that fall within time windows around gybe events**

Example:
```
Time,TWA,TWS,Heading,...,gybe_event
2026-07-07 06:03:20,353.12535,2.58531,167.18336,...,
2026-07-07 06:03:21,39.64868,3.32397,167.35524,...,yes
2026-07-07 06:03:22,50.80417,3.61555,167.60161,...,
...
```

## Examples

### Basic usage (30-second window, noise-filtered)
```bash
./extract_gybe_windows.py --csv data.csv --output gybes.csv
```
This uses `--min-tack-duration 30` by default (same as window), filtering out false gybes.

### Strict noise filtering (require 2-minute sustained tack)
```bash
./extract_gybe_windows.py --csv data.csv --output gybes.csv --window 30 --min-tack-duration 120
```
Only marks gybes where the boat has been on the same tack for at least 2 minutes.

### Reduced filtering (sensitive detection)
```bash
./extract_gybe_windows.py --csv data.csv --output gybes.csv --window 30 --min-tack-duration 5
```
Marks gybes with less stringent duration requirements (5 seconds).

### With debug output
```bash
./extract_gybe_windows.py --csv data.csv --output gybes.csv --window 30 --verbose
```
Shows debug messages including rejected transitions and filtering details.

## How It Works

1. **Load CSV**: Reads input CSV with Time and TWA columns
2. **Detect gybes with noise filtering**: Identifies transitions between port and starboard tacks
   - Tracks previous valid tack (ignoring undefined TWA values [170-190°])
   - **Key filter**: Only marks a tack transition as a valid gybe if the previous tack lasted for at least `--min-tack-duration` seconds
   - This prevents false positives from TWA oscillations (noise in the sensor data)
   - Records the index of the first record in the new tack
3. **Extract windows**: For each detected gybe, finds all records within ±WINDOW seconds
4. **Write output**: Writes all windowed records with gybe event markers

## Tack Definition

The tack ranges are based on True Wind Angle:

```
         0° (head to wind)
         ↓
    10° ← → 350°  (undefined: 170-190°)
    /               \
   /                 \
  /                   \
Starboard [10-170°]   Port [190-360°)
(wind from right)     (wind from left)
```

## Performance

- Processes 10,000+ records efficiently
- Memory-efficient: loads entire CSV into memory
- Time complexity: O(n) for gybe detection + O(n*m) for window extraction (n=records, m=gybes)

## Noise Filtering

The `--min-tack-duration` parameter is the key to reducing noisy false-positive gybes:

**Without filtering** (`--min-tack-duration 0`):
- Any TWA oscillation between tacks triggers a gybe event
- Results in many spurious detections

**With filtering** (default: `--min-tack-duration = --window`):
- Only marks tack transitions where the boat has been stably on one tack for N seconds
- Reduces noise from sensor fluctuations
- Captures only "real" gybes where the maneuver has clarity

**Example scenario**:
```
Time  TWA    Tack       Action
00:00  40°   starboard  starting point
00:05 175°   undefined  (ignored)
00:06 165°   starboard  (bounces back)
00:10 180°   undefined  (ignored)
00:11 200°   port       - with min_tack_duration=30s: NO GYBE (only 5s on starboard)
                         - with min_tack_duration=5s: GYBE MARKED (5s ≥ 5s)
00:15 210°   port       continuing on port tack
```
