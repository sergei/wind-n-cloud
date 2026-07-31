# wind-n-cloud

`wind-n-cloud` is a web application for correlating cloud formations captured by an Insta360 camera with changes in sailing wind data.

The main goal is to review cloud video alongside wind history from race instrumentation data, especially:

- TWD — True Wind Direction
- TWS — True Wind Speed
- Heading
- COG / SOG
- AWS / AWA
- TWA

The application is designed around a continuous race timeline. Users interact with time, not with individual Insta360 clip names.

---

## Goals

The project aims to help answer questions such as:

- What cloud formations were visible before a wind shift?
- Did TWD change as the boat approached or passed under a cloud line?
- Did wind speed increase or decrease near visible cloud features?
- Can cloud structure be visually correlated with lifts, headers, gusts, or lulls?

---

## High-level architecture

Project structure:

    wind-n-cloud/
      data-processing/
        sample-data/
          extract_insv_frame_csv.py
          prepare_web_dataset.py
          sample-ydvr.csv

      web/
        future web application

      README.md

The project has two major layers:

1. Data-processing layer
2. Web application layer

---

## Data-processing layer

The data-processing scripts prepare synchronized data from:

1. Insta360 `.insv` time-lapse video files.
2. A sailing instrumentation CSV file.
3. Browser-ready `.mp4` files converted from the `.insv` files.

The output is a web dataset containing JSON files that the web application can load.

---

## Web application layer

The web app will:

- load a dataset manifest from S3 or CloudFront;
- load wind samples from JSON;
- stream MP4 video segments from S3 or CloudFront;
- present one continuous race timeline;
- show synchronized cloud video and wind history;
- hide artificial Insta360 clip boundaries from the user.

---

## User experience model

The user should not need to know about individual Insta360 files.

Internally, the camera creates many clips, for example:

    VID_20260707_060320_00_001.insv
    VID_20260707_061320_00_001.insv

But in the web app, the user simply sees something like:

    Pacific Cup 2026
    Current time: 2026-07-07 06:14:22 UTC

The application maps the current race time to the correct internal video segment.

---

## Wind display model

The wind display is intended to resemble a B&G-style time plot.

Instead of a conventional horizontal chart, wind history is plotted vertically:

    most recent sample at the top
    older samples below

The default history window is:

    60 minutes

This duration should be user-selectable later, for example:

- 5 minutes
- 15 minutes
- 30 minutes
- 60 minutes
- 120 minutes

Conceptually:

    Top of plot    = current video/race time
    Bottom of plot = current video/race time - selected history duration

During video playback:

    video current time changes
      -> current race time changes
      -> wind history window moves
      -> new wind samples appear at the top
      -> older samples scroll downward

---

## Data pipeline overview

The intended pipeline is:

    Raw YDVR CSV
      -> extract_insv_frame_csv.py
      -> insv-frame-data.csv
      -> prepare_web_dataset.py
      -> web-dataset/
           manifest.json
           data/
             wind-samples.json

Video conversion is handled separately:

    .insv files
      -> converted/transcoded MP4 files

The `.mp4` files should have the same base names as the source `.insv` files.

Example:

    VID_20260707_060320_00_001.insv
    VID_20260707_060320_00_001.mp4

---

## Step 1: Generate frame-matched CSV

The script `extract_insv_frame_csv.py` scans a directory recursively for Insta360 `.insv` files.

It only processes files that:

- have the `.insv` extension;
- start with `VID`.

For each video frame in a time-lapse clip, it finds the matching row from the source wind CSV and appends:

- `clip_name`
- `time_into_clip`

The resulting CSV has one row per video frame.

Example command:

    python data-processing/sample-data/extract_insv_frame_csv.py \
      /path/to/insv-files \
      --csv /path/to/source-ydvr.csv \
      --output /path/to/insv-frame-data.csv \
      --frame-interval 2

Useful debug option, limit the number of clips:

    python data-processing/sample-data/extract_insv_frame_csv.py \
      /path/to/insv-files \
      --csv /path/to/source-ydvr.csv \
      --output /path/to/insv-frame-data.csv \
      --frame-interval 2 \
      --max-clips 1

Useful debug option, limit the number of frames per clip:

    python data-processing/sample-data/extract_insv_frame_csv.py \
      /path/to/insv-files \
      --csv /path/to/source-ydvr.csv \
      --output /path/to/insv-frame-data.csv \
      --frame-interval 2 \
      --max-frames 100

The output keeps all original wind CSV columns and adds:

- `clip_name`
- `time_into_clip`

Example output columns:

    Time,TWD,TWS,Heading,...,clip_name,time_into_clip
    2026-07-07 06:03:20,160.30870,2.58531,167.18336,...,VID_20260707_060320_00_001.insv,00:00:00
    2026-07-07 06:03:22,218.39432,3.61555,167.60161,...,VID_20260707_060320_00_001.insv,00:00:02

---

## Step 2: Convert Insta360 video to MP4

Browsers generally cannot play `.insv` files directly.

The web app expects browser-ready `.mp4` files.

Recommended video format:

- MP4 container
- H.264 video
- AAC audio if audio is needed

Export MP4 file using Insta360 Studio with the following settings

Pan 0 
Roll 0 
Pitch 0
FOV 140
Distortion control 0.6



For web playback, the MP4 should support efficient seeking. With FFmpeg, use:

    ffmpeg \
      -i input.insv \
      -c:v libx264 \
      -preset medium \
      -crf 22 \
      -movflags +faststart \
      output.mp4

The important flag is:

    -movflags +faststart

The generated MP4 file should use the same base name as the `.insv` file.

Example:

    Input:
      VID_20260707_060320_00_001.insv

    Output:
      VID_20260707_060320_00_001.mp4

The MP4 files may be stored locally while preparing the dataset, then uploaded to S3 or CloudFront for deployment.

---

## Step 3: Prepare web dataset JSON

The script `prepare_web_dataset.py` consumes the frame-matched CSV produced by `extract_insv_frame_csv.py`.

It assumes:

- the CSV contains `clip_name`;
- the CSV contains `time_into_clip`;
- the MP4 directory contains files with the same base names as the `.insv` clip names.

Example command:

    python data-processing/sample-data/prepare_web_dataset.py \
      --csv /path/to/insv-frame-data.csv \
      --mp4-dir /path/to/mp4-files \
      --output-dir /path/to/web-dataset \
      --race-id pacific-cup-2026 \
      --display-name "Pacific Cup 2026"

Example with S3 or CloudFront video prefix:

    python data-processing/sample-data/prepare_web_dataset.py \
      --csv /path/to/insv-frame-data.csv \
      --mp4-dir /path/to/mp4-files \
      --output-dir /path/to/web-dataset \
      --race-id pacific-cup-2026 \
      --display-name "Pacific Cup 2026" \
      --public-video-prefix "https://assets.example.com/races/pacific-cup-2026/video"

This writes video URLs into the manifest like:

    https://assets.example.com/races/pacific-cup-2026/video/VID_20260707_060320_00_001.mp4

---

## Web dataset structure

The JSON preparation step produces:

    web-dataset/
      manifest.json
      data/
        wind-samples.json

The corresponding MP4 files should be uploaded separately, usually to a `video/` prefix:

    races/pacific-cup-2026/
      manifest.json
      data/
        wind-samples.json
      video/
        VID_20260707_060320_00_001.mp4
        VID_20260707_061320_00_001.mp4

---

## manifest.json

`manifest.json` is the dataset entry point for the web app.

It describes:

- dataset identity;
- display name;
- race start and end times;
- default wind history duration;
- available wind history durations;
- wind sample data URL;
- internal video segments.

Example shape:

    {
      "schemaVersion": 1,
      "raceId": "pacific-cup-2026",
      "displayName": "Pacific Cup 2026",
      "timezone": "UTC",
      "startTime": "2026-07-07T06:03:20Z",
      "endTime": "2026-07-07T15:42:18Z",
      "startTimeMs": 1783404200000,
      "endTimeMs": 1783438938000,
      "defaults": {
        "windHistoryDurationMinutes": 60,
        "availableWindHistoryDurationsMinutes": [5, 15, 30, 60, 120]
      },
      "data": {
        "windSamplesUrl": "data/wind-samples.json",
        "windSampleCount": 12345,
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
          "twa"
        ]
      },
      "videoSegments": [
        {
          "id": "segment-000001",
          "startTime": "2026-07-07T06:03:20Z",
          "endTime": "2026-07-07T06:13:18Z",
          "startTimeMs": 1783404200000,
          "endTimeMs": 1783404798000,
          "videoUrl": "video/VID_20260707_060320_00_001.mp4"
        }
      ]
    }

The user interface should not display video segment IDs or file names. They are internal implementation details.

---

## wind-samples.json

`wind-samples.json` contains columnar wind data optimized for browser loading.

Example shape:

    {
      "schemaVersion": 1,
      "format": "columnar",
      "count": 3,
      "time": [
        "2026-07-07T06:03:20Z",
        "2026-07-07T06:03:22Z",
        "2026-07-07T06:03:24Z"
      ],
      "timeMs": [
        1783404200000,
        1783404202000,
        1783404204000
      ],
      "twd": [
        160.3087,
        218.39432,
        199.35494
      ],
      "tws": [
        2.58531,
        3.61555,
        3.49892
      ],
      "heading": [
        167.18336,
        167.60161,
        167.66464
      ]
    }

Columnar data is used because it is convenient for plotting:

    timeMs[i]
    twd[i]
    tws[i]
    heading[i]

all refer to the same sample.

---

## S3 / CloudFront deployment model

The preferred deployment model is to host large race assets outside the web application bundle.

Recommended structure:

    s3://<bucket>/races/pacific-cup-2026/
      manifest.json
      data/
        wind-samples.json
      video/
        VID_20260707_060320_00_001.mp4
        VID_20260707_061320_00_001.mp4

A CloudFront distribution can serve these files as:

    https://assets.example.com/races/pacific-cup-2026/manifest.json
    https://assets.example.com/races/pacific-cup-2026/data/wind-samples.json
    https://assets.example.com/races/pacific-cup-2026/video/VID_20260707_060320_00_001.mp4

The web application loads the manifest URL, then resolves the wind data and video URLs from it.

---

## CORS requirements

If the web app is served from a different domain than the S3 or CloudFront assets, CORS must allow browser access.

Example S3 CORS configuration:

    [
      {
        "AllowedHeaders": ["*"],
        "AllowedMethods": ["GET", "HEAD"],
        "AllowedOrigins": [
          "http://localhost:5173",
          "https://app.example.com"
        ],
        "ExposeHeaders": [
          "Accept-Ranges",
          "Content-Length",
          "Content-Range"
        ],
        "MaxAgeSeconds": 3000
      }
    ]

For production, restrict `AllowedOrigins` to the actual web app domain.

---

## Web application architecture

The planned web application should be implemented as:

    Vite + React + TypeScript

Recommended rendering approach:

- HTML5 `<video>` for playback.
- React state for current race time and playback status.
- SVG or Canvas for the custom B&G-style wind plot.
- D3 scales/shapes for plotting utilities.
- Future canvas overlay on top of video for wind arrows.

Suggested structure:

    web/
      src/
        App.tsx

        components/
          RaceVideoPanel.tsx
          WindHistoryPanel.tsx
          TimelineControls.tsx
          LoadingState.tsx
          ErrorState.tsx

        data/
          loadRaceManifest.ts
          loadWindSamples.ts
          resolveDatasetUrls.ts

        playback/
          findSegmentForTime.ts
          useRacePlayback.ts
          timeMapping.ts

        overlay/
          WindOverlayCanvas.tsx

        types/
          race.ts

---

## Playback synchronization

The web app uses one central time value:

    currentRaceTimeMs

The video panel, wind plot, timeline controls, and future overlay all synchronize through that value.

When video playback advances:

    video.currentTime
      -> currentRaceTimeMs = activeSegment.startTimeMs + video.currentTime * 1000
      -> wind plot updates
      -> timeline controls update
      -> future overlay updates

When the user scrubs the timeline or clicks a time in the wind plot:

    selectedRaceTimeMs
      -> find internal video segment containing that time
      -> load corresponding MP4 if needed
      -> seek video.currentTime

The user sees a continuous race timeline even though video is internally split into segments.

---

## Wind history synchronization

For the B&G-style wind plot:

    top of plot = currentRaceTimeMs
    bottom of plot = currentRaceTimeMs - selected history duration

Each visible wind sample is transformed into:

    ageMinutes = (currentRaceTimeMs - sample.timeMs) / 60000

Then:

    TWD plot:
      x = sample.twd
      y = ageMinutes

    TWS plot:
      x = sample.tws
      y = ageMinutes

The vertical axis is reversed:

    0 minutes ago at the top
    60 minutes ago at the bottom

During playback, the wind history scrolls downward as time advances.

---

## Future video overlay

A later version will draw wind direction graphics over the cloud video.

Recommended structure:

    <div class="video-stage">
      <video></video>
      <canvas class="wind-overlay"></canvas>
    </div>

The overlay should receive the same synchronized time and wind sample data:

- `currentRaceTimeMs`
- `TWD`
- `TWS`
- `Heading`
- `AWA`
- `AWS`

This will allow the app to draw:

- true wind direction arrow;
- apparent wind direction arrow;
- heading reference;
- cloud-relative annotations;
- shift/gust markers.

---

## Timezone convention

Dataset JSON uses UTC timestamps.

Example:

    2026-07-07T06:03:20Z

The web app may later provide display options for local time, boat time, or UTC, but the data interchange format should remain UTC.

---

## Development notes

The Python scripts use the Python standard library. Some functionality may call external command-line tools such as `ffprobe`.

`ffprobe` is used by `extract_insv_frame_csv.py` to inspect video metadata and frame counts.

Install FFmpeg if needed:

    brew install ffmpeg

No Python package manager other than the project virtual environment is required.

---

## Current status

Implemented or planned data-processing pieces:

- `extract_insv_frame_csv.py`
  - recursively scans `.insv` files;
  - processes only `VID*.insv`;
  - matches time-lapse frames to rows in the source CSV;
  - writes frame-matched CSV with `clip_name` and `time_into_clip`.

- `prepare_web_dataset.py`
  - reads the frame-matched CSV;
  - assumes matching MP4 files exist in a specified directory;
  - writes `manifest.json`;
  - writes `data/wind-samples.json`.

Planned web app pieces:

- continuous time-based video playback;
- B&G-style vertical wind history plot;
- timeline scrubber;
- S3 or CloudFront dataset loading;
- wind overlay on top of video.