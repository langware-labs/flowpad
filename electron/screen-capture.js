'use strict';

/*
 * Screen recording for the renderer's `getDisplayMedia`.
 *
 * Chromium refuses display capture inside Electron until the session answers it, so
 * `installScreenCapture` gives the default session a display-media handler (the whole
 * screen, through the OS picker where there is one). Permissions keep Electron's default
 * (every request granted), so the voice call's microphone is untouched.
 *
 * macOS grants Screen Recording per app, once, in System Settings; the app cannot grant it
 * to itself and cannot re-prompt after a refusal. `screenCaptureStatus` reads that grant and
 * `SCREEN_RECORDING_SETTINGS_URL` deep-links the pane the person has to open.
 */

const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * The display-media answer: the first whole-screen source. Returns null when there is
 * none (a headless box), which Chromium turns into a `NotFoundError` in the page. No
 * thumbnails: nothing shows them, and each one is a screen grab per display.
 */
async function pickScreenSource(desktopCapturer) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  return sources && sources.length ? sources[0] : null;
}

function installScreenCapture(session, desktopCapturer, log) {
  const handler = (_request, callback) => {
    pickScreenSource(desktopCapturer).then(
      (source) => callback(source ? { video: source } : {}),
      (err) => {
        if (log) log.warn(`[screen-capture] no screen source: ${err && err.message}`);
        callback({});
      },
    );
  };
  // The system picker (macOS 15+) lets the person choose the screen themselves and spares the
  // periodic re-approval Sequoia asks of apps that take the screen without it.
  session.setDisplayMediaRequestHandler(handler, { useSystemPicker: true });
  return handler;
}

/** 'granted' | 'denied' | 'not-determined' | 'restricted' — macOS only; every other OS needs no grant. */
function screenCaptureStatus(systemPreferences, platform) {
  if (platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'not-determined';
  }
}

module.exports = { installScreenCapture, screenCaptureStatus, SCREEN_RECORDING_SETTINGS_URL };
