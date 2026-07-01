# Frozen-backend blob delivery — DRAFT / handoff

Goal: replace the desktop app's `uv tool install flowpad@latest` (from PyPI,
~12,200 loose files) with a **PyInstaller-frozen blob** (~2,800 files) downloaded
from a GitHub release. This cuts the Windows Defender per-file scan tax that
dominates cold install and launch.

## Why (measured on this machine)

| | loose (current) | frozen blob |
|---|---|---|
| files | 12,169 | **2,833 (−77%)** |
| write+scan (same tool, back-to-back) | 14.7s | **3.6s (~4× faster)** |
| server boots to healthy | yes | **yes (validated)** |
| upgrade (stop→swap→start) | — | 18s (harness) |

The PyPI wheel stays unchanged for CLI/dev users; only the *desktop delivery*
changes. Caveat: absolute cold numbers vary with Defender's content cache — the
77% file cut and the ~4× same-tool ratio are the reliable signals; confirm on a
clean machine/VM before shipping.

## What's DONE and validated (in-repo, real)

- `flow_sdk/server/launch.py` is **`sys.frozen`-aware** (spawns `<exe> serve` /
  `<exe> monitor`, PID markers switch to the subcommand). Non-frozen path
  unchanged; its unit tests pass. **This is the only production-code change so far.**
- Freeze recipe proven — builds, boots to healthy, monitor→server chain runs:
  ```
  pyinstaller --onedir --name flowpad-backend \
    --collect-all flow_sdk --collect-submodules flow_sdk \
    --copy-metadata flowpad --copy-metadata genai-prices \
    --copy-metadata pydantic-ai-slim --copy-metadata logfire-api \
    --hidden-import aiosqlite --collect-submodules sqlalchemy.dialects.sqlite \
    freeze-draft/freeze_entry.py
  ```

## Files in this draft (NOT wired in, NOT tested in electron/CI)

- `freeze_entry.py` — the frozen entry (validated).
- `build-backend-blob.yml` — CI job: freeze + sign + publish the blob as a release asset.
- `blob-manager.js` — drop-in alternative to `electron/uv-manager.js` that
  downloads/installs/upgrades/starts the blob. Versioned dirs + atomic `current`
  pointer ⇒ upgrades never overwrite the running exe, so the Windows file-lock
  problem (uv-manager's `--force` + lock-retry) can't occur.

## Remaining work to ship

1. **Flush feature-level hidden imports.** `/health` boots, but exercising real
   features (agentic workers, PTY, MCP, cloud sync, keychain, UI serving) will
   surface more `--hidden-import` / `--collect-data` entries. Add them to the CI
   freeze step, driven by running the app. (This needs the real app; can't be
   done headless.)
2. **Wire `blob-manager.js` into `main.js`.** Copy `UvManager.start()`'s env
   block into `BlobManager._buildEnv()` (PATH, SOD_ENC_KEY from keychain, port,
   DEPLOY_ENV=desktop). Keep uv-manager as a fallback behind a flag until the
   blob path is proven.
3. **Verify + sign the download.** Ship a SHA256 with the release; verify it (and
   Authenticode-verify the exe) before trusting an extracted blob.
4. **Per-OS CI.** Add macOS (codesign + notarize) and Linux freeze jobs.
5. **Your local acceptance test:** `bash ~/flowpad-blob-harness.sh` installs +
   upgrades the frozen blob on this machine and prints the times — run it against
   a real signed blob before shipping.

## How to test locally now

- Freeze: run the recipe above (needs a venv with flowpad + pyinstaller).
- Install/upgrade + timing harness: `~/flowpad-blob-harness.sh`.
