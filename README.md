# wind-n-cloud

`wind-n-cloud` is a web application for correlating cloud formations captured by an Insta360 camera with changes in sailing wind data.

The main goal is to review cloud video alongside wind history from race instrumentation data, especially:

- TWD — True Wind Direction
- TWS — True Wind Speed
- TWA — True Wind Angle
- Heading
- COG / SOG
- AWS / AWA

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
        cors_enabled_http_server.py
        extract_insv_frame_csv.py
        prepare_web_dataset.py
        timestamp_gap_detector.py
        sample-data/
          sample-ydvr.csv

      web/
        src/
          components/
            RaceVideoPanel.tsx
            TimelineControls.tsx
            WindHistoryPanel.tsx
          data/
          playback/
          styles/
          types/
          App.tsx
          main.tsx
        index.html
        package.json
        tsconfig.json

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

The web app:

- loads a dataset manifest from a local server, GitHub Pages + CloudFront, S3, or CloudFront;
- loads wind samples from JSON;
- streams MP4 video segments;
- presents one continuous race timeline;
- shows synchronized cloud video and wind history;
- hides artificial Insta360 clip boundaries from the user.

The app is implemented with:

- Vite
- React
- TypeScript
- SVG/D3-style plotting utilities for the wind history display
- HTML5 video playback

---

## Deployment model

The project now supports two operating modes:

### Local development
- run the web app against local files and a local HTTP server;
- use `prepare_web_dataset.py` with relative asset paths;
- no AWS credentials are required.

### Production
- deploy the static site to GitHub Pages from the same repo;
- provision S3/CloudFront/IAM with CloudFormation;
- upload videos manually to S3;
- upload non-video data files by running `prepare_web_dataset.py --upload-to-s3`.

The CloudFormation stack is deployed with the profile-based helper:

```bash
python3 scripts/deploy_media_stack.py \
  --profile devops \
  --region us-west-2 \
  --stack-name wind-n-cloud-media
```

## User experience model

The user should not need to know about individual Insta360 files.

Internally, the camera creates files such as:

    VID_20260712_105651_00_009.insv

But in the web app, the user simply sees something like:

    Pacific Cup
    Current time: 2026-07-12 21:18:45 UTC

The application maps the current race time to the correct internal video position.

For debugging, the current video file name may be displayed next to the `Cloud video` panel title.

---

## Time-lapse video model

The MP4 video is time-lapse footage.

That means MP4 playback time is not the same as real race time.

Example:

    One MP4 video second may represent about 60 race seconds.

The manifest stores this mapping per segment:

    raceDurationSeconds
    videoDurationSeconds
    raceSecondsPerVideoSecond

Example segment:

    {
      "id": "segment-000001",
      "startTime": "2026-07-12T17:56:51Z",
      "endTime": "2026-07-13T23:54:51Z",
      "startTimeMs": 1783879011000,
      "endTimeMs": 1783986891000,
      "frameCount": 50400,
      "frameIntervalSeconds": 2.0,
      "raceDurationSeconds": 107880.0,
      "videoDurationSeconds": 1799.7998,
      "raceSecondsPerVideoSecond": 59.94,
      "videoUrl": "video/VID_20260712_105651_00_009.mp4"
    }

The web app uses this mapping in both directions:

    race time -> MP4 currentTime
    MP4 currentTime -> race time

This is essential for correct seeking and playback synchronization.

---

## Wind display model

The wind display resembles a B&G-style time plot.

Instead of a conventional horizontal chart, wind history is plotted vertically:

    most recent sample at the top
    older samples below

The default history window is:

    60 minutes

This duration is user-selectable, for example:

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

TWD and TWS are autoscaled to the currently displayed values, similar to a sailing instrument history plot.

### Wind plot colors

The wind history plot uses sailing-oriented colors:

- TWS is plotted in white.
- TWD is plotted in red or green based on TWA.
- TWA is interpreted as:
  - `TWA < 0` or equivalent signed negative angle: port side / red
  - `TWA >= 0` or equivalent signed positive angle: starboard side / green

TWA values may arrive as `0..360` degrees. The web app converts them for display into:

    -180..+180 degrees

Examples:

    10°   -> +10°
    180°  -> -180° or +180° depending on normalization edge case
    350°  -> -10°

The top readout displays:

    TWD / TWA

For example:

    286° -42°

The TWA part is colored:

- green for positive
- red for negative
- muted gray if unavailable

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

    VID_20260712_105651_00_009.insv
    VID_20260712_105651_00_009.mp4

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

    python data-processing/extract_insv_frame_csv.py \
      /path/to/insv-files \
      --csv /path/to/source-ydvr.csv \
      --output /path/to/insv-frame-data.csv \
      --frame-interval 2

Useful debug option, limit the number of clips:

    python data-processing/extract_insv_frame_csv.py \
      /path/to/insv-files \
      --csv /path/to/source-ydvr.csv \
      --output /path/to/insv-frame-data.csv \
      --frame-interval 2 \
      --max-clips 1

Useful debug option, limit the number of frames per clip:

    python data-processing/extract_insv_frame_csv.py \
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
    2026-07-12 17:56:51,286.0,4.6,104.0,...,VID_20260712_105651_00_009.insv,00:00:00
    2026-07-12 17:56:53,287.0,4.7,104.0,...,VID_20260712_105651_00_009.insv,00:00:02

### Timestamp matching tolerance

`extract_insv_frame_csv.py` matches generated frame timestamps against the source CSV timestamps.

The default tolerance is:

    0.5 seconds

For 1 Hz source data and 2-second time-lapse frames, a tolerance around this range is usually appropriate:

    1.0 seconds
    1.1 seconds

A very large tolerance, such as 4 seconds, can hide real wind changes by matching frames to source data too far away in time.

---

## Step 2: Convert Insta360 video to MP4

Browsers generally cannot play `.insv` files directly.

The web app expects browser-ready `.mp4` files.

Recommended video format:

- MP4 container
- H.264 video for best browser compatibility
- AAC audio if audio is needed

When exporting MP4 from Insta360 Studio, suggested settings are:

    Pan: 0
    Roll: 0
    Pitch: 0
    FOV: 140
    Distortion control: 0.6

For web playback, the MP4 should support efficient seeking. With FFmpeg, use:

    ffmpeg \
      -i input.mp4 \
      -c copy \
      -movflags +faststart \
      output.mp4

The important flag is:

    -movflags +faststart

This moves MP4 metadata to the beginning of the file.

A properly faststart-remuxed file should have:

    ftyp
    moov
    mdat

You can verify with:

    AtomicParsley video/VID_20260712_105651_00_009.mp4 -T

Good output has `moov` before `mdat`.

---

## Step 3: Prepare web dataset JSON

The script `prepare_web_dataset.py` consumes the frame-matched CSV produced by `extract_insv_frame_csv.py`.

It assumes:

- the CSV contains `clip_name`;
- the CSV contains `time_into_clip`;
- the MP4 directory contains files with the same base names as the `.insv` clip names.

It also inspects MP4 duration using `ffprobe` and writes time-lapse mapping fields to the manifest:

- `frameCount`
- `frameIntervalSeconds`
- `raceDurationSeconds`
- `videoDurationSeconds`
- `raceSecondsPerVideoSecond`

Example command:

    python data-processing/prepare_web_dataset.py \
      --csv /path/to/insv-frame-data.csv \
      --mp4-dir /path/to/mp4-files \
      --output-dir /path/to/web-dataset \
      --race-id pacific-cup \
      --display-name "Pacific Cup"

Example with S3 or CloudFront video prefix:

    python data-processing/prepare_web_dataset.py \
      --csv /path/to/insv-frame-data.csv \
      --mp4-dir /path/to/mp4-files \
      --output-dir /path/to/web-dataset \
      --race-id pacific-cup \
      --display-name "Pacific Cup" \
      --asset-base-url "https://assets.example.com/races/pacific-cup"

This writes video URLs into the manifest like:

    https://assets.example.com/races/pacific-cup/video/VID_20260712_105651_00_009.mp4

---

## Timestamp gap detector

The project includes `timestamp_gap_detector.py`.

It finds cases where the delta between consecutive timestamps is greater than a threshold.

Example for original 1 Hz source data:

    python data-processing/timestamp_gap_detector.py \
      --input /path/to/source-ydvr.csv \
      --output /path/to/source-gaps.csv \
      --threshold 1.0

Example for extracted 2-second frame data:

    python data-processing/timestamp_gap_detector.py \
      --input /path/to/insv-frame-data.csv \
      --output /path/to/extracted-gaps.csv \
      --threshold 2.1

Use this to distinguish:

- gaps already present in the source data;
- gaps introduced during frame extraction;
- gaps caused by unmatched frame timestamps.

---

## Web dataset structure

The JSON preparation step produces:

    web-dataset/
      manifest.json
      data/
        wind-samples.json

The corresponding MP4 files should be available under the video prefix referenced by the manifest.

For local development, a typical dataset directory looks like:

    /path/to/web-dataset/
      manifest.json
      data/
        wind-samples.json
      video/
        VID_20260712_105651_00_009.mp4

For S3 or CloudFront deployment, a typical layout is:

    races/pacific-cup/
      manifest.json
      data/
        wind-samples.json
      video/
        VID_20260712_105651_00_009.mp4

---

## Running the web app locally

Install web dependencies:

    cd web
    npm install

Start the Vite development server:

    npm run dev

The app usually runs at:

    http://localhost:5173/

By default, the app tries to load:

    /manifest.json

For a prepared dataset, pass the manifest URL using the `manifest` query parameter:

    http://localhost:5173/?manifest=http://localhost:8000/manifest.json

Use a cache-busting query parameter after regenerating the manifest:

    http://localhost:5173/?manifest=http://localhost:8000/manifest.json?v=2

---

## Serving a local dataset

If the dataset is local, do not load `manifest.json` directly from the filesystem.

Instead, serve the dataset directory over HTTP.

The local server must support:

- CORS headers
- HTTP byte-range requests

Byte-range support is required for browser video seeking, especially with large MP4 files.

Use the project-provided server:

    cd /path/to/web-dataset
    python /path/to/wind-n-cloud/data-processing/cors_enabled_http_server.py

For example:

    cd "/Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP"
    python /path/to/wind-n-cloud/data-processing/cors_enabled_http_server.py

Or:

    python /path/to/wind-n-cloud/data-processing/cors_enabled_http_server.py \
      --directory "/Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP" \
      --port 8000

This serves the dataset at:

    http://localhost:8000/

Then open:

    http://localhost:5173/?manifest=http://localhost:8000/manifest.json

Useful sanity checks:

    http://localhost:8000/manifest.json
    http://localhost:8000/data/wind-samples.json

Both should load in the browser before opening the app.

---

## Verifying local video seeking

The local dataset server must return `206 Partial Content` for range requests.

Test with:

    curl -v \
      -H "Range: bytes=0-1023" \
      "http://localhost:8000/video/VID_20260712_105651_00_009.mp4" \
      -o /tmp/range-test.bin

Good response:

    HTTP/1.0 206 Partial Content
    Content-Range: bytes 0-1023/...
    Content-Length: 1024
    Accept-Ranges: bytes

Bad response:

    HTTP/1.0 200 OK
    Content-Length: <entire file size>

If the server returns `200 OK`, browser video seeking will not work reliably.

You can also test seeking inside the browser DevTools console:

    const v = document.querySelector("video");

    console.log("duration", v.duration);
    console.log("seekable length", v.seekable.length);

    for (let i = 0; i < v.seekable.length; i++) {
      console.log("seekable", i, v.seekable.start(i), v.seekable.end(i));
    }

    v.currentTime = 30;

    setTimeout(() => {
      console.log("currentTime after seek", v.currentTime);
    }, 1000);

Expected result:

    currentTime after seek 30

---

## Why the CORS/range-enabled server is needed

Opening this directly may work:

    http://localhost:8000/manifest.json

But the web app runs from:

    http://localhost:5173

The browser treats these as different origins because the ports are different.

So this request:

    http://localhost:5173 -> http://localhost:8000/manifest.json

requires CORS headers.

For video seeking, the browser also sends requests like:

    Range: bytes=0-1023

The server must respond with:

    206 Partial Content

The project-provided `cors_enabled_http_server.py` supports both CORS and byte ranges.

The plain Python server:

    python -m http.server 8000

is not sufficient for this app because it may ignore range requests and return the entire MP4.

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
- internal video segments;
- time-lapse mapping between race time and MP4 time.

Example shape:

    {
      "schemaVersion": 2,
      "raceId": "pacific-cup",
      "displayName": "Pacific Cup",
      "timezone": "UTC",
      "startTime": "2026-07-12T17:56:51Z",
      "endTime": "2026-07-13T23:54:51Z",
      "startTimeMs": 1783879011000,
      "endTimeMs": 1783986891000,
      "defaults": {
        "windHistoryDurationMinutes": 60,
        "availableWindHistoryDurationsMinutes": [5, 15, 30, 60, 120]
      },
      "data": {
        "windSamplesUrl": "data/wind-samples.json",
        "windSampleCount": 50400,
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
          "startTime": "2026-07-12T17:56:51Z",
          "endTime": "2026-07-13T23:54:51Z",
          "startTimeMs": 1783879011000,
          "endTimeMs": 1783986891000,
          "frameCount": 50400,
          "frameIntervalSeconds": 2.0,
          "raceDurationSeconds": 107880.0,
          "videoDurationSeconds": 1799.7998,
          "raceSecondsPerVideoSecond": 59.94,
          "videoUrl": "video/VID_20260712_105651_00_009.mp4"
        }
      ]
    }

The user interface should not display video segment IDs or file names. They are internal implementation details, though the video file name may be displayed during debugging.

---

## wind-samples.json

`wind-samples.json` contains columnar wind data optimized for browser loading.

Example shape:

    {
      "schemaVersion": 1,
      "format": "columnar",
      "count": 3,
      "time": [
        "2026-07-12T17:56:51Z",
        "2026-07-12T17:56:53Z",
        "2026-07-12T17:56:55Z"
      ],
      "timeMs": [
        1783879011000,
        1783879013000,
        1783879015000
      ],
      "twd": [
        286.0,
        287.0,
        288.0
      ],
      "tws": [
        4.6,
        4.7,
        4.8
      ],
      "twa": [
        350.0,
        352.0,
        355.0
      ],
      "heading": [
        104.0,
        104.0,
        104.0
      ]
    }

Columnar data is used because it is convenient for plotting:

    timeMs[i]
    twd[i]
    tws[i]
    twa[i]
    heading[i]

all refer to the same sample.

---

## S3 / CloudFront deployment model

The preferred deployment model is to host large race assets outside the web application bundle.

Recommended structure:

    s3://<bucket>/races/pacific-cup/
      manifest.json
      data/
        wind-samples.json
      video/
        VID_20260712_105651_00_009.mp4

A CloudFront distribution can serve these files as:

    https://assets.example.com/races/pacific-cup/manifest.json
    https://assets.example.com/races/pacific-cup/data/wind-samples.json
    https://assets.example.com/races/pacific-cup/video/VID_20260712_105651_00_009.mp4

The web application loads the manifest URL, then resolves the wind data and video URLs from it.

For production video serving, S3/CloudFront should support byte-range requests for MP4 seeking.

---

## CORS requirements for S3 or CloudFront

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

The web application is implemented as:

    Vite + React + TypeScript

Current rendering approach:

- HTML5 `<video>` for playback.
- React state for current race time and playback status.
- SVG for the B&G-style wind plot.
- D3 scales/shapes for plotting utilities.
- Future canvas overlay on top of video for wind arrows.

Current structure:

    web/
      src/
        App.tsx
        main.tsx

        components/
          RaceVideoPanel.tsx
          WindHistoryPanel.tsx
          TimelineControls.tsx

        data/
          loadRaceDataset.ts
          url.ts
          windSamples.ts

        playback/
          findSegmentForTime.ts

        styles/
          app.css

        types/
          race.ts

---

## Playback synchronization

The web app uses one central time value:

    currentRaceTimeMs

The video panel, wind plot, timeline controls, and future overlay all synchronize through that value.

Because the video is time-lapse, playback uses this mapping:

    raceOffsetSeconds = video.currentTime * raceSecondsPerVideoSecond

and:

    video.currentTime = raceOffsetSeconds / raceSecondsPerVideoSecond

When video playback advances:

    video.currentTime
      -> race offset seconds
      -> currentRaceTimeMs
      -> wind plot updates
      -> timeline controls update
      -> future overlay updates

When the user scrubs the timeline:

    selectedRaceTimeMs
      -> race offset seconds
      -> video.currentTime
      -> wind plot updates

The user sees a continuous race timeline even though the video is compressed into time-lapse playback.

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
- `TWA`
- `Heading`
- `AWA`
- `AWS`

This will allow the app to draw:

- true wind direction arrow;
- apparent wind direction arrow;
- heading reference;
- tack/side indication;
- cloud-relative annotations;
- shift/gust markers.

---

## Timezone convention

Dataset JSON uses UTC timestamps.

Example:

    2026-07-12T17:56:51Z

The web app may later provide display options for local time, boat time, or UTC, but the data interchange format should remain UTC.

---

## Development notes

The Python scripts use the Python standard library. Some functionality calls external command-line tools such as `ffprobe`.

`ffprobe` is used by:

- `extract_insv_frame_csv.py` to inspect video metadata and frame counts.
- `prepare_web_dataset.py` to inspect MP4 duration.

Install FFmpeg if needed:

    brew install ffmpeg

No Python package manager other than the project virtual environment is required.

---

## Current status

Implemented data-processing pieces:

- `extract_insv_frame_csv.py`
  - recursively scans `.insv` files;
  - processes only `VID*.insv`;
  - matches time-lapse frames to rows in the source CSV;
  - writes frame-matched CSV with `clip_name` and `time_into_clip`.

- `prepare_web_dataset.py`
  - reads the frame-matched CSV;
  - assumes matching MP4 files exist in a specified directory;
  - writes `manifest.json`;
  - writes `data/wind-samples.json`;
  - writes time-lapse mapping fields such as `raceSecondsPerVideoSecond`;
  - supports `--asset-base-url` for local or CloudFront-style output paths.

- `timestamp_gap_detector.py`
  - detects timestamp gaps above a configurable threshold.

- `cors_enabled_http_server.py`
  - serves local web datasets with CORS headers;
  - supports HTTP byte-range requests for browser video seeking.

Implemented web app pieces:

- manifest-based dataset loading;
- continuous time-based video playback;
- time-lapse-aware video/race-time mapping;
- B&G-style vertical wind history plot;
- autoscaled TWD/TWS plot ranges;
- TWD coloring by tack/side using TWA;
- TWS plotted in white;
- TWA shown next to TWD as a signed angle;
- timeline scrubber;
- local and remote dataset support.

Planned pieces:

- S3 or CloudFront production dataset hosting;
- wind overlay on top of video;
- richer wind shift analysis tools.