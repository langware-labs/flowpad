import json
import logging
import subprocess
from functools import wraps
from pathlib import Path
from typing import Any, Callable, TypeVar

from flow_sdk.config import GOOGLE_APPLICATION_CREDENTIALS

# Type variable for decorated functions
F = TypeVar("F", bound=Callable[..., Any])

logger = logging.getLogger(__name__)


def gcp_auth(func: F) -> F:
    """
    Decorator that ensures GCP authentication before executing the function.

    This decorator:
    1. Checks if GOOGLE_APPLICATION_CREDENTIALS environment variable is set
    2. Validates the service account credentials file
    3. Runs gcloud auth activate-service-account if not already authenticated
    4. Executes the decorated function

    Args:
        func: Function to decorate

    Returns:
        Decorated function

    Raises:
        RuntimeError: If authentication fails
    """

    @wraps(func)
    def wrapper(*args, **kwargs):
        # Check if credentials environment variable is set
        credentials_path = GOOGLE_APPLICATION_CREDENTIALS
        if not credentials_path:
            raise RuntimeError("GOOGLE_APPLICATION_CREDENTIALS environment variable is not set")

        # Validate credentials file
        credentials_file = Path(credentials_path)
        if not credentials_file.exists():
            raise RuntimeError("Service account credentials file not found")

        if not credentials_file.is_file():
            raise RuntimeError("GOOGLE_APPLICATION_CREDENTIALS must point to a file, not a directory")

        # Validate JSON format
        try:
            with open(credentials_file, "r") as f:
                creds = json.load(f)
                if creds.get("type") != "service_account":
                    raise RuntimeError("Invalid service account credentials file format")
        except (json.JSONDecodeError, IOError) as e:
            raise RuntimeError(f"Failed to read service account credentials: {e}")

        # Check if already authenticated
        try:
            result = subprocess.run(
                ["gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )

            if result.returncode != 0:
                raise RuntimeError(f"gcloud authentication check failed: {result.stderr}")

            if result.stdout.strip():
                logger.debug("Already authenticated with gcloud")
            else:
                # Authenticate with service account
                logger.info(f"Authenticating with service account using {credentials_path}")
                auth_result = subprocess.run(
                    ["gcloud", "auth", "activate-service-account", "--key-file", credentials_path],
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=30,
                )

                if auth_result.returncode != 0:
                    raise RuntimeError(f"gcloud authentication failed: {auth_result.stderr}")

                logger.info("Service account authentication successful")

        except subprocess.TimeoutExpired:
            raise RuntimeError("gcloud authentication timed out")
        except FileNotFoundError:
            raise RuntimeError("gcloud CLI not found")

        # Execute the decorated function
        return func(*args, **kwargs)

    return wrapper
