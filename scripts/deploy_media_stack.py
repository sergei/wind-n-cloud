#!/usr/bin/env python3
"""Deploy or update wind-n-cloud AWS media infrastructure via CloudFormation.

This script uses a named AWS profile so credentials do not need to be typed.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
from typing import Dict, List

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        fromfile_prefix_chars="@",
        description="Create/update S3 + CloudFront + IAM stack from CloudFormation template."
    )
    parser.add_argument("--profile", required=True, help="AWS profile from ~/.aws/config.")
    parser.add_argument("--region", default="us-west-2", help="AWS region (default: us-west-2).")
    parser.add_argument(
        "--stack-name", default="wind-n-cloud-media", help="CloudFormation stack name."
    )
    parser.add_argument("--project-name", default="wind-n-cloud", help="Project name prefix.")
    parser.add_argument(
        "--github-pages-domain", default="sergei.github.io", help="GitHub Pages domain."
    )
    parser.add_argument(
        "--allowed-local-origin",
        default="http://localhost:5173",
        help="Local dev origin for S3 CORS.",
    )
    parser.add_argument("--github-org", default="sergei", help="GitHub organization or user.")
    parser.add_argument("--github-repo", default="wind-n-cloud", help="GitHub repository name.")
    parser.add_argument("--github-branch", default="master", help="Git branch for OIDC trust.")
    parser.add_argument(
        "--template",
        default="infra/cloudformation/media-stack.yaml",
        help="Path to CloudFormation template.",
    )
    return parser.parse_args()


def read_template(template_path: str) -> str:
    path = pathlib.Path(template_path)
    if not path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")
    return path.read_text(encoding="utf-8")


def make_parameters(args: argparse.Namespace) -> List[Dict[str, str]]:
    return [
        {"ParameterKey": "ProjectName", "ParameterValue": args.project_name},
        {"ParameterKey": "GitHubPagesDomain", "ParameterValue": args.github_pages_domain},
        {"ParameterKey": "AllowedLocalOrigin", "ParameterValue": args.allowed_local_origin},
        {"ParameterKey": "GitHubOrg", "ParameterValue": args.github_org},
        {"ParameterKey": "GitHubRepo", "ParameterValue": args.github_repo},
        {"ParameterKey": "GitHubBranch", "ParameterValue": args.github_branch},
    ]


def stack_exists(cfn_client, stack_name: str) -> bool:
    try:
        cfn_client.describe_stacks(StackName=stack_name)
        return True
    except Exception as exc:
        message = str(exc)
        if "does not exist" in message:
            return False
        raise


def wait_for_completion(cfn_client, stack_name: str, is_create: bool) -> None:
    waiter_name = "stack_create_complete" if is_create else "stack_update_complete"
    waiter = cfn_client.get_waiter(waiter_name)
    waiter.wait(StackName=stack_name)


def print_outputs(cfn_client, stack_name: str) -> None:
    response = cfn_client.describe_stacks(StackName=stack_name)
    stack = response["Stacks"][0]
    outputs = stack.get("Outputs", [])
    if not outputs:
        print("No stack outputs found.")
        return

    output_map = {item["OutputKey"]: item["OutputValue"] for item in outputs}
    print("\nStack outputs:")
    for key in sorted(output_map):
        print(f"  {key}={output_map[key]}")

    print("\nSuggested web env values:")
    if "MediaBaseUrl" in output_map:
        print(f"  VITE_MEDIA_BASE_URL={output_map['MediaBaseUrl']}")
    if "DataBaseUrl" in output_map:
        print(f"  VITE_DATA_BASE_URL={output_map['DataBaseUrl']}")
    if "DataUploadRoleArn" in output_map:
        print(f"  AWS_ROLE_TO_ASSUME={output_map['DataUploadRoleArn']}")


def main() -> int:
    args = parse_args()
    try:
        import boto3
    except ModuleNotFoundError:
        print("boto3/botocore are required. Install boto3 in your Python environment first.")
        return 1

    try:
        session = boto3.Session(profile_name=args.profile, region_name=args.region)
    except Exception as exc:
        if "The config profile" not in str(exc) and "ProfileNotFound" not in str(exc):
            raise
        print(f"Profile '{args.profile}' not found. Check ~/.aws/config and ~/.aws/credentials.")
        return 1

    cfn_client = session.client("cloudformation")
    template_body = read_template(args.template)
    parameters = make_parameters(args)

    try:
        if stack_exists(cfn_client, args.stack_name):
            print(f"Updating stack '{args.stack_name}' with profile '{args.profile}'...")
            try:
                cfn_client.update_stack(
                    StackName=args.stack_name,
                    TemplateBody=template_body,
                    Parameters=parameters,
                    Capabilities=["CAPABILITY_NAMED_IAM"],
                )
                wait_for_completion(cfn_client, args.stack_name, is_create=False)
                print("Stack update complete.")
            except Exception as exc:
                if "No updates are to be performed" in str(exc):
                    print("No stack updates were needed.")
                else:
                    raise
        else:
            print(f"Creating stack '{args.stack_name}' with profile '{args.profile}'...")
            cfn_client.create_stack(
                StackName=args.stack_name,
                TemplateBody=template_body,
                Parameters=parameters,
                Capabilities=["CAPABILITY_NAMED_IAM"],
            )
            wait_for_completion(cfn_client, args.stack_name, is_create=True)
            print("Stack creation complete.")

        print_outputs(cfn_client, args.stack_name)
        return 0
    except Exception as exc:
        print(f"Failed to deploy stack: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
