"""
Post-deployment script for deploy-skill.

This script runs automatically after skill resources are deployed.
It creates a marker file to verify execution.
"""

import json
from datetime import datetime, timezone


def main():
    # Create a marker file to prove post_deploy.py was executed
    marker = {
        "post_deploy_executed": True,
        "executed_at": datetime.now(timezone.utc).isoformat(),
        "message": "Post-deployment completed successfully!",
    }

    with open("post_deploy_marker.json", "w") as f:
        json.dump(marker, f, indent=2)

    print("Post-deployment completed successfully!")


if __name__ == "__main__":
    main()
