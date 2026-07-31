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
aws s3 cp ./videos/race-001.mp4 s3://<BucketName>/media/videos/ --profile devops
aws s3 sync video s3://<BucketName>/media/videos/ \
  --profile <aws-profile> \
  --exclude "*" \
  --include "*.mp4" \
  --dryrun


```

### Upload data files

- Generate and upload the dataset with `prepare_web_dataset.py --upload-to-s3`.
- Use `--aws-profile`, `--s3-bucket`, and optionally `--cloudfront-distribution-id`.

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
- **Missing data**: confirm the upload workflow ran and the bucket contains the JSON files.
- **Missing data**: confirm `prepare_web_dataset.py --upload-to-s3` ran and the bucket contains the JSON files.
- **Wrong manifest URL**: confirm `VITE_DEFAULT_MANIFEST_URL` points to the CloudFront manifest.
