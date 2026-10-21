# wind-n-cloud Operations Runbook

## Routine tasks

### Deploy or update AWS infrastructure

```bash
python3 scripts/deploy_media_stack.py \
  --profile devops \
  --region us-west-2 \
  --stack-name wind-n-cloud-media
```

### Upload videos manually

```bash
aws s3 sync /Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP \
 s3://${WIND_N_CLOUD_S3_BUCKET}/   --profile sailvue   \
 --exclude "*"   --include "*.mp4"   --exclude "*._*"   


```

### Upload data files

```bash
python3 data-processing/prepare_web_dataset.py @data-processing/args/prepare_web_dataset.txt
```

- This regenerates `manifest.json` and `data/wind-samples.json` in the race media folder and uploads both
  with `--upload-to-s3`.
- The manifest is uploaded `no-cache` and the data `max-age=60`, so no CloudFront invalidation is needed.

### Deploy the web app

Push to `master`. The `Deploy web app` workflow runs for changes under `web/**`.

## Rollback

### App deployment rollback

1. Re-run the previous successful GitHub Pages deployment from Actions.
2. If needed, revert the last web commit and push again.

### AWS rollback

1. Re-run `scripts/deploy_media_stack.py` with the last known-good template.
2. If a stack update failed, inspect CloudFormation events and retry after fixing the template.

## Health checks

- Verify the GitHub Pages site loads.
- Confirm `manifest.json` is reachable from the CloudFront domain.
- Confirm `data/wind-samples.json` is reachable from CloudFront.
- Confirm a manually uploaded MP4 is reachable through CloudFront.

## Troubleshooting

- **403 from S3/CloudFront**: check the CloudFront distribution, bucket policy, and OAC settings.
- **Missing data**: confirm `prepare_web_dataset.py --upload-to-s3` ran and the bucket contains the JSON files.
- **Wrong manifest URL**: confirm `VITE_DEFAULT_MANIFEST_URL` points to the CloudFront manifest.
