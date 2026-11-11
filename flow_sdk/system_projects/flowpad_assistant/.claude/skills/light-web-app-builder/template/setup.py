#!/usr/bin/env python3
"""One-shot setup. Run as-is from the app folder:  python3 setup.py

Creates .venv and installs requirements.txt into it. The venv can see the packages the
machine's Python already has (--system-site-packages), so where FastAPI is already
installed — a Flowpad sandbox — there is nothing to download. Safe to re-run.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
PYTHON = VENV / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def main() -> int:
    if sys.version_info < (3, 10):
        print(f"Python 3.10+ is needed, this is {sys.version.split()[0]}")
        return 1
    if not PYTHON.exists():
        print("Creating .venv ...")
        subprocess.run([sys.executable, "-m", "venv", "--system-site-packages", str(VENV)], check=True)
    print("Installing requirements ...")
    result = subprocess.run(
        [str(PYTHON), "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", str(ROOT / "requirements.txt")]
    )
    if result.returncode != 0:
        return result.returncode
    (ROOT / "data").mkdir(exist_ok=True)
    print("Ready. Flowpad starts the app from webapp.json.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
