# wind-n-cloud

`wind-n-cloud` is a web app for correlating cloud video with sailing wind/instrument data on a single continuous race timeline.

The app is built with:
- React + TypeScript + Vite (`web/`)
- Python data-processing scripts (`data-processing/`)
- S3 + CloudFront for media/data hosting
- GitHub Pages for static site hosting

---

## What the app shows

- **Onboard camera** and **satellite & wind** videos, synced to the race clock.
- **Wind history plots** (TWD colored by tack, TWS) for the selected history window. The header shows the
  smoothed value at the current time. The smoothing time constant is `SMOOTHING_TIME_CONSTANT_SECONDS` in
  `web/src/components/WindHistoryPanel.tsx`.
- **Time slider** with bands drawn behind it (`web/src/playback/timelineBands.ts`):
  - track color: port (red) / starboard (green) from TWA;
  - thin strip above: day / twilight / night, computed from the boat's lat/lon (`web/src/utils/sunPosition.ts`);
    hidden if the dataset has no positions;
  - hatching: no video (gaps between video segments) and no data (sample gaps or missing wind).
- Elapsed time is shown as `Dd HH:MM:SS`; clock times are shown in Pacific time.

---

## Current architecture

### Local mode
- Run the Vite app locally.
- Serve generated dataset files from a local HTTP server (with CORS/range support).
- Open the app with a manifest query parameter.

### Production mode
- Web app is deployed to GitHub Pages.
- `manifest.json`, `data/*.json`, and MP4s are served from CloudFront (backed by S3).
- MP4 files are uploaded manually.
- JSON dataset files are generated and can be uploaded directly by `prepare_web_dataset.py --upload-to-s3`.

---

## Repository layout

```text
wind-n-cloud/
  data-processing/
    extract_insv_frame_csv.py
    prepare_web_dataset.py
    timestamp_gap_detector.py
    cors_enabled_http_server.py
    sample-data/

  web/
    src/
    package.json
    vite.config.ts

  infra/cloudformation/
    media-stack.yaml
```

---

## Prerequisites

- Python 3.10+ (or compatible with project scripts)
- Node.js (for `web/`)
- FFmpeg/ffprobe for MP4 metadata extraction:

```bash
brew install ffmpeg
```

- AWS CLI configured (for Cloud workflows)

---

## Local development (recommended flow)

This is the canonical local URL flow:

`http://localhost:5173/wind-n-cloud/?manifest=http://localhost:8000/manifest.json`

### 1) Generate dataset locally

```bash
python3 data-processing/prepare_web_dataset.py \
  --csv /path/to/insv-frame-data.csv \
  --mp4-dir /path/to/mp4-files \
  --goes-dir data-processing/sample-data/goes \
  --generate-satellite-videos \
  --output-dir /path/to/web-dataset
```

Or generate satellite MP4 videos separately:

```bash
python3 data-processing/generate_satellite_videos.py \
  --manifest /path/to/web-dataset/manifest.json \
  --goes-dir data-processing/sample-data/goes \
  --output-dir /path/to/web-dataset/satellite-video
```

This writes:
- `/path/to/web-dataset/manifest.json`
- `/path/to/web-dataset/data/wind-samples.json`
- `/path/to/web-dataset/satellite-video/sat_*.mp4`

`wind-samples.json` carries `twd`, `tws`, `twa`, `heading`, `sog`, `cog`, `awa`, `aws`, `lat`, `lon`
(from the CSV columns `TWD(med)`, `TWS(med)`, `TWA(med)`, …, `Latitude`, `Longitude`).

### 2) Serve dataset files on port 8000

```bash
python3 data-processing/cors_enabled_http_server.py \
  --directory /path/to/web-dataset \
  --port 8000
```

### 3) Start the web app

```bash
cd web
npm ci
npm run dev
```

### 4) Open the app

Use exactly:

`http://localhost:5173/wind-n-cloud/?manifest=http://localhost:8000/manifest.json`

### Testing new data against real race media (without overwriting it)

The race media folder (e.g. `/Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP`) has this layout,
mirrored in S3:

```text
manifest.json
data/wind-samples.json
video/pan-000/VID_*.mp4    # camera, one folder per pan angle (pan-000, pan-120, pan-240)
video/goes/sat_VID_*.mp4   # satellite
```

The manifest stores camera URLs as `video/VID_*.mp4`. The app rewrites them to `video/pan-000/…`
(`RaceVideoPanel.tsx`). This only works for relative URLs, so keep the default `--public-video-prefix`.

To try a regenerated dataset without touching the published one:

```bash
# 1. Generate to a temporary folder (no --upload-to-s3)
python3 data-processing/prepare_web_dataset.py \
  --csv /Volumes/Elements/SailinVideos6/2026-PAC-CUP/20-DATA/clouds.csv \
  --mp4-dir /Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP/video \
  --satellite-mp4-dir /Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP/video/goes \
  --public-satellite-prefix video/goes \
  --output-dir /tmp/wnc-dataset

# 2. Serve the new data and the existing media on separate ports
python3 data-processing/cors_enabled_http_server.py --directory /tmp/wnc-dataset --port 8010
python3 data-processing/cors_enabled_http_server.py \
  --directory /Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP --port 8011

# 3. Point the app's media base at the media server
cd web && VITE_MEDIA_BASE_URL=http://localhost:8011/ npm run dev
```

Then open `http://localhost:5173/wind-n-cloud/?manifest=http://localhost:8010/manifest.json`.

---

## Cloud deployment workflow

### 1) Provision/update AWS stack

```bash
python3 scripts/deploy_media_stack.py \
  --profile <aws-profile> \
  --region us-west-2 \
  --stack-name wind-n-cloud-media
```

This provisions S3 + CloudFront + IAM resources from `infra/cloudformation/media-stack.yaml`.

### 2) Upload MP4 files (manual)

Sync the whole race media folder so the `video/pan-XXX/` and `video/goes/` layout is kept:

```bash
aws s3 sync /Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP s3://<BucketName>/ \
  --profile <aws-profile> \
  --exclude "*" --include "*.mp4" --exclude "*._*"
```

### 3) Generate and upload JSON from script

For the Pacific Cup 2026 dataset, everything is in an args file:

```bash
python3 data-processing/prepare_web_dataset.py @data-processing/args/prepare_web_dataset.txt
```

This rewrites `manifest.json` and `data/wind-samples.json` in the race media folder and uploads both to S3.
`manifest.json` is uploaded with `no-cache` and the data with `max-age=60`, so no CloudFront invalidation
is needed.

General form:

```bash
python3 data-processing/prepare_web_dataset.py \
  --csv /path/to/insv-frame-data.csv \
  --mp4-dir /path/to/mp4-files \
  --output-dir /path/to/web-dataset \
  --asset-base-url "https://<cloudfront-domain>" \
  --upload-to-s3 \
  --aws-profile <aws-profile> \
  --s3-bucket <BucketName> \
  --cloudfront-distribution-id <DistributionId> \
  --invalidate-cloudfront
```

### 4) Deploy static site to GitHub Pages

The workflow `.github/workflows/deploy-web.yml` builds the app and publishes it to Pages. It runs on
every push to `master` that touches `web/**` (or manually via workflow dispatch).

Required repository secret:
- `CLOUDFRONT_DOMAIN` (example: `d1234abcd.cloudfront.net`)

The workflow injects:
- `VITE_DEFAULT_MANIFEST_URL=https://<domain>/manifest.json`
- `VITE_MEDIA_BASE_URL=https://<domain>/media`
- `VITE_DATA_BASE_URL=https://<domain>/data`

---

## Common troubleshooting

### `Failed to load /manifest.json: 404`
- Local: open the app with the manifest query parameter URL shown above.
- Pages: ensure `CLOUDFRONT_DOMAIN` secret is set and the deploy workflow re-ran.

### CloudFront URL returns 403/404
- Confirm object exists in S3 at expected key.
- Confirm CloudFront distribution points to correct bucket/origin settings.
- If recently updated, invalidate cache.

### App loads but no video plays
- Confirm `videoUrl` entries in manifest are relative `video/VID_*.mp4` paths (the app inserts `pan-000/`).
- Verify MP4 files exist in S3 under `video/pan-000/` and `video/goes/`.

### No day/night strip on the slider
- The dataset has no positions. Regenerate it with the current `prepare_web_dataset.py` (the CSV needs
  `Latitude`/`Longitude` columns) and check that `wind-samples.json` contains `lat`/`lon`.

---

## Notes

- `prepare_web_dataset.py` supports argument files via `@file` syntax (`fromfile_prefix_chars="@"`).
- `scripts/setup_s3_bucket.py` is a compatibility wrapper; use `scripts/deploy_media_stack.py` for infrastructure changes.
