'use strict';

/*
 * macOS App Translocation: an app downloaded from the internet and launched from anywhere but
 * /Applications (Downloads, the mounted .dmg) is run by Gatekeeper from a randomised, READ-ONLY copy under
 * .../AppTranslocation/<uuid>/d/<App>.app. From there the app cannot update itself (Squirrel.Mac cannot
 * replace a translocated bundle), and its path changes on every launch. Found in a real user log
 * (2026-09-30): `file:///private/var/folders/…/AppTranslocation/60DD…/d/Flowpad.app/…/loading.html`.
 *
 * The remedy is one gesture: move the app to /Applications. Electron does it for us
 * (app.moveToApplicationsFolder — copies, relaunches from there). We only ASK, once per app version, and only
 * when the location is definitely transient. Nothing here runs off macOS.
 *
 * Electron's own dependencies are injected so the decision and the flow are unit-testable.
 */

/** True for a path Gatekeeper or the OS runs the app from temporarily: AppTranslocation, or a mounted disk image. */
function isTransientLocation(execPath) {
  const p = String(execPath || '');
  return /\/AppTranslocation\//.test(p) || /^\/Volumes\//.test(p);
}

/**
 * @returns {{offer: boolean, reason: string}}
 */
function shouldOfferMove({ platform, isPackaged, execPath, isInApplicationsFolder, offeredForVersion, version }) {
  if (platform !== 'darwin') return { offer: false, reason: 'not macOS' };
  if (!isPackaged) return { offer: false, reason: 'not a packaged app' };
  if (!isTransientLocation(execPath)) return { offer: false, reason: 'not a transient location' };
  if (isInApplicationsFolder === true) return { offer: false, reason: 'already in the Applications folder' };
  if (offeredForVersion && offeredForVersion === version) return { offer: false, reason: `already asked for ${version}` };
  return { offer: true, reason: 'running from a transient location' };
}

/**
 * Ask the user (once per version) to move the app to /Applications, and do it if they agree.
 * Resolves to 'skipped' | 'declined' | 'cancelled' | 'failed' — or never, when the move succeeds, because
 * Electron quits and relaunches the app from /Applications.
 *
 * @param {object} deps
 * @param {NodeJS.Platform} deps.platform
 * @param {{ getVersion(): string, isPackaged: boolean, isInApplicationsFolder?: () => boolean,
 *           moveToApplicationsFolder(opts?: object): boolean }} deps.app
 * @param {{ showMessageBox(opts: object): Promise<{response: number}>, showErrorBox?: Function }} deps.dialog
 * @param {string} deps.execPath
 * @param {() => ({offeredFor?: string}|null)} deps.readState
 * @param {(state: object) => void} deps.writeState
 * @param {{info: Function, warn: Function}} deps.log
 */
async function offerMoveToApplications({ platform, app, dialog, execPath, readState, writeState, log }) {
  const state = (() => { try { return readState() || {}; } catch { return {}; } })();
  const decision = shouldOfferMove({
    platform,
    isPackaged: app.isPackaged,
    execPath,
    isInApplicationsFolder: typeof app.isInApplicationsFolder === 'function' ? app.isInApplicationsFolder() : undefined,
    offeredForVersion: state.offeredFor,
    version: app.getVersion(),
  });
  if (isTransientLocation(execPath) && platform === 'darwin') {
    // Always worth a line: it explains a whole class of "why does auto-update not work for this user".
    log.info(`[location] running from a transient path (${execPath}) — ${decision.offer ? 'offering to move to Applications' : decision.reason}`);
  }
  if (!decision.offer) return 'skipped';

  // Record BEFORE asking: a crash or quit mid-dialog must not turn into a prompt on every launch.
  try { writeState({ offeredFor: app.getVersion() }); } catch (err) { log.warn(`[location] could not record the prompt: ${err.message}`); }

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Move Flowpad to Applications?',
    message: 'Flowpad is running from a temporary location.',
    detail:
      'macOS runs apps downloaded from the internet from a temporary, read-only copy until they are moved to the ' +
      'Applications folder. From there Flowpad cannot update itself.\n\nMove it now? Flowpad will restart.',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    log.info('[location] the user chose not to move the app');
    return 'declined';
  }
  try {
    const moved = app.moveToApplicationsFolder({
      // 'exists': an old copy is there, not running — replace it. 'existsAndRunning': never replace a running app.
      conflictHandler: (conflictType) => conflictType === 'exists',
    });
    if (moved) return 'skipped'; // unreachable in practice: the app has already been told to relaunch
    log.info('[location] the move was cancelled (authorisation refused or an app already running there)');
    return 'cancelled';
  } catch (err) {
    log.warn(`[location] moving to Applications failed: ${err.message}`);
    try {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Could not move Flowpad',
        message: 'Flowpad could not move itself to the Applications folder.',
        detail: `${err.message}\n\nDrag Flowpad.app into the Applications folder yourself, then open it from there.`,
        buttons: ['OK'],
      });
    } catch { /* nothing more to do */ }
    return 'failed';
  }
}

module.exports = { isTransientLocation, shouldOfferMove, offerMoveToApplications };
