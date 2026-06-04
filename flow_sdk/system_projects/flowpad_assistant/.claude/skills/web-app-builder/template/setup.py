#!/usr/bin/env python3
"""One-shot project setup. Run as-is from the project root:

    python3 setup.py

Idempotent: safe to re-run after fixing a failed step. It streams each
command's output so you can watch progress; nothing is hidden or truncated.

Steps:
  1. verify node / npm / python versions
  2. npm install            (frontend/)
  3. create backend/.venv + install requirements (prefers `uv`, falls back
     to python -m venv + pip)
  4. copy .env.example -> frontend/.env.local and backend/.env (if missing)
  5. report Supabase CLI availability and next steps
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"
BACKEND = ROOT / "backend"

IS_WIN = sys.platform == "win32"
NPM = "npm.cmd" if IS_WIN else "npm"


def run(cmd: list[str], cwd: Path | None = None) -> bool:
    """Run a command, streaming its output. Returns True on exit code 0."""
    where = f" (in {cwd.relative_to(ROOT)})" if cwd and cwd != ROOT else ""
    print(f"\n$ {' '.join(cmd)}{where}")
    try:
        return subprocess.run(cmd, cwd=cwd).returncode == 0
    except FileNotFoundError:
        print(f"  command not found: {cmd[0]}")
        return False


def tool_version(tool: str, args: list[str] | None = None) -> str | None:
    """Return the first version-looking token of `tool --version`, or None."""
    exe = shutil.which(tool)
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, *(args or ["--version"])], capture_output=True, text=True
        ).stdout.strip()
    except OSError:
        return None
    match = re.search(r"\d+(\.\d+)+", out)
    return match.group(0) if match else out or "?"


def check_prerequisites() -> bool:
    print("=== 1/5 Prerequisites ===")
    ok = True

    node = tool_version("node")
    if node is None:
        print("  ✗ node not found — install Node.js >= 20 (https://nodejs.org)")
        ok = False
    else:
        major = int(node.split(".")[0])
        flag = "✓" if major >= 20 else "✗ (need >= 20)"
        print(f"  {flag} node {node}")
        ok = ok and major >= 20

    npm = tool_version(NPM)
    print(f"  {'✓' if npm else '✗'} npm {npm or 'not found'}")
    ok = ok and npm is not None

    py = sys.version_info
    py_ok = py >= (3, 11)
    print(f"  {'✓' if py_ok else '✗ (need >= 3.11)'} python {py.major}.{py.minor}.{py.micro}")
    ok = ok and py_ok
    return ok


def install_frontend() -> bool:
    print("\n=== 2/5 Frontend dependencies ===")
    return run([NPM, "install"], cwd=FRONTEND)


def install_backend() -> bool:
    print("\n=== 3/5 Backend virtualenv + dependencies ===")
    venv = BACKEND / ".venv"
    requirements = BACKEND / "requirements.txt"

    if shutil.which("uv"):
        # Pin the venv to the interpreter we just verified in prerequisites —
        # uv's own default may pick a newer Python than the deps support.
        if not venv.exists() and not run(
            ["uv", "venv", "--python", sys.executable, str(venv)]
        ):
            return False
        return run(
            ["uv", "pip", "install", "-r", str(requirements), "--python",
             str(venv / ("Scripts" if IS_WIN else "bin") / "python")]
        )

    if not venv.exists() and not run([sys.executable, "-m", "venv", str(venv)]):
        return False
    pip = venv / ("Scripts" if IS_WIN else "bin") / "pip"
    return run([str(pip), "install", "-r", str(requirements)])


def materialize_env_files() -> bool:
    print("\n=== 4/5 Environment files ===")
    example = ROOT / ".env.example"
    if not example.exists():
        print("  ✗ .env.example missing — template incomplete?")
        return False
    for target in (FRONTEND / ".env.local", BACKEND / ".env"):
        if target.exists():
            print(f"  = {target.relative_to(ROOT)} already exists, left untouched")
        else:
            shutil.copyfile(example, target)
            print(f"  + {target.relative_to(ROOT)} created from .env.example")
    return True


def report_supabase() -> None:
    print("\n=== 5/5 Supabase (local database) ===")
    version = tool_version("supabase")
    if version:
        print(f"  ✓ supabase CLI {version}")
        print("    start it when you need the DB:  supabase start")
        print("    then paste the printed anon key into frontend/.env.local")
        print("    and apply the schema:           supabase db reset")
    else:
        print("  - supabase CLI not installed (optional — app runs without it)")
        print("    install: brew install supabase/tap/supabase  (needs Docker)")


def verify_template_structure() -> bool:
    """Catch a partial/misplaced copy before doing any work."""
    missing = [
        p.relative_to(ROOT)
        for p in (FRONTEND / "package.json", BACKEND / "requirements.txt")
        if not p.exists()
    ]
    if missing:
        print("ERROR: template incomplete next to setup.py — missing: "
              + ", ".join(str(m) for m in missing))
        print("Re-copy the template as-is (cp -R <skill>/template/. <target>/).")
        return False
    return True


def main() -> int:
    print("Web App Template Setup")
    print("=" * 50)

    if not verify_template_structure():
        return 1

    if not check_prerequisites():
        print("\nFix the prerequisites above, then re-run: python3 setup.py")
        return 1

    ok = True
    ok &= install_frontend()
    ok &= install_backend()
    ok &= materialize_env_files()
    report_supabase()

    print("\n" + "=" * 50)
    if ok:
        print("Setup complete. Start the app:")
        print("  cd backend  && .venv/bin/uvicorn main:app --reload --port 8080")
        print("  cd frontend && npm run dev      # http://localhost:3000")
    else:
        print("Setup finished WITH ERRORS — see output above, fix, re-run.")
    print("=" * 50)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
