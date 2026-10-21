---
name: wind-n-cloud-ops
description: How to test the wind-n-cloud web app locally against real race data, regenerate and deploy the dataset to S3, and deploy the web app. Use when asked to run/test the app locally, regenerate or upload wind-samples.json / manifest.json, deploy, or check a deploy.
---

# wind-n-cloud: local testing and deployment

Paths below are for the Pacific Cup 2026 race. The race media folder is
`/Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP` (external drive; check it's mounted).

## Layout (local media folder and S3 bucket are mirrors)

```text
manifest.json
data/wind-samples.json
video/pan-000/VID_*.mp4   (also pan-120, pan-240)
video/goes/sat_VID_*.mp4
```

- The manifest stores camera URLs as relative `video/VID_*.mp4`. `RaceVideoPanel.tsx` rewrites
  them to `video/pan-000/…`, and that rewrite only matches relative URLs. Never generate absolute
  `--public-video-prefix` URLs.
- The source CSV is `/Volumes/Elements/SailinVideos6/2026-PAC-CUP/20-DATA/clouds.csv`. It is the
  frame-matched CSV and passes through all instrument columns, including `Latitude` and `Longitude`.

## Test new data or code locally (don't overwrite the published dataset)

1. Generate to a scratch folder, with no upload:
   ```bash
   D=/Volumes/Elements/SailinVideos6/2026-PAC-CUP
   python3 data-processing/prepare_web_dataset.py --csv $D/20-DATA/clouds.csv \
     --mp4-dir $D/00-WEB-APP/video --satellite-mp4-dir $D/00-WEB-APP/video/goes \
     --public-satellite-prefix video/goes --output-dir <scratch>/wnc-dataset
   ```
2. Start these as background tasks:
   - `python3 data-processing/cors_enabled_http_server.py --directory <scratch>/wnc-dataset --port 8010`
   - `python3 data-processing/cors_enabled_http_server.py --directory $D/00-WEB-APP --port 8011`
   - `cd web && VITE_MEDIA_BASE_URL=http://localhost:8011/ npx vite --port 5173 --strictPort`
3. Give the user this URL: `http://localhost:5173/wind-n-cloud/?manifest=http://localhost:8010/manifest.json`.
   Shared links can also add `&t=2026-07-14T03:00:00Z`.
4. Stop the servers when the user is done. Port 8000 is usually taken by the user's own `http.server`;
   leave it alone.

For a code-only change, you can skip step 1 and serve the published media folder itself on 8010.

To self-check visually, take a headless Chrome screenshot and crop it with `sips`:
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=1280,1000 --virtual-time-budget=10000 \
  --screenshot=<scratch>/shot.png "<app url>"
```
Headless Chrome won't render narrower than about 500 px, so a cut-off layout at 390 px is not a real bug.

## Deploy

Confirm with the user first; both steps publish.

- **Data:** `python3 data-processing/prepare_web_dataset.py @data-processing/args/prepare_web_dataset.txt`
  - It rewrites `manifest.json` and `data/wind-samples.json` in the media folder and uploads them
    to S3 (`--aws-profile=sailvue`).
  - No CloudFront invalidation is needed: the manifest is uploaded `no-cache` and the data `max-age=60`.
  - Verify with
    `aws s3 cp --profile sailvue s3://wind-n-cloud-media-992382765816-us-east-1/manifest.json -`
    and check `data.fields` and the `videoUrl` paths.
- **Web app:** commit and push to `master`. The `Deploy web app` workflow runs for `web/**` changes.
  Check it with
  `gh api "repos/sergei/wind-n-cloud/actions/runs?per_page=1"`, piping the output through python
  to read `.workflow_runs[0]`. The installed `gh` is old: it has no `gh run` and no `--jq`.
- **Videos** are uploaded manually with `aws s3 sync` (see `docs/OPERATIONS.md`).

## Where things live in the code

- Smoothing time constant: `SMOOTHING_TIME_CONSTANT_SECONDS` in `web/src/components/WindHistoryPanel.tsx`.
  The filter is forward-backward (zero-lag), so it looks ahead by about one time constant.
- Slider bands (tack, daylight, gaps): `web/src/playback/timelineBands.ts`; rendering is in
  `TimelineControls.tsx`; colors are in `web/src/styles/app.css`.
- Sun elevation: `web/src/utils/sunPosition.ts` (NOAA approximation).
- Port/starboard rule: `getTackFromTwa` in `web/src/data/windSamples.ts` (TWA > 180 means port).
- Dataset generation: `data-processing/prepare_web_dataset.py`. When adding a field, update
  `read_frame_csv`, `build_wind_samples`, `build_manifest` `data.fields`, and `WindSamplesColumnar`
  in `web/src/types/race.ts`.
- Build check: `cd web && npm run build` (runs `tsc`). There are no tests.
