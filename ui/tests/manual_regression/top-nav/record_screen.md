# Record screen from the top bar

**Category:** top-nav
**Needs:** a dedicated instance (`scripts/instance_ctl.sh launch rec-2`), never the user's dev backend.

## What this covers

The Record button left of Share in the top nav bar: a click starts a screen recording
(`getDisplayMedia`, video only), a second click stops it, the WebM lands in Flowpad's
recordings temp folder, and the "Recording ready" dialog offers Share (the standard
share-to-conversation dialog, with the recording as the file) or Save to project
(the file moves under `<project>/recordings/`).

Only the OS picker is stood in for: the test's init script answers `getDisplayMedia` with a
canvas `captureStream()`, a real MediaStream, so MediaRecorder, the upload, the dialog, the
share and the move are all real. Headless Chromium has no screen to capture, and
whole-screen capture would need the macOS Screen Recording grant for the Playwright binary;
the desktop walk (Electron, the real picker) is the manual check for that half.

## Scenario

1. Open the home dock. The bar shows the Record button (`top-nav-record-screen`)
   **before** the Share button in document order.
2. Click Record. The button turns into the recording state (`data-recording="true"`)
   with an elapsed time.
3. After about two seconds click it again. The "Recording ready" dialog opens with a
   file named `screen-<ISO stamp>.webm`; the file exists on disk under
   `<FLOWPAD_TEMP_DIR>/<instance>/recordings/` (asked of the backend's
   `recording-folder` action, never guessed).
4. Click Save to project. The dialog loses Save and keeps Share; the file now sits under
   the project's `recordings/` folder on disk and is gone from the temp folder; a toast
   names the project path with an Open link.
5. Click Share. The standard share dialog opens (a project file's first share offers to
   link the project to the cloud; Skip it) and its asset chip names the `.webm`.
   Cancel it: the flow ends (no dialog left, the bar's button is back to Record).

## Run

```bash
scripts/instance_ctl.sh launch rec-2
cd ui && FLOW_INSTANCE=rec-2 VITE_PORT=<rec-2 frontend port> npx playwright test \
  --config=tests/manual_regression/top-nav/playwright.config.ts tests/manual_regression/top-nav/record_screen.md.ts
```
