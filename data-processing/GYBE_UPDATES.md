# Gybe Detector Updates

## Changes Made

### 1. TWA(med) Column Support
- **Changed from**: `TWA` column
- **Changed to**: `TWA(med)` column (median True Wind Angle)
- **Files affected**: `extract_gybe_windows.py`
- **Rationale**: Uses the median TWA value, more stable and less sensitive to instantaneous noise

**Locations updated**:
- Line 95: `row.get("TWA(med)", "")`
- Line 200: Validation requires `TWA(med)` column
- Line 304: Display gybe info using `TWA(med)`

### 2. Config File Support via @ Prefix
- **Added**: `fromfile_prefix_chars="@"` to ArgumentParser
- **Enables**: Reading arguments from files using `@filename` syntax
- **Location**: Line 239 in parser initialization

**Usage**:
```bash
# Create a config file
cat > gybe_config.txt << 'END'
--csv
/path/to/data.csv
--output
/path/to/output.csv
--window
30
--min-tack-duration
60
END

# Run with config file
./extract_gybe_windows.py @gybe_config.txt --verbose
```

**Benefits**:
- Store complex parameter sets in files
- Easier to version control configurations
- Useful for batch processing with different parameters
- Can override config with command-line args: `./extract_gybe_windows.py @config.txt --window 60`

## Testing

### TWA(med) Column
✅ Successfully loads sample-ydvr.csv with TWA(med) column
✅ Correctly identifies tack transitions
✅ Filters noise with min-tack-duration parameter

### Config File Feature
✅ Config file parsing works correctly
✅ All parameters read from file
✅ Can be combined with CLI arguments
✅ Example: `./extract_gybe_windows.py @config.txt --verbose` works

## Backward Compatibility
⚠️ **Breaking change**: Script now requires `TWA(med)` column instead of `TWA`
- Ensure input CSV files from extract_insv_frame_csv.py contain TWA(med)
- Old CSV files using only `TWA` will need to be regenerated

## Files Modified
- `/Users/sergei/github/wind-n-cloud/data-processing/extract_gybe_windows.py`

## Documentation
- See `GYBE_DETECTOR_USAGE.md` for full usage guide
- Config file examples available above
