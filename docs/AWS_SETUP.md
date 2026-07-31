# AWS Setup Guide (CloudFormation + AWS Profile)

This project now provisions AWS resources from a single CloudFormation stack.
Credentials are selected by AWS profile name (from `~/.aws/config` / `~/.aws/credentials`).

## Prerequisites

1. AWS account with permissions for CloudFormation, IAM, S3, CloudFront.
2. AWS CLI configured with one or more profiles.
3. Python 3.8+ and `boto3`.

## 1) Verify your AWS profile

```bash
aws configure list-profiles
```

If your profile does not exist yet:

```bash
aws configure --profile devops
```

## 2) Deploy infrastructure stack

```bash
cd /Users/sergei/github/wind-n-cloud
python3 scripts/deploy_media_stack.py \
  --profile devops \
  --region us-west-2 \
  --stack-name wind-n-cloud-media \
  --project-name wind-n-cloud \
  --github-pages-domain sergei.github.io \
  --allowed-local-origin http://localhost:5173 \
  --github-org sergei \
  --github-repo wind-n-cloud \
  --github-branch master
```

The deploy script uses:
- Template: `infra/cloudformation/media-stack.yaml`
- Mode: create stack if missing, otherwise update stack
- Capability: `CAPABILITY_NAMED_IAM`

## 3) What the stack creates

- S3 bucket for media/data (versioning + CORS)
- CloudFront distribution in front of S3
- GitHub OIDC provider
- IAM role/policies for future automation or cross-account access

## 4) Use stack outputs

The script prints outputs such as:
- `BucketName`
- `CloudFrontDomainName`
- `CloudFrontDistributionId`
- `DataUploadRoleArn`
- `MediaBaseUrl`
- `DataBaseUrl`

Use these values for:
- `VITE_MEDIA_BASE_URL`
- `VITE_DATA_BASE_URL`
- optional automation or future CI integration

## 5) Video vs data uploads

- **Videos**: upload manually to `s3://<BucketName>/media/...`
- **Data files**: upload from `prepare_web_dataset.py --upload-to-s3`

Manual upload example:

```bash
aws s3 cp ./videos/race-001.mp4 s3://<BucketName>/media/videos/ --profile devops

aws s3 sync /Volumes/Elements/SailinVideos6/2026-PAC-CUP/00-WEB-APP s3://${WIND_N_CLOUD_S3_BUCKET}/media/videos/ \
  --profile sailvue \
  --exclude "*" \
  --include "*.mp4" \
  --exclude "*._*" \
  --dryrun
  
```

Data upload example:

```bash
python3 data-processing/prepare_web_dataset.py \
  --csv /path/to/insv-frame-data.csv \
  --mp4-dir /path/to/mp4-files \
  --output-dir /path/to/web-dataset \
  --asset-base-url "https://assets.example.com/races/pacific-cup" \
  --upload-to-s3 \
  --aws-profile devops \
  --s3-bucket <BucketName> \
  --cloudfront-distribution-id <CloudFrontDistributionId> \
  --invalidate-cloudfront
```

## Notes

- `scripts/setup_s3_bucket.py` is now a compatibility wrapper and is deprecated.
- Prefer `scripts/deploy_media_stack.py --profile <name>` for all infra changes.
