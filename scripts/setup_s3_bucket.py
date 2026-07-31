#!/usr/bin/env python3
"""Backward-compatible wrapper for CloudFormation-based media stack deployment."""

from __future__ import annotations

import pathlib
import subprocess
import sys


def main() -> int:
    print(
        "setup_s3_bucket.py is deprecated. Use scripts/deploy_media_stack.py "
        "with --profile to deploy the CloudFormation stack."
    )
    print("Example:")
    print(
        "  python3 scripts/deploy_media_stack.py "
        "--profile <aws-profile> --stack-name wind-n-cloud-media"
    )

    profile = None
    if "--profile" in sys.argv:
        index = sys.argv.index("--profile")
        if index + 1 < len(sys.argv):
            profile = sys.argv[index + 1]
    if profile is None:
        print("\nNo profile provided. Exiting without deployment.")
        return 0

    deploy_script = pathlib.Path(__file__).with_name("deploy_media_stack.py")
    cmd = [
        sys.executable,
        str(deploy_script),
        "--profile",
        profile,
    ]
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
