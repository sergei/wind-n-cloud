# wind-n-cloud

`wind-n-cloud` is a web app for correlating cloud video with sailing wind/instrument data on a single continuous race timeline.

The app is built with:
- React + TypeScript + Vite (`web/`)
- Python data-processing scripts (`data-processing/`)
- S3 + CloudFront for media/data hosting
- GitHub Pages for static site hosting

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
  --output-dir /path/to/web-dataset
```

This writes:
- `/path/to/web-dataset/manifest.json`
- `/path/to/web-dataset/data/wind-samples.json`

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

```bash
aws s3 sync /path/to/mp4-folder s3://<BucketName>/media/videos/ \
  --profile <aws-profile> \
  --exclude "*" \
  --include "*.mp4"
```

### 3) Generate and upload JSON from script

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

The workflow `.github/workflows/deploy-web.yml` builds the app and publishes it to Pages.

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
- Confirm `videoUrl` entries in manifest are CloudFront-reachable URLs.
- Verify MP4 files are uploaded to the expected S3 prefix (`media/videos/`).

---

## Notes

- `prepare_web_dataset.py` supports argument files via `@file` syntax (`fromfile_prefix_chars="@"`).
- `scripts/setup_s3_bucket.py` is a compatibility wrapper; use `scripts/deploy_media_stack.py` for infrastructure changes.
