"""
Post-deployment script for webapp skill.

Installs both Python and npm dependencies after deployment.
Cross-platform compatible (works on Linux, macOS, Windows).
"""

import subprocess
import sys
from pathlib import Path


def run_command(cmd: list[str], cwd: str | None = None, description: str = "") -> bool:
    """Run a command and return success status."""
    print(f"Running: {' '.join(cmd)}" + (f" in {cwd}" if cwd else ""))
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
        )
        if result.returncode != 0:
            print(f"Error {description}: {result.stderr}")
            return False
        if result.stdout:
            print(result.stdout)
        return True
    except subprocess.TimeoutExpired:
        print(f"Timeout {description}")
        return False
    except Exception as e:
        print(f"Exception {description}: {e}")
        return False


def install_python_deps() -> bool:
    """Install Python dependencies from backend/requirements.txt."""
    backend_dir = Path("backend")
    requirements = backend_dir / "requirements.txt"

    if not requirements.exists():
        print("No backend/requirements.txt found, skipping Python deps")
        return True

    print("\n=== Installing Python dependencies ===")

    # Try pip install
    cmd = [sys.executable, "-m", "pip", "install", "-r", str(requirements)]
    return run_command(cmd, description="installing Python dependencies")


def install_npm_deps() -> bool:
    """Install npm dependencies from frontend/package.json."""
    frontend_dir = Path("frontend")
    package_json = frontend_dir / "package.json"

    if not package_json.exists():
        print("No frontend/package.json found, skipping npm deps")
        return True

    print("\n=== Installing npm dependencies ===")

    # Check if npm is available
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"

    return run_command(
        [npm_cmd, "install"],
        cwd=str(frontend_dir),
        description="installing npm dependencies",
    )


def main():
    print("=" * 50)
    print("Webapp Post-Deployment Script")
    print("=" * 50)

    success = True

    # Install Python dependencies
    if not install_python_deps():
        print("Warning: Python dependency installation failed")
        success = False

    # Install npm dependencies
    if not install_npm_deps():
        print("Warning: npm dependency installation failed")
        success = False

    print("\n" + "=" * 50)
    if success:
        print("Post-deployment completed successfully!")
    else:
        print("Post-deployment completed with warnings")
    print("=" * 50)

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
