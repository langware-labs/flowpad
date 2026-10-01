'use strict';

/*
 * Tests for ./app-location.js — macOS App Translocation detection and the "move to Applications" offer.
 * Run: `node electron/app-location.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { isTransientLocation, shouldOfferMove, offerMoveToApplications } = require('./app-location');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

const TRANSLOCATED = '/private/var/folders/ks/z4w5srgs599939nc7hrwyldh0000gn/T/AppTranslocation/60DD7813-39EC-4F85-893E-F714B4E11BC7/d/Flowpad.app/Contents/MacOS/Flowpad'; // shape from a real user log
const DMG = '/Volumes/Flowpad 0.2.47/Flowpad.app/Contents/MacOS/Flowpad';
const APPS = '/Applications/Flowpad.app/Contents/MacOS/Flowpad';

// ── detection ───────────────────────────────────────────────────────────────
eq(isTransientLocation(TRANSLOCATED), true, 'the real AppTranslocation path is transient');
eq(isTransientLocation(DMG), true, 'running straight from a mounted disk image is transient');
eq(isTransientLocation(APPS), false, '/Applications is not');
eq(isTransientLocation('/Users/x/Applications/Flowpad.app/Contents/MacOS/Flowpad'), false, '~/Applications is not');
eq(isTransientLocation('/Users/x/Downloads/Flowpad.app/Contents/MacOS/Flowpad'), false, 'a plain folder (not translocated) is left alone');
eq(isTransientLocation('C:\\Users\\x\\AppData\\Local\\Programs\\Flowpad\\Flowpad.exe'), false, 'a Windows path is not');
eq(isTransientLocation(undefined), false, 'undefined tolerated');

// ── decision ────────────────────────────────────────────────────────────────
const base = { platform: 'darwin', isPackaged: true, execPath: TRANSLOCATED, isInApplicationsFolder: false, offeredForVersion: null, version: '0.2.47' };
eq(shouldOfferMove(base).offer, true, 'macOS + packaged + translocated + not asked yet → offer');
eq(shouldOfferMove({ ...base, platform: 'win32' }).offer, false, 'never off macOS');
eq(shouldOfferMove({ ...base, platform: 'linux' }).offer, false, 'never on Linux');
eq(shouldOfferMove({ ...base, isPackaged: false }).offer, false, 'never in a dev run');
eq(shouldOfferMove({ ...base, execPath: APPS }).offer, false, 'not when already in /Applications');
eq(shouldOfferMove({ ...base, isInApplicationsFolder: true }).offer, false, 'Electron says it is in Applications → no');
eq(shouldOfferMove({ ...base, offeredForVersion: '0.2.47' }).offer, false, 'asked for this version already → no nagging');
eq(shouldOfferMove({ ...base, offeredForVersion: '0.2.46' }).offer, true, 'a new version asks again');

// ── the flow, with fakes ────────────────────────────────────────────────────
const silent = { info() {}, warn() {} };
function harness({ response = 0, moveResult = true, moveThrows = null, state = null, platform = 'darwin', execPath = TRANSLOCATED, inApplications = false } = {}) {
  const h = { dialogs: [], moves: [], written: [], conflict: null };
  h.app = {
    isPackaged: true, getVersion: () => '0.2.47', isInApplicationsFolder: () => inApplications,
    moveToApplicationsFolder: (opts) => { h.moves.push(opts); h.conflict = opts.conflictHandler; if (moveThrows) throw moveThrows; return moveResult; },
  };
  h.dialog = { showMessageBox: async (o) => { h.dialogs.push(o); return { response: h.dialogs.length === 1 ? response : 0 }; } };
  h.run = () => offerMoveToApplications({ platform, app: h.app, dialog: h.dialog, execPath, readState: () => state, writeState: (s) => h.written.push(s), log: silent });
  return h;
}

(async () => {
  {
    const h = harness({ response: 0 });
    eq(await h.run(), 'skipped', 'accepted: the move is requested (the real app relaunches and never returns here)');
    eq(h.moves.length, 1, 'moveToApplicationsFolder is called once');
    eq(h.dialogs.length, 1, 'one question');
    eq(h.dialogs[0].buttons, ['Move to Applications', 'Not now'], 'two clear buttons');
    eq(/cannot update itself/.test(h.dialogs[0].detail) && /restart/i.test(h.dialogs[0].detail), true, 'the dialog says WHY (no updates) and that Flowpad restarts');
    eq(h.written, [{ offeredFor: '0.2.47' }], 'the prompt is recorded for this version');
    eq([h.conflict('exists'), h.conflict('existsAndRunning')], [true, false], 'an old copy is replaced; a RUNNING copy never is');
  }
  {
    const h = harness({ response: 1 });
    eq(await h.run(), 'declined', 'Not now → declined');
    eq(h.moves.length, 0, 'nothing is moved');
    eq(h.written.length, 1, 'and it is not asked again for this version');
  }
  {
    const h = harness({ response: 0, moveResult: false });
    eq(await h.run(), 'cancelled', 'the OS refused / user cancelled authorisation → cancelled, no error dialog');
    eq(h.dialogs.length, 1, 'no second dialog for a cancellation');
  }
  {
    const h = harness({ response: 0, moveThrows: new Error('EACCES: permission denied') });
    eq(await h.run(), 'failed', 'a real failure → failed');
    eq(h.dialogs.length, 2, 'the user is told');
    eq(/Drag Flowpad\.app into the Applications folder/.test(h.dialogs[1].detail) && /EACCES/.test(h.dialogs[1].detail), true, 'with the reason and the manual way out');
  }
  {
    const h = harness({ state: { offeredFor: '0.2.47' } });
    eq(await h.run(), 'skipped', 'already asked for this version → skipped');
    eq([h.dialogs.length, h.moves.length, h.written.length], [0, 0, 0], 'no dialog, no move, no write');
  }
  {
    const h = harness({ platform: 'win32' });
    eq(await h.run(), 'skipped', 'Windows → skipped');
    eq(h.dialogs.length, 0, 'no dialog off macOS');
  }
  {
    const h = harness({ execPath: APPS });
    eq(await h.run(), 'skipped', 'installed normally → skipped');
    eq(h.dialogs.length, 0, 'no dialog');
  }
  {
    // A broken state file must not block the offer (or crash startup).
    const h = harness({});
    h.run = () => offerMoveToApplications({ platform: 'darwin', app: h.app, dialog: h.dialog, execPath: TRANSLOCATED, readState: () => { throw new Error('corrupt'); }, writeState: () => { throw new Error('read-only'); }, log: silent });
    eq(await h.run(), 'skipped', 'unreadable/unwritable state: still offers (and does not throw)');
    eq(h.moves.length, 1, 'and the move was requested');
  }

  console.log(`app-location.test.js: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
