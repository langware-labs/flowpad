const { app, BrowserWindow, ipcMain, dialog, clipboard, Notification, Menu, powerMonitor, session, autoUpdater: squirrelUpdater } = require('electron');
const { autoUpdater } = require('electron-updater');
const { describeStartupFailure, summarizeOutput } = require('./startup-error');
const { buildSupportZip, redact } = require('./support-bundle');
const { uploadSupportBundle } = require('./support-upload');
const { redactUrl, installLogRedaction } = require('./log-redact');
const { offerMoveToApplications } = require('./app-location');
const { showFailureDialog } = require('./failure-dialog');
const { createRendererWatchdog } = require('./renderer-watchdog');
const { bounded, collectFailureReport, writeFailureReport } = require('./hang-report');
const { engineChangePolicy, savePendingEngine, markPendingEngineConsented, planAfterDesktopUpdate, engineRecordAtHealthGate } = require('./update-plan');
const engineCompat = require('./engine-compat');
const updateTest = require('./update-test');
const updateSchedule = require('./update-schedule');
const { createRestartApplier } = require('./update-restart');
const cookieGate = require('./cookie-gate');
// electron-updater's own token type (its dependency); not re-exported by electron-updater.
const { CancellationToken } = require('builder-util-runtime');
const path = require('path');
const log = require('electron-log');
const crypto = require('crypto');
const UvManager = require('./uv-manager');
const { createShutdown, relaunchAfterStop } = require('./shutdown');
const { createQuitGate, quitDialogOptions, QUIT_RESPONSE } = require('./quit-gate');
const { waitForBackend: runBackendGate, createLogActivityProbe, createChangeProbe } = require('./backend-wait');
const { createPolicyBlockProbe, detectPolicyBlockInLog, policyBlockFromInstallError, isInterpreterModule, describeRuntimeBlock, readRuntimeState, canAttemptRepair, priorAttempt } = require('./runtime-repair');
// FLOWPAD-2231: the monitor's fatal-failure record, the desktop update as a recovery route, the startup journal.
const fatalFailure = require('./fatal-failure');
const updateRecovery = require('./update-recovery');
const { createStartupJournal, recoveryRequested, createStartGuard } = require('./startup-watchdog');
const { SOD_KEY_KEYCHAIN_SERVICE } = UvManager;

// Exact, copy-pasteable terminal commands surfaced to the user when the backend
// fails to come up — `upgradeCommand()` is the same string uv-manager.js's
// upgrade()/installLatest() run (`uv tool install flowpad@latest --python <pin>
// --force`, the pin being the `requires-python` floor read from the bundled
// pyproject.toml). Resolved when a panel is shown, not at load: a build missing
// that file must still launch a healthy install (see getPythonVersion).
// With a repaired runtime (runtime-repair.js) the command pins that interpreter, as the app does.
const upgradeCommand = () => UvManager.upgradeCommand(uvManager && uvManager.repairedRuntimePython ? uvManager.repairedRuntimePython() : undefined);
const DIAGNOSE_COMMAND = 'flow diagnose';
const { isNewer } = require('./semver');

const isMac = process.platform === 'darwin';

// Register flowpad:// as a custom protocol so the OS routes deep links here.
// Must be called before app.whenReady().
app.setAsDefaultProtocolClient('flowpad');

// Lets the hang watchdog read a busy renderer's JS call stack for its report (hang-report.js);
// pages opt in with the Document-Policy header added in `createWindow`.
app.commandLine.appendSwitch('enable-features', 'DocumentPolicyIncludeJSCallStacksInCrashReports');

// Enforce single-instance so Windows/Linux deep links reach the running app
// via the 'second-instance' event rather than spawning a second process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Configure logging — store all logs under ~/.flow/logs/
const fs = require('fs');
const os = require('os');
const FLOW_HOME = path.join(os.homedir(), '.flow');
const LOGS_BASE = path.join(FLOW_HOME, 'logs');
const MAIN_DESKTOP_LOG_DIR = path.join(LOGS_BASE, 'main_desktop');
// The backend's own logs (server/, monitor/) are per instance:
// <flow_home>/instances/<name>/logs — flow_sdk/instance_settings/base_settings.py
// (`logs_dir`, instance "prod" unless FLOW_INSTANCE says otherwise). The startup
// gate reads the server log there; watching the old <flow_home>/logs/server
// would see a directory the backend never writes to.
const FLOW_INSTANCE = process.env.FLOW_INSTANCE || 'prod';
const BACKEND_LOGS = path.join(FLOW_HOME, 'instances', FLOW_INSTANCE, 'logs');
// The instance's own directory: server.json and, after a deterministic backend failure, the monitor's
// server-failure.json (flow_sdk/server/launch.py → electron/fatal-failure.js).
const INSTANCE_DIR = path.join(FLOW_HOME, 'instances', FLOW_INSTANCE);

function generateTimestampedFilename() {
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = now.getDate();
  const mon = months[now.getMonth()];
  const year = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${day}${mon}${year}_${hh}_${mm}_${ss}.log`;
}

function cleanupOldLogs(dir, maxAgeDays = 7) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  if (files.length <= 1) return;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const f of files.slice(0, -1)) {  // never delete the newest
    if (f.mtime < cutoff) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
  }
}

function getNewestLogFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0] : null;
}

fs.mkdirSync(MAIN_DESKTOP_LOG_DIR, { recursive: true });
cleanupOldLogs(MAIN_DESKTOP_LOG_DIR);
const MAIN_LOG_PATH = path.join(MAIN_DESKTOP_LOG_DIR, generateTimestampedFilename());
log.transports.file.resolvePathFn = () => MAIN_LOG_PATH;
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
// Secrets never reach the log file (it is emailed to us): see log-redact.js. Installed before the first line.
installLogRedaction(log);
log.info('Flowpad starting...');

// ----------------------------------------------------------------------------
// Electron desktop wrapper auto-update.
// ----------------------------------------------------------------------------

// Set while a desktop download belongs to a flow that installs it ITSELF the moment it lands (desktop-first
// setup, the recovery update): nobody is asked about it. Reset once consumed.
let downloadAppliedByCaller = false;

// The outcome of a panel-initiated coordinated update (pending-engine source 'panel') resumed by THIS
// launch: pushed to the renderer once the UI is up ('engine-update-resumed'), and pulled one-shot via
// 'update:take-resumed' at panel mount — for a renderer that mounted after the push.
let resumedPanelUpdate = null;

// macOS: electron-updater's 'update-downloaded' fires when the zip is FETCHED, but Squirrel.Mac still has
// to verify and stage it — quitAndInstall() before that only registers a listener that may never fire
// (window hidden, engine stopped, nothing happens). So on macOS an update is READY only once Electron's
// own autoUpdater says 'update-downloaded'; until then it waits here, shown as still downloading.
// A test seam, not a platform sniff at every use: the harness pins it per scenario (and a stubbed
// Electron without Squirrel never takes this path, whatever OS the tests run on).
let squirrelStages = process.platform === 'darwin' && !!squirrelUpdater;
let squirrelPendingInfo = null;  // fetched, waiting for Squirrel to stage it
let squirrelStaged = false;      // Squirrel staged the current download
let squirrelStaging = Promise.resolve(false); // settles true (staged) / false (staging failed) per download
let settleSquirrelStaging = () => {};

/** Desktop-update progress for the version panel ('desktop-update-state' channel). Best-effort: a
 *  missing window just means nobody is watching. */
function sendDesktopUpdateState(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // `background`: nobody asked for this download (the automatic flow) — the panel row shows it, but a
  // failure is not toasted: the running version is untouched and the next check retries.
  const background = !!(panelUpdatePlan && panelUpdatePlan.background);
  try { mainWindow.webContents.send('desktop-update-state', { ...payload, background }); } catch { /* window going away */ }
}

// "Update now": stop the backend, then hand over to the installer; if the updater reports it
// could not restart, undo `isQuitting` and tell the user (see update-restart.js).
const restartApplier = createRestartApplier({
  uvManager: { stop: () => (uvManager ? uvManager.stop() : Promise.resolve()) },
  // (update-test.js: in the update-cycle harness the relaunch is skipped so the harness can keep the new build's output)
  autoUpdater: { quitAndInstall: (silent, forceRun) => autoUpdater.quitAndInstall(silent, updateTest.forceRunAfter(forceRun)) },
  setQuitting: (v) => { isQuitting = v; },
  hideWindow: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); },
  showWindow: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } },
  // The silent installer runs with no window of ours for ~30s, then the new desktop installs the engine: say so —
  // without promising a reopen the OS can veto (a cancelled UAC or password prompt ends the install quietly).
  notifyInstalling: () => {
    if (Notification.isSupported()) {
      const asksPassword = process.platform === 'linux' && !process.env.APPIMAGE; // deb/rpm install through pkexec
      const body = `Installing the update.${asksPassword ? ' Your system may ask for your password.' : ''} FlowPad reopens when it is done — if it does not, start it again.`;
      new Notification({ title: 'FlowPad is updating', body, silent: true }).show();
    }
  },
  lateFailurePoisons: () => !squirrelStages,
  onFailure: (err, { late = false } = {}) => {
    // The desktop could not be applied (for example an app running from a temporary macOS location). It stays
    // pending: the engine changes only after the NEW desktop is installed and running.
    // Elsewhere the artifact is still on disk, so the row offers "Retry the update" (apply) and quitting installs
    // it too. On macOS a failure here is Squirrel's: retrying the apply would wait on a staging that never comes,
    // and install-on-quit fails the same way — the row offers the download again instead.
    const squirrelFailed = squirrelStages;
    if (squirrelFailed) { desktopDownloadedVersion = null; squirrelStaged = false; }
    // `late` (Windows/Linux): the installer failed after the updater had handed over — the updater cannot
    // apply again in THIS process, and install-on-quit is skipped too. The row offers "Restart FlowPad",
    // which retries the update from a fresh process.
    sendDesktopUpdateState({ state: 'error', error: (err && err.message) || String(err), apply: !squirrelFailed && !late, restart: late });
    showFailureDialog({
      dialog,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      type: 'warning',
      title: 'Update could not be applied',
      message: 'FlowPad could not restart to finish the update.',
      detail: `${squirrelFailed
        ? 'macOS could not install the update. Download it again from the version panel, or check that FlowPad runs from the Applications folder.'
        : late
          ? 'Restart FlowPad (from the version panel, or by quitting and starting it again) to try the update again.'
          : INSTALLS_ON_QUIT
            ? 'The update is downloaded: retry it from the version panel, or it is applied the next time FlowPad is closed.'
            : 'The update is downloaded: retry it from the version panel.'}\n\n${err && err.message ? err.message : err}`,
      share: (text) => shareDiagnostics(text, 'could not restart to apply an update'),
      log,
    });
    // apply() stopped the backend BEFORE quitAndInstall: the app is staying, so bring the backend
    // back — the dialog alone left an open, dead window. Pre-start flows (backendReady false) own
    // their own continuation (updateDesktopBeforeEngineInstall falls through to the engine install).
    if (uvManager && backendReady) {
      void uvManager
        .recoverAfterFailedUpgrade(mainWindow, { waitForBackend, backendUrl: BACKEND_URL, sendStatus })
        .then((ok) => { if (!ok) return offerRecoveryRetry(err); })
        .catch((e) => log.warn(`[update-restart] backend recovery failed: ${e && e.message}`));
    }
  },
  log,
});

let updaterInitialized = false;
// Does a downloaded update install when FlowPad quits? Everywhere but deb/rpm (see setupElectronAutoUpdater).
// A seam like squirrelStages: the harness pins it, whatever OS the tests run on.
let INSTALLS_ON_QUIT = !(process.platform === 'linux' && !process.env.APPIMAGE);

function setupElectronAutoUpdater() {
  if (!app.isPackaged) {
    log.info('[electron-updater] skipped: app is not packaged');
    return;
  }
  // startApp() can run again (macOS `activate`); a second setup would stack handlers
  // (two "ready" prompts) and a second periodic interval.
  if (updaterInitialized) return;
  updaterInitialized = true;

  if (process.windowsStore) {
    // Microsoft Store build: the Store delivers desktop updates (and electron-updater
    // does not support AppX). The scheduled PyPI package check below still runs.
    log.info('[electron-updater] skipped: Microsoft Store build');
  } else {
    autoUpdater.logger = log;
    // Update-cycle harness (FLOWPAD_UPDATE_TEST=1): read the update feed from an alternate app-update.yml (a local
    // `generic` provider) instead of the one baked into resources/.
    if (updateTest.isEnabled() && process.env.FLOWPAD_UPDATE_CONFIG) {
      autoUpdater.updateConfigPath = process.env.FLOWPAD_UPDATE_CONFIG;
      updateTest.event('feed-config', { path: process.env.FLOWPAD_UPDATE_CONFIG });
    }
    // Manual control: the update flow downloads explicitly (downloadUpdate()) so it can pick the engine that
    // rides along and stage both before asking — never without a plan for what is downloaded.
    autoUpdater.autoDownload = false;
    // A downloaded update the user put off ("Later") still applies on the next quit/restart
    // without asking again — that's exactly autoInstallOnAppQuit. Not on deb/rpm: there the install runs
    // through pkexec, so EVERY ordinary quit with an update pending asked for the system password (and a
    // cancel went unreported); they install through "Update now" only. (macOS needs it on:
    // it is what makes Squirrel stage the download.)
    autoUpdater.autoInstallOnAppQuit = INSTALLS_ON_QUIT;

    autoUpdater.on('checking-for-update', () => {
      log.info('[electron-updater] checking for update...');
    });
    autoUpdater.on('update-available', (info) => {
      log.info(`[electron-updater] update available: ${info.version}`);
    });
    autoUpdater.on('update-not-available', (info) => {
      log.info(`[electron-updater] up to date. current=${app.getVersion()} latest=${info && info.version}`);
    });
    autoUpdater.on('download-progress', (p) => {
      log.info(`[electron-updater] download ${Math.round(p.percent)}% (${p.transferred}/${p.total})`);
      sendDesktopUpdateState({ state: 'downloading', percent: p.percent, version: desktopDownloadVersion });
    });
    autoUpdater.on('error', (err) => {
      log.error('[electron-updater] error:', err);
      // Download errors reach the panel from downloadDesktopUpdateInBackground's OWN catch, and an
      // apply failure from restartApplier's onFailure — each from the one place that knows whose
      // error it is. This shared emitter also carries feed-check noise, so it pushes nothing itself.
      // If this happened while an "Update now" was in flight, the app is not quitting after all.
      restartApplier.failed(err);
    });

    // Fires only after an explicit downloadUpdate() completes — and electron-updater has already checked
    // the file against the feed's sha512 (and, on Windows, the installer's signature).
    autoUpdater.on('update-downloaded', (info) => {
      log.info(`[electron-updater] update downloaded: ${info.version}`);
      if (squirrelStages && !squirrelStaged) {
        squirrelPendingInfo = info;
        log.info('[electron-updater] waiting for macOS (Squirrel) to prepare the update');
        return;
      }
      onDesktopUpdateReady(info).catch((err) => log.warn(`[electron-updater] ready handling failed: ${err.message}`));
    });

    if (squirrelStages) {
      // Electron's own autoUpdater IS Squirrel.Mac — the one that knows when the update is staged.
      const nativeUpdater = squirrelUpdater;
      nativeUpdater.on('update-downloaded', () => {
        squirrelStaged = true;
        log.info('[electron-updater] macOS prepared the update');
        settleSquirrelStaging(true);
        const info = squirrelPendingInfo;
        squirrelPendingInfo = null;
        if (info) void onDesktopUpdateReady(info).catch((err) => log.warn(`[electron-updater] ready handling failed: ${err.message}`));
      });
      // A staging failure (signature mismatch, read-only location) — electron-updater forwards it as its own
      // 'error' too, but that emitter is shared with feed-check noise: only HERE is it known to be staging.
      nativeUpdater.on('error', (err) => {
        if (squirrelStaged || !squirrelPendingInfo) return; // an apply failure: restartApplier's onFailure owns it
        squirrelPendingInfo = null;
        settleSquirrelStaging(false);
        log.warn(`[electron-updater] macOS could not prepare the update: ${err && err.message}`);
        sendDesktopUpdateState({ state: 'error', error: (err && err.message) || String(err) });
      });
    }
  }

  // A crash between atomicWrite's tmp and rename leaves a uniquely-named orphan no later write
  // touches: sweep them once per launch.
  try {
    const userData = app.getPath('userData');
    for (const f of fs.readdirSync(userData)) {
      // Only OTHER processes' OLD orphans: never a tmp this process may be mid-writing, and never
      // one younger than a minute — an atomic write finishes in milliseconds, so age, not pid
      // reuse, is what makes a tmp provably dead (a fixed age check, not a wait or a retry).
      const m = /^(?:update-schedule|pending-engine)\.json\.(\d+)\..+\.tmp$/.exec(f);
      if (m && Number(m[1]) !== process.pid) {
        const full = path.join(userData, f);
        try {
          if (Date.now() - fs.statSync(full).mtimeMs > 60 * 1000) fs.rmSync(full, { force: true });
        } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }

  // Long-lived sessions: re-check periodically. The tick is cheap and only ASKS update-schedule.js
  // whether a check is DUE — hourly for an @langware.ai account, daily otherwise, anchored to the
  // persisted last check so a restart does not reset it (FLOWPAD-2308). The update-cycle harness
  // interval bypasses the schedule: that interval IS the cadence under test. Launch-time is
  // handled by the pre-start flow, not here.
  const harnessTickMs = updateTest.checkIntervalMs();
  const tick = setInterval(() => {
    runScheduledUpdateCheck({ bypassSchedule: !!harnessTickMs })
      .catch((err) => log.warn(`[update] scheduled pass failed: ${err.message}`)); // a sync throw must not become an unhandled rejection
  }, harnessTickMs || updateSchedule.SCHEDULER_TICK_MS);
  if (typeof tick.unref === 'function') tick.unref();
  watchAccountChanges();
}

/** The downloaded update is installable (on macOS: Squirrel staged it): ready — asked about once everything is staged. */
async function onDesktopUpdateReady(info) {
  desktopDownloadedVersion = info.version;
  // deb/rpm do not install on quit (every quit would ask for the password): a downloaded update is
  // installed at the next launch instead (applyPostponedDesktopOnLaunch) — "later" never means "never".
  if (!INSTALLS_ON_QUIT) postponedDesktopStore.write({ version: info.version });
  if (downloadAppliedByCaller) {
    // Desktop-first / the recovery update: their caller installs it right now — no question.
    downloadAppliedByCaller = false;
    return;
  }
  sendDesktopUpdateState({ state: 'ready', version: info.version });
  maybeAnnounceUpdateReady(); // the one question, once the engine riding along is staged too
}

// One automatic pass at a time: a tick that lands while the previous one still awaits the feed
// does nothing ("prevent duplicate or concurrent update checks").
let autoCheckInFlight = false;

/**
 * One periodic pass over BOTH channels, behind the schedule. Nothing here asks the user: a newer
 * desktop (with the engine that will run on it) or a newer engine is downloaded, staged and checked in
 * the background, and the ONE question comes when everything is ready (maybeAnnounceUpdateReady).
 */
async function runScheduledUpdateCheck({ bypassSchedule = false } = {}) {
  // The UI that was expected to ask has not said it can: ask natively now (an older engine's UI).
  announceNativelyIfNoPanel();
  if (autoCheckInFlight) return;
  // An install is being applied: a feed check now could only add noise to the updater's shared
  // 'error' emitter (and nothing it finds can be acted on before the restart).
  if (restartApplier.busy) return;
  armAccountWatch(); // a watch that died (or never armed on a fresh install) is back within one tick
  const state = scheduleStore.read(); // one read per pass; the record* writers re-read at their write
  // Pass shape: 'scheduled' hits the feed and runs both halves; 'engine-retry' is the ENGINE
  // channel's own backoff (its failure must not drag the desktop feed along); 'follow-up' finishes
  // an engine check that something transient blocked, and never records failures — otherwise every
  // 5-minute tick would inflate a streak the backoff never paced.
  let pass = 'scheduled';
  let feedBackoffOnly = false; // due only to retry the failing FEED: the engine keeps its own cadence
  if (!bypassSchedule) {
    const check = updateSchedule.shouldAutoCheck({ state, intervalMs: currentIntervalMs(), now: Date.now() });
    if (check.due) {
      feedBackoffOnly = check.reason === 'backoff';
      followUpRetries = 0; // a fresh interval starts a fresh retry streak
      log.info(`[update] periodic check due (${check.reason})`);
    } else if (followUpPackage) {
      pass = 'follow-up';
    } else if (updateSchedule.engineRetryDue({ state, now: Date.now() })) {
      pass = 'engine-retry';
      log.info('[update] engine check retry due (engine backoff)');
    } else {
      return;
    }
  }
  autoCheckInFlight = true;
  const packageWasBlocked = followUpPackage;
  followUpPackage = false;
  try {
    // A newer desktop: downloaded with the engine that will run on it, nothing asked yet. A release newer
    // than the one already pending replaces it (beginBackgroundUpdate).
    const desktopLatest = pass === 'scheduled' ? await getDesktopUpdateVersion() : null;
    if (desktopLatest) await beginBackgroundUpdate(desktopLatest);
    // The engine half runs on scheduled passes (but not ones due only to the FEED's backoff — the
    // engine is not what failed), on its own retry, and on a follow-up that owes it.
    if ((pass === 'scheduled' && !feedBackoffOnly) || pass === 'engine-retry' || packageWasBlocked) {
      const pkg = await checkPackageUpdateInBackground();
      if (pkg === 'blocked') followUpPackage = true; // transient: finished on a near tick
      // 'held': nothing owed — the hold lifts only via a restart, which re-checks the engine; an
      // engine-RETRY that was held is paced forward so engineRetryDue stops firing every tick.
      else if (pkg === 'held' && pass === 'engine-retry') scheduleStore.write(updateSchedule.recordEngineAttempt(scheduleStore.read(), { at: Date.now() }));
      // The engine channel keeps its own streak (recordEngineFailure/engineRetryDue): a PyPI error
      // retries on the engine backoff without sending the desktop feed back to the network — and a
      // follow-up pass never records, it only finishes what was blocked.
      else if (pkg === 'failed' && pass !== 'follow-up') scheduleStore.write(updateSchedule.recordEngineFailure(scheduleStore.read(), { at: Date.now() }));
      else if (pkg === 'ran' && (Number(scheduleStore.read().engineFailureCount) || 0) > 0) scheduleStore.write(updateSchedule.recordEngineSuccess(scheduleStore.read()));
    }
    followUpRetries = 0; // the pass completed without throwing
  } catch (err) {
    log.warn(`[update] periodic check failed: ${err.message}`);
    // The debt this pass was carrying was not paid: give it back so a near tick retries it, capped.
    if (packageWasBlocked) rearmFollowUp({ pkg: true });
  } finally {
    autoCheckInFlight = false;
  }
}

// A pass left the engine check behind a transient blocker (an install in progress): the next tick
// finishes it instead of waiting out the whole interval.
let followUpPackage = false;

// A deterministic error must not retry a debt every 5 minutes forever: after this many consecutive
// FAILED passes the debt is dropped (logged) and the next regular interval starts clean. This CAPS
// existing retries; any pass that completes resets the streak.
const MAX_FOLLOW_UP_RETRIES = 3;
let followUpRetries = 0;
function rearmFollowUp({ pkg = false } = {}) {
  if (++followUpRetries > MAX_FOLLOW_UP_RETRIES) {
    log.warn(`[update] follow-up gave up after ${MAX_FOLLOW_UP_RETRIES} failed passes; waiting for the next interval`);
    return;
  }
  if (pkg) followUpPackage = true;
}

/**
 * A newer desktop was found (at launch or by a periodic pass): start the background update for it —
 * download the desktop, and stage the newest engine that will run on IT — without asking anything. One
 * question comes when both are ready. A release newer than the one already pending replaces it (its
 * download is cancelled, its staged engine record overwritten, and the user hears only about the newest);
 * the same release found again only retries a download that failed. Serialized: two finds never race.
 */
let backgroundUpdateRun = Promise.resolve();
function beginBackgroundUpdate(desktopVersion) {
  const run = backgroundUpdateRun.then(() => startBackgroundUpdate(desktopVersion));
  backgroundUpdateRun = run.catch((err) => log.warn(`[update] background update of ${desktopVersion} could not start: ${err.message}`));
  return backgroundUpdateRun;
}

async function startBackgroundUpdate(desktopVersion) {
  if (!uvManager || isQuitting || desktopUpdateRefusal() === 'unsupported' || restartApplier.busy) return;
  const plan = panelUpdatePlan;
  if (plan && plan.desktopVersion === desktopVersion) {
    // Already on its way or ready (whatever the user answered): only a download that failed is retried.
    if (desktopDownloadedVersion !== desktopVersion && !desktopDownloadPending()) {
      log.info(`[update] retrying the download of desktop ${desktopVersion}`);
      restartPlannedDownload(desktopVersion);
    }
    return;
  }
  if (plan && plan.desktopVersion && !isNewer(plan.desktopVersion, desktopVersion)) return; // never step back
  if (plan && plan.desktopVersion) log.info(`[update] desktop ${desktopVersion} supersedes the pending ${plan.desktopVersion}`);
  // The engine that rides along is chosen for the NEW desktop: the newest release it accepts, if newer than installed.
  let engineVersion = null;
  try {
    const picked = await uvManager.resolveCompatibleEngineVersion({ desktopVersion });
    const installed = uvManager.getInstalledVersionSync() || null;
    if (picked && (!installed || isNewer(installed, picked.version))) engineVersion = picked.version;
  } catch (err) {
    log.info(`[update] no engine chosen for desktop ${desktopVersion}: ${String(err.message).split('\n')[0]}`);
  }
  if (!engineVersion) {
    // Not choosable now (offline): an engine already agreed for this desktop — or for the pending one this
    // release supersedes (a floor the older desktop met, the newer one meets too) — still rides along.
    const saved = pendingEngineStore.read();
    const agreedFor = saved && saved.consented && saved.engineVersion && !saved.phase ? saved.desktopVersion : null;
    if (agreedFor && (agreedFor === desktopVersion || (plan && agreedFor === plan.desktopVersion))) engineVersion = saved.engineVersion;
  }
  if (isQuitting || restartApplier.busy) return;
  // A panel action may have taken the same release meanwhile.
  if (panelUpdatePlan && panelUpdatePlan.desktopVersion && !isNewer(panelUpdatePlan.desktopVersion, desktopVersion)) return;
  log.info(`[update] downloading desktop ${desktopVersion}${engineVersion ? ` and staging engine ${engineVersion}` : ''} in the background`);
  startCoordinatedUpdate({ desktopVersion, engineVersion, background: true });
}

// An engine check is running (one at a time).
let packageUpdateInFlight = false;
// A downloadUpdate() is running: a periodic tick must not start another one
// (electron-updater would coalesce it, but the call resets the caller-applies flag).
let desktopDownloadInFlight = false;
let desktopDownloadVersion = null;        // version being downloaded
let desktopDownloadToken = null;          // CancellationToken of that download
let desktopDownloadDone = Promise.resolve();
let desktopDownloadGen = 0;               // bumps per download and per cancel: a stale callback is ignored
let endDesktopDownloadWait = () => {};    // releases desktopDownloadDone on cancel
let desktopTransfer = Promise.resolve();  // the current download's own promise (not raced)
let desktopTransferEnded = Promise.resolve(); // a cancelled transfer's end: the next download starts after it

/**
 * Engine (PyPI) update check. Nothing is asked: a newer release that runs on this desktop is staged in
 * the background (startEnginePrepare) while the running engine keeps serving, and the user is asked once
 * it is ready. Skipped in dev (it would reinstall under a live dev backend) and while a previous check is
 * still running. Periodic ticks and the post-boot check compare against PyPI; `compareWithPypi: false`
 * defers to the cloud policy verdict instead.
 */
async function checkPackageUpdateInBackground({ compareWithPypi = true, label = 'periodic' } = {}) {
  if (isDev) return;
  if (!uvManager || !mainWindow || mainWindow.isDestroyed()) return;
  if (!uvManager.getInstalledFlowBin()) {
    // Nothing is installed (the first-time setup failed): there is nothing to "update" — the first-time
    // setup and its Retry own that.
    log.info(`[uv] ${label} package check skipped: flowpad is not installed`);
    return;
  }
  if (engineChangeAllowed(`${label} package check`) !== 'allow') {
    // A newer desktop is on its way — or we could not tell whether one is. The engine is updated BY the new
    // desktop (it may need a Python pin, or a start contract, that only the new desktop knows) — an old desktop
    // upgrading it first is what left users stuck. So: no separate engine update until the desktop is current.
    // ONE exception: the installed engine is below the RUNNING desktop's own floor (the pair is broken
    // today) and the repair targets THIS desktop — waiting for a feed that is not answering would keep
    // an incompatible pair running until the next relaunch.
    const pair = uvManager.installedPairIssue();
    if (!(pair && !pair.desktopTooOld)) {
      log.info(`[uv] ${label} package check skipped: the desktop is updated first`);
      return 'held'; // the desktop goes first; a hold only lifts via a restart, which re-checks the engine itself
    }
    log.info(`[uv] ${label} package check proceeds despite the hold: the installed engine is below the running desktop's floor`);
  }
  if (packageUpdateInFlight || uvManager.isInstalling() || restartApplier.busy) {
    log.info(`[uv] ${label} package check skipped: an update check or install is already running`);
    return 'blocked'; // transient: the scheduler retries on a near tick
  }
  packageUpdateInFlight = true;
  try {
    log.info(`[uv] ${label} package check`);
    // uv-manager swallows PyPI failures into null answers ("no update"), so a thrown error almost
    // never reaches us — its failure counter is how THIS check reports an unreachable PyPI.
    // Before/after comparison, not a shared flag: a concurrent lookup elsewhere cannot mask (only
    // at worst duplicate) a failure that happened during this check.
    const lookupFailuresBefore = uvManager.pypiLookupFailures || 0;
    const found = await uvManager.findEngineUpdate({ compareWithPypi, cloudUrl: FLOWPAD_CLOUD_URL });
    if (found) prepareEngineInBackground(found.latestVersion, { source: 'auto' });
    return (uvManager.pypiLookupFailures || 0) > lookupFailuresBefore ? 'failed' : 'ran';
  } catch (err) {
    log.warn(`[uv] ${label} package check failed: ${err.message}`);
    return 'failed'; // the scheduler starts the ENGINE backoff — a transient PyPI failure is not a day's wait
  } finally {
    packageUpdateInFlight = false;
  }
}

/**
 * Stage `version` in the background unless it is already being staged or ready, or it failed its health
 * check before (vetoed until a newer release exists). A newer release than one already ready replaces it
 * once IT is staged; the ready one stays the candidate until then (startEnginePrepare).
 */
function prepareEngineInBackground(version, { source }) {
  if (!version) return null;
  if (enginePrep && enginePrep.version === version && (enginePrep.state === 'preparing' || enginePrep.state === 'ready')) return enginePrep;
  if (enginePrep && enginePrep.state === 'preparing') return enginePrep; // one at a time: the next check picks up anything newer
  if (enginePrep && enginePrep.state === 'ready' && !isNewer(enginePrep.version, version)) return enginePrep; // never step back
  const rec = pendingEngineStore.read();
  if (rec && rec.phase === 'failed-unhealthy' && rec.failedVersion === version) {
    log.info(`[update] engine ${version} failed its health check before — not staged again until a newer release`);
    return null;
  }
  log.info(`[update] engine ${uvManager.getInstalledVersionSync() || 'unknown'} → ${version}: staging it in the background`);
  return startEnginePrepare({ version, source, background: source === 'auto' });
}

// A newer desktop build was found this session (and not yet applied): engine updates wait for it.
let pendingDesktopVersion = null;
// The desktop version that finished downloading and waits for a restart.
let desktopDownloadedVersion = null;

// The engine version offered together with a desktop update, saved for the NEW desktop to install (update-plan.js).
function pendingEnginePath() {
  return path.join(app.getPath('userData'), 'pending-engine.json');
}
const pendingEngineStore = {
  read() { try { return JSON.parse(fs.readFileSync(pendingEnginePath(), 'utf8')); } catch { return null; } },
  write(state) {
    try { atomicWrite(pendingEnginePath(), JSON.stringify(state)); } catch (err) { log.warn(`[update] could not save the pending engine version: ${err.message}`); }
  },
  clear() { try { fs.rmSync(pendingEnginePath(), { force: true }); } catch { /* best effort */ } },
};

// FLOWPAD-2308: the persisted check schedule — when the last check happened and what it answered,
// the failure streak. update-schedule.js owns the shape and every decision.
function schedulePath() { return path.join(app.getPath('userData'), updateSchedule.SCHEDULE_FILE); }
const scheduleStore = {
  read() { return updateSchedule.readScheduleState((p) => fs.readFileSync(p, 'utf8'), schedulePath()); },
  write(state) {
    try { updateSchedule.writeScheduleState((p, text) => atomicWrite(p, text), schedulePath(), state); }
    catch (err) { log.warn(`[update] could not save the update schedule: ${err.message}`); }
  },
};
// tmp + rename, the same pattern as the backend's app_config writes: a crash mid-write leaves the
// previous file, never a truncated one. The tmp name is unique (overlapping writers must not race
// on one name), and a failed rename does not leave it behind.
function atomicWrite(p, text) {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, p);
    } catch (err) {
      // Only a lock held by another process (Windows anti-virus / indexer) is worth the in-place
      // overwrite — the pre-PR behavior. Anything else (ENOSPC, EROFS…) would fail the overwrite
      // too, and half-writing the target is exactly what this function exists to prevent.
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      fs.writeFileSync(p, text, 'utf8');
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

// The account the schedule follows: the hub-validated email the backend writes to the instance's
// config.json on login/logout/switch. Locally editable, but editing it only changes this machine's
// own check cadence.
const currentAccountEmail = () => updateSchedule.readAccountEmail((p) => fs.readFileSync(p, 'utf8'), path.join(INSTANCE_DIR, 'config.json'));
const currentIntervalMs = () => updateSchedule.intervalForEmail(currentAccountEmail());

/**
 * Login, logout and an account switch rewrite config.json (atomically, via os.replace — so the
 * DIRECTORY is watched; a watch on the file itself dies with the first replace). An interval-class
 * change re-evaluates the schedule right away; a missed event only waits for the next tick, which
 * re-reads the email anyway.
 */
// The watch callback, kept reachable at module level: tests drive it directly, because the OS's
// event delivery (fs.watch arming is itself async) is the one part that cannot be awaited deterministically.
let accountWatchEvent = null;
// In the update-cycle harness the debounce is zero so tests never wait on the wall clock.
const ACCOUNT_DEBOUNCE_MS = updateTest.isEnabled() ? 0 : 500;
let accountWatchInstalled = false;
function watchAccountChanges() {
  if (accountWatchInstalled) return; // a re-install would orphan the previous handler's live debounce
  accountWatchInstalled = true;
  let wasInternal = updateSchedule.isInternalEmail(currentAccountEmail());
  let debounce = null;
  accountWatchEvent = (filename) => {
    if (filename && filename !== 'config.json') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const internal = updateSchedule.isInternalEmail(currentAccountEmail());
      if (internal === wasInternal) return;
      wasInternal = internal;
      log.info(`[update] account change: update checks now run ${internal ? 'hourly' : 'daily'}`);
      runScheduledUpdateCheck({ bypassSchedule: !!updateTest.checkIntervalMs() }) // the harness interval bypasses the schedule here too
        .catch((err) => log.warn(`[update] account-change pass failed: ${err.message}`));
    }, ACCOUNT_DEBOUNCE_MS);
    if (typeof debounce.unref === 'function') debounce.unref();
  };
  armAccountWatch();
}

// The live fs.watch handle, re-armed by every tick when it is down: on a fresh install the instance
// dir may not exist yet, and on Windows deleting the watched dir raises an async 'error' that —
// without a listener — would CRASH the main process. A dead watch is back within one tick; the
// per-tick email re-read keeps the schedule correct meanwhile.
let accountWatcher = null;
function armAccountWatch() {
  if (accountWatcher || !accountWatchEvent) return;
  try {
    fs.mkdirSync(INSTANCE_DIR, { recursive: true });
    const watcher = fs.watch(INSTANCE_DIR, (eventType, filename) => accountWatchEvent(filename));
    watcher.on('error', (err) => {
      log.warn(`[update] account watch stopped (${err.message}); re-armed on the next tick`);
      try { watcher.close(); } catch { /* already dead */ }
      if (accountWatcher === watcher) accountWatcher = null;
    });
    if (typeof watcher.unref === 'function') watcher.unref(); // never keeps the app alive
    accountWatcher = watcher;
  } catch (err) {
    accountWatcher = null;
    log.warn(`[update] not watching for account changes (${err.message}); re-armed on the next tick`);
  }
}

/**
 * Latest desktop build available on the update feed, or null when there's no
 * newer version (or the app is unpackaged / the check failed). Checks WITHOUT
 * downloading (autoDownload is false), so it's safe to await before boot to
 * decide whether to fold the desktop update into the pre-start prompt.
 */
async function getDesktopUpdateVersion() {
  if (!app.isPackaged || process.windowsStore) return recordCheck({ state: 'unsupported' }).version;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return recordCheck({ state: 'unsupported' }).version; // the updater is inactive
    const latest = result.updateInfo && result.updateInfo.version;
    if (!latest) return recordCheck({ state: 'unknown', reason: 'the update feed returned no version' }).version;
    if (isNewer(app.getVersion(), latest) && result.isUpdateAvailable === false) {
      // A newer build this machine is NOT offered (staged rollout, minimumSystemVersion): downloadUpdate()
      // would fail with "Please check update first" while the engine stayed held behind it. For this
      // machine there is no desktop update.
      log.info(`[electron-updater] ${latest} is on the feed but not offered to this machine (rollout or OS requirement)`);
      return recordCheck({ state: 'current', reason: `${latest} is not offered to this machine yet` }).version;
    }
    return recordCheck(isNewer(app.getVersion(), latest) ? { state: 'available', version: latest } : { state: 'current' }).version;
  } catch (err) {
    log.warn(`[electron-updater] desktop update check failed: ${err.message}`);
    return recordCheck({ state: 'unknown', reason: `update check failed: ${err.message}` }).version;
  } finally {
    // The panel's 60s TTL stamps only a check that ANSWERED ("Check again" after a failure must
    // really ask again); the schedule's own anchors are recordCheck's business.
    if (desktopStatus.state !== 'unknown') desktopFeedCheckedAt = Date.now();
  }
}

/**
 * setDesktopStatus + feed the schedule: every check — launch, periodic or recovery — anchors the
 * cadence; a failed one starts the backoff instead (FLOWPAD-2308).
 */
function recordCheck(status) {
  const answered = setDesktopStatus(status);
  scheduleStore.write(answered.state === 'unknown'
    ? updateSchedule.recordFailure(scheduleStore.read(), { at: Date.now() })
    : updateSchedule.recordSuccess(scheduleStore.read(), { result: answered, at: Date.now() }));
  return answered;
}

// What the last desktop update check found — the input of engineChangePolicy (update-plan.js). 'unknown' until a
// check answers: a check that failed or is still running is NOT "no newer desktop".
let desktopStatus = { state: 'unknown', reason: 'not checked yet' };
// When the feed last ANSWERED — the panel's 'update:get-info' re-checks at most once a minute (the
// scheduled pass calls getDesktopUpdateVersion directly and is not throttled by this). A FAILED
// check is not stamped: "Check again" after a failure must actually ask again, not no-op silently
// for the rest of the window.
let desktopFeedCheckedAt = 0;
function setDesktopStatus(status) {
  desktopStatus = { version: null, ...status };
  updateTest.event('desktop-check', { running: app.getVersion(), ...desktopStatus });
  return desktopStatus;
}

/**
 * May the RUNNING desktop change the engine now? 'allow' | 'hold' | 'desktop-first' (update-plan.js). Anything that
 * upgrades the engine asks here, and says why it was held.
 */
function engineChangeAllowed(context, { mustInstall = false } = {}) {
  const desktop = pendingDesktopVersion ? { state: 'available', version: pendingDesktopVersion } : desktopStatus;
  const policy = engineChangePolicy({ desktop, mustInstall });
  if (policy !== 'allow') {
    const why = desktop.state === 'available'
      ? `desktop ${desktop.version} is pending`
      : `desktop update status is ${desktop.state}${desktop.reason ? ` (${desktop.reason})` : ''}`;
    log.info(`[update] engine change ${policy} (${context}): ${why}`);
    updateTest.event('engine-change', { context, policy, reason: why });
  }
  return policy;
}

/**
 * Start downloading the desktop update in the background. Requires a prior
 * getDesktopUpdateVersion() / checkForUpdates() that found an update. Nothing is asked when it lands:
 * the update flow asks once everything is staged (maybeAnnounceUpdateReady) — or, with `appliedByCaller`
 * (desktop-first, the recovery update), the caller installs it itself.
 */
function downloadDesktopUpdateInBackground({ version = null, appliedByCaller = false } = {}) {
  if (desktopDownloadInFlight) {
    log.info('[electron-updater] download already in progress; not restarting it');
    return;
  }
  const gen = ++desktopDownloadGen; // a cancelled download's late callbacks must not touch a newer one's state
  desktopDownloadInFlight = true;
  desktopDownloadVersion = version;
  const token = new CancellationToken();
  desktopDownloadToken = token;
  downloadAppliedByCaller = appliedByCaller;
  // A fresh download needs a fresh Squirrel staging (macOS): an earlier staged build is not this one —
  // and whoever still waits on the previous staging is released, not left waiting for ever.
  squirrelStaged = false;
  squirrelPendingInfo = null;
  settleSquirrelStaging(false);
  squirrelStaging = new Promise((r) => { settleSquirrelStaging = r; });
  // After a cancel, the library hands a new downloadUpdate() the CANCELLED transfer's promise until it
  // ends: start only once it has (milliseconds normally; a stalled one holds just this download, which
  // Cancel can release again — never the scheduler).
  const transfer = desktopTransferEnded
    .then(() => {
      if (token.cancelled) throw new Error('cancelled before it started');
      return autoUpdater.downloadUpdate(token);
    })
    .catch((err) => {
      if (gen !== desktopDownloadGen) return; // cancelled: already reported and reset by cancelDesktopDownload
      if (squirrelPendingInfo) { squirrelPendingInfo = null; settleSquirrelStaging(false); }
      if (token.cancelled) {
        log.info(`[electron-updater] download of ${version || 'update'} cancelled (superseded)`);
      } else {
        log.error('[electron-updater] download failed:', err);
        // This catch KNOWS the error belongs to this download — unlike the shared 'error' emitter,
        // which also carries feed-check noise. The panel's row flips to error + Retry.
        sendDesktopUpdateState({ state: 'error', error: (err && err.message) || String(err) });
      }
    })
    .finally(() => {
      if (gen !== desktopDownloadGen) return;
      desktopDownloadInFlight = false;
      desktopDownloadVersion = null;
      desktopDownloadToken = null;
    });
  desktopTransfer = transfer;
  // Settles with the transfer — or at once when the download is cancelled (cancelDesktopDownload): a
  // stalled request is not something a caller may wait on.
  desktopDownloadDone = Promise.race([transfer, new Promise((r) => { endDesktopDownloadWait = r; })]);
}

/**
 * Cancel the download in progress and release everyone waiting on it NOW — not when the transfer
 * notices: electron-updater has no timeout on Electron's net stack, and a stalled differential download
 * ignores cancel() entirely. Until that cancelled transfer really ends, the library hands every new
 * downloadUpdate() the SAME promise, so the next download starts once it has (desktopTransferEnded).
 */
function cancelDesktopDownload(why) {
  if (!desktopDownloadPending()) return false;
  log.info(`[electron-updater] download of ${pendingDownloadVersion() || 'update'} cancelled (${why})`);
  const token = desktopDownloadToken;
  const transfer = desktopTransfer; // chained on the library's own promise: settles when it does
  desktopDownloadGen++;
  desktopDownloadInFlight = false;
  desktopDownloadVersion = null;
  desktopDownloadToken = null;
  if (squirrelPendingInfo) { squirrelPendingInfo = null; settleSquirrelStaging(false); }
  try { if (token) token.cancel(); } catch (err) { log.warn(`[electron-updater] cancel failed: ${err.message}`); }
  desktopTransferEnded = transfer.then(() => {}, () => {});
  endDesktopDownloadWait();
  return true;
}

/**
 * The current download is over AND, on macOS, Squirrel has staged it or failed to — so
 * `desktopDownloadedVersion` is the final answer. (Staging is local work — verify + unzip — and always
 * ends in Squirrel's 'update-downloaded' or 'error'; no wait budget is added here.)
 */
async function desktopDownloadSettled() {
  await desktopDownloadDone;
  if (squirrelPendingInfo) await squirrelStaging;
}

/** A download the panel can adopt: still transferring, or fetched and being staged by Squirrel (macOS). */
function desktopDownloadPending() {
  return desktopDownloadInFlight || !!squirrelPendingInfo;
}
function pendingDownloadVersion() {
  return desktopDownloadVersion || (squirrelPendingInfo && squirrelPendingInfo.version) || null;
}

/**
 * First-time setup and repair of a broken install put the NEWEST engine on the machine, and the app is useless
 * without one — so instead of holding the engine back (engineChangePolicy: 'desktop-first') the desktop is
 * updated first: downloaded, then restarted into, and the NEW desktop installs the engine. Nothing is lost at
 * those moments (no engine is running, so no prompt either). Returns true when the app is quitting into the
 * update (the caller stops); false when the update did not download — the caller installs the engine anyway
 * (a missing engine is worse than a version gap).
 */
async function updateDesktopBeforeEngineInstall(reason, { notice = null } = {}) {
  const version = desktopStatus.version;
  updateTest.event('desktop-first-install', { reason, from: app.getVersion(), to: version });
  log.info(`[update] ${reason}: desktop ${app.getVersion()} → ${version} first, the engine is installed after the restart`);
  sendStatus('Updating Flowpad');
  // Said IN the window, from the first second: FlowPad is about to close and reopen. Before this the
  // window just disappeared and only an OS toast explained it — a missed toast read as a crash. The
  // download time is the reading time (no pause is added).
  sendStartupNotice({
    title: `Updating FlowPad to ${version}`,
    detail: notice || ('A newer FlowPad is available, so it is installed before the first setup. When the download ' +
      'finishes, FlowPad closes for a moment to install it and then reopens by itself — nothing is wrong.'),
    // A stalled download has no end of its own: the user can go on with this version instead.
    skipLabel: 'Skip — set up with this version',
  });
  skippableDesktopDownload = true;
  // We restart ourselves: nobody is asked about this download.
  // The loading screen shows the download's progress — an unbounded silent "Updating Flowpad" read
  // as frozen. (No watchdog here: a wait budget is a CLAUDE.md decision for the owner.)
  const onDesktopDlProgress = (p) => sendStatus(`Updating Flowpad — downloading ${Math.round(p.percent)}%`);
  autoUpdater.on('download-progress', onDesktopDlProgress);
  downloadDesktopUpdateInBackground({ version, appliedByCaller: true });
  try {
    await desktopDownloadSettled();
  } finally {
    skippableDesktopDownload = false;
    autoUpdater.removeListener('download-progress', onDesktopDlProgress);
  }
  if (isQuitting) return true;
  if (!desktopDownloadedVersion) {
    downloadAppliedByCaller = false;
    sendStartupNotice(null);
    log.warn(`[update] ${reason}: the desktop update did not download — installing the engine with this desktop`);
    return false;
  }
  sendStatus(`Installing FlowPad ${version}`);
  sendStartupNotice({
    title: `Installing FlowPad ${version}`,
    detail: 'FlowPad closes now to install the update and reopens by itself in about a minute. ' +
      'If it does not reopen, start FlowPad again.',
  });
  // The relaunched app says whether the update landed (startupUpdateNotice) — the other half of
  // "the window closed: was that a crash?".
  desktopFirstMarker.write({ from: app.getVersion(), to: version });
  // keepWindow: the loading screen, with the notice above, stays up until the quit takes it.
  // apply() resolves with the REAL outcome: 'quitting' once the quit began, 'failed' even when the
  // failure arrives after quitAndInstall returned (Squirrel, an async NSIS spawn error).
  if ((await restartApplier.apply({ keepWindow: true })) === 'quitting') return true;
  // Not applied: same fallback as a failed download — install the engine with THIS desktop instead of
  // a dead splash nobody manages.
  desktopFirstMarker.clear();
  sendStartupNotice(null);
  downloadAppliedByCaller = false;
  log.warn(`[update] ${reason}: the desktop update could not be applied — installing the engine with this desktop`);
  return false;
}

/**
 * Windows / AppImage: a downloaded update the user did not install yet goes in when FlowPad quits.
 * electron-updater's own install-on-quit hangs on Electron's 'quit' event, and our shutdown ends in
 * app.exit() — documented to skip before-quit/will-quit, silent about 'quit'. Installing it here does
 * not depend on that: quitAndInstall(silent, no relaunch) — the app quits through the installer.
 * (macOS: Squirrel applies a staged update on quit natively. deb/rpm: at the next launch instead.)
 */
function installWaitingUpdateOnExit() {
  if (!INSTALLS_ON_QUIT || squirrelStages || !app.isPackaged || process.windowsStore) return false;
  if (!desktopDownloadedVersion || restartApplier.busy || restartApplier.restartRequired || relaunchPending) return false;
  try {
    log.info(`[update] installing the downloaded ${desktopDownloadedVersion} on quit`);
    autoUpdater.quitAndInstall(true, false);
    return true;
  } catch (err) {
    log.warn(`[update] install on quit failed: ${err.message}`);
    return false;
  }
}
// A relaunch is on its way (Restart FlowPad): an installer racing the relaunched old build would fight it.
let relaunchPending = false;

/** deb/rpm: the desktop update downloaded earlier (and not installed then) — read at launch. */
const postponedDesktopStore = {
  path() { return path.join(app.getPath('userData'), 'postponed-desktop-update.json'); },
  read() { try { return JSON.parse(fs.readFileSync(this.path(), 'utf8')); } catch { return null; } },
  write(state) { try { atomicWrite(this.path(), JSON.stringify(state)); } catch (err) { log.warn(`[update] could not save the postponed update: ${err.message}`); } },
  clear() { try { fs.rmSync(this.path(), { force: true }); } catch { /* best effort */ } },
};

/**
 * deb/rpm only: a desktop update that was downloaded (or agreed alongside an engine) but not installed
 * is installed NOW, before the engine starts — one system password prompt, then the new desktop starts
 * with the agreed engine. The other platforms installed it on quit already.
 */
async function applyPostponedDesktopOnLaunch() {
  if (INSTALLS_ON_QUIT || !app.isPackaged || process.windowsStore) return false;
  const marker = postponedDesktopStore.read();
  const rec = pendingEngineStore.read();
  const agreed = rec && rec.consented && rec.desktopVersion && isNewer(app.getVersion(), rec.desktopVersion) ? rec.desktopVersion : null;
  const want = (marker && marker.version && isNewer(app.getVersion(), marker.version)) ? marker.version : agreed;
  if (!want) { if (marker) postponedDesktopStore.clear(); return false; }
  await launchDesktopCheck;
  if (desktopStatus.state !== 'available' || !desktopStatus.version || isNewer(desktopStatus.version, want)) return false;
  log.info(`[update] installing the postponed desktop update ${desktopStatus.version} before the engine starts`);
  return updateDesktopBeforeEngineInstall('installing the update you postponed', {
    notice: 'The FlowPad update you postponed is installed now. Your system asks for your password; FlowPad then reopens by itself.',
  });
}

// A loading-screen download the user may skip (desktop-first, the recovery update): Skip applies only then.
let skippableDesktopDownload = false;

/**
 * An engine the STARTUP just installed (the pre-start dialog, the pair repair) gets the same rollback
 * record the coordinated update writes: until the backend answers, the health gate can put
 * `previousEngine` back (engineRecordAtHealthGate). Before this only Update Both could roll back — any
 * other unhealthy install ended on a Quit-only screen that the next launch reached again.
 */
function noteStartupEngineInstall(previousEngine, engineVersion, phase = 'installed') {
  if (!previousEngine || !engineVersion || previousEngine === engineVersion) return;
  pendingEngineStore.write({ engineVersion, previousEngine, consented: false, phase, source: 'startup' });
}

/**
 * An engine version that installed but never became healthy (and was rolled back) is not offered again
 * until a NEWER release exists: Retry used to clear the record and the next dialog proposed the same
 * broken version straight away. The veto ends once the installed engine moves past it.
 */
function honorFailedEngineVersion() {
  const rec = pendingEngineStore.read();
  if (!rec || rec.phase !== 'failed-unhealthy' || !rec.failedVersion || !uvManager) return;
  const installed = uvManager.getInstalledVersionSync() || null;
  if (installed && !isNewer(installed, rec.failedVersion)) {
    log.info(`[update] engine ${rec.failedVersion} failed its health check: no longer vetoed (installed ${installed})`);
    pendingEngineStore.clear();
    return;
  }
  log.info(`[update] engine ${rec.failedVersion} failed its health check before — not staged again until a newer release`);
}

/** The desktop update a pre-start flow restarted into (desktop-first): read once by the next launch. */
const desktopFirstMarker = {
  path() { return path.join(app.getPath('userData'), 'desktop-first-update.json'); },
  write(state) { try { atomicWrite(this.path(), JSON.stringify(state)); } catch (err) { log.warn(`[update] could not save the update marker: ${err.message}`); } },
  take() {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(this.path(), 'utf8')); } catch { return null; }
    this.clear();
    return state;
  },
  clear() { try { fs.rmSync(this.path(), { force: true }); } catch { /* best effort */ } },
};

/**
 * After a desktop-first restart: the loading screen of the NEW launch says the update landed (or that
 * it did not, and FlowPad carries on with this version). Shown once.
 */
function startupUpdateNotice() {
  const marker = desktopFirstMarker.take();
  if (!marker || !marker.to) return null;
  if (!isNewer(app.getVersion(), marker.to)) {
    return { title: `FlowPad was updated to ${app.getVersion()}`, detail: 'Finishing the setup — this takes a moment.' };
  }
  return {
    title: `The update to FlowPad ${marker.to} did not finish`,
    detail: `FlowPad continues with version ${app.getVersion()} and offers the update again later.`,
  };
}

// ----------------------------------------------------------------------------
// Desktop wrapper version tracking.
//
// We persist the Electron app version that last ran so the next launch can
// tell whether the user just upgraded to a new desktop build. On an upgrade we
// bring the bundled flowpad (Python) package up to latest so backend and
// wrapper move in lockstep. (getPath('userData') requires app to be ready.)
// ----------------------------------------------------------------------------
function getDesktopVersionStatePath() {
  return path.join(app.getPath('userData'), 'desktop-version.json');
}
function locationPromptStatePath() {
  return path.join(app.getPath('userData'), 'app-location-prompt.json');
}
function readLastDesktopVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(getDesktopVersionStatePath(), 'utf8'));
    return (data && data.version) || null;
  } catch {
    return null;
  }
}
function writeDesktopVersion(version) {
  try {
    fs.writeFileSync(getDesktopVersionStatePath(), JSON.stringify({ version }), 'utf8');
  } catch (err) {
    log.warn(`[update] failed to persist desktop version: ${err.message}`);
  }
}

// Configuration
// A dev run is started from the repo (`npm run dev:electron`) against a backend
// the developer already has running: it does NOT own the machine's flowpad
// install, and must not start, stop or upgrade it.
const isDev = process.env.MINIHUB_DEV === 'true';
// Fixed for a packaged app; in dev it can point at a repo-run backend (e.g. the
// `oss` instance on 9008). One const feeds the start URL, the `get-backend-url`
// IPC and the open-externally guard, so they can never disagree.
const BACKEND_PORT =
  isDev && process.env.FLOWPAD_BACKEND_PORT ? Number(process.env.FLOWPAD_BACKEND_PORT) : 9007;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const BACKEND_ORIGIN = new URL(BACKEND_URL).origin;
/** True only for the backend's exact origin (scheme, host AND port) — a prefix
 *  test on the URL string would also accept ports 90070-90079. */
function isBackendUrl(url) {
  try {
    return new URL(url).origin === BACKEND_ORIGIN;
  } catch {
    return false;
  }
}
/**
 * IPC that changes what is installed (or mints a secret) answers only the app's own pages: the TOP
 * frame of a window showing the backend's origin. The preload never runs in iframes, but a window that
 * ended up on another origin (or a future preload-bearing subframe) must not be able to restart the app
 * into an installer. This does not defend against script running INSIDE the backend origin (XSS there
 * already owns the UI); it narrows everything else.
 */
function isTrustedSender(event) {
  const frame = event && event.senderFrame;
  return !!frame && !frame.parent && isBackendUrl(frame.url);
}
function assertTrustedSender(event, channel) {
  if (isTrustedSender(event)) return;
  const url = event && event.senderFrame ? redactUrl(event.senderFrame.url) : 'unknown';
  log.warn(`[ipc] ${channel} refused: untrusted sender ${url}`);
  throw new Error('untrusted sender');
}
const FLOWPAD_CLOUD_URL = process.env.FLOWPAD_CLOUD_URL || 'https://app.flowpad.ai';
const HEALTH_CHECK_INTERVAL = 500; // ms
const MAX_HEALTH_CHECKS = 240; // 120 seconds — cold-start window. Sized to ride
                               // past the first-launch AV-scan + bytecode-compile
                               // cost on Windows so a slow-but-healthy backend
                               // isn't misread as "failed to start". Observed cold
                               // boots reach health in ~35-40s, so 120s keeps a ~3x
                               // margin. Do NOT raise to mask a slow boot — fix the
                               // slow path instead. A boot that is provably still
                               // in progress gets more time on EVIDENCE, not on a
                               // bigger number: see LOG_STALL_CHECKS below.
const POST_UPGRADE_HEALTH_CHECKS = 240; // 120 seconds — the just-upgraded path is the
                                        // slower one (all venv files freshly written →
                                        // heaviest AV scan), so this is the riskiest
                                        // window to tighten; kept == the normal window.
// Past the base window the gate (backend-wait.js) keeps polling only while the
// boot reports progress: a line from `flow start` on its pipe, or growth of the
// SERVER log (BACKEND_LOGS/server, the backend's own stdout+stderr). Both
// processes write one `[boot] … phase=…` line per step forward and nothing
// while standing still (flow_sdk/boot_progress.py), so a weak machine still
// importing keeps the signal alive and a hung or dead boot goes silent.
// LOG_STALL_CHECKS is how long the signal may stay silent before the wait ends
// anyway — with progress asserted by the boot itself, 30s of silence means no
// module loaded and no phase changed for 30s. MAX_EXTENDED_HEALTH_CHECKS bounds
// the whole wait even if the signal never goes quiet (the monitor restarting an
// unhealthy backend opens a fresh log per attempt); it runs from the gate's
// start, i.e. from the `flow start` spawn, so it fires up to the launcher's
// duration before the monitor's own 600s boot ceiling. The monitor log is
// deliberately NOT the signal: it grows on every failed health check, i.e.
// fastest when the backend is broken.
const LOG_STALL_CHECKS = 60;             // 30 seconds of silence
const MAX_EXTENDED_HEALTH_CHECKS = 1200; // 10 minutes, restart loops included

// What the loading screen says for each boot phase the two processes report.
// Unlisted phases keep the previous label.
const BOOT_PHASE_LABELS = {
  // `flow start` (the launcher)
  import: 'Preparing Flowpad',
  migration: 'Updating your data',
  spawn: 'Starting server',
  wait_health: 'Starting server',
  // the server
  entities: 'Loading server',
  app: 'Loading server',
  uvicorn: 'Starting server',
  db: 'Opening the database',
  startup_hooks: 'Running startup tasks',
  done: 'Almost ready',
};
const BOOT_PHASE_RE = /\[boot\] .*?\bphase=(\S+)/;

function bootPhaseLabel(line) {
  const m = BOOT_PHASE_RE.exec(String(line || ''));
  return m ? BOOT_PHASE_LABELS[m[1]] || null : null;
}

/** The last `bytes` of `file` as text (the whole file when smaller). Throws on I/O errors. */
function readFileTail(file, bytes) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The last `[boot]` line in the newest server log, read from its tail. */
function lastBootLine(serverLogDir) {
  try {
    const newest = getNewestLogFile(serverLogDir);
    if (!newest) return null;
    const TAIL = 4096;
    const size = fs.statSync(newest.path).size;
    const fd = fs.openSync(newest.path, 'r');
    try {
      const start = Math.max(0, size - TAIL);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('[boot]'));
      return lines.length ? lines[lines.length - 1] : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

let mainWindow = null;
let uvManager = null;
let isQuitting = false;
// The in-flight quit sequence (shutdown.js), if any. A launch that arrives
// while it runs is absorbed by it instead of being dropped by the
// single-instance lock.
let shutdown = null;
// The backend stop started by the startup-timeout path, which leaves the window
// up instead of quitting. A reopen from that panel must not abandon it — see
// shutdown.js.
let pendingBackendStop = null;
// True once the startup-timeout recovery panel is showing. In this state the
// window is intentionally kept open (so the user can copy the recovery commands)
// but the backend is stopped — so a "reopen" must relaunch from scratch rather
// than refocus the dead window. See the second-instance handler.
let startupFailed = false;
// True once the backend answered its health check — from then on a quit is
// "quit FlowPad", before it "stop the startup" (quit-gate.js).
let backendReady = false;

// ── FLOWPAD-2231: fatal-failure handling, recovery update, startup journal ─────────────────────
// The journal (startup-watchdog.js) records which phase this launch reached so the next launch can
// tell a crash from a clean end; the guard keeps two `flow start`s from ever running at once; the
// launch-time desktop update check runs bounded and independent of the backend, and its answer is
// what the failure panel offers (update-recovery.js). All state files live in userData / the instance dir.
let journal = null;
const startGuard = createStartGuard({ log });
// Armed in startApp — scheduled: a recent 'current' answer is reused instead of the network
// (update-schedule.planLaunchCheck), so a restart does not reset the check interval. The recovery
// paths call forcedLaunchDesktopCheck(): their "Update FlowPad" offer is the way out of a broken
// install and never depends on the schedule.
let launchDesktopCheck = Promise.resolve(null);
let launchDesktopCheckRan = false;
function boundedDesktopCheck() {
  launchDesktopCheckRan = true;
  return updateRecovery.boundedCheck(() => getDesktopUpdateVersion(), { log, ms: updateTest.checkBoundMs() });
}
/**
 * The scheduled launch check: the real one when due or useful, the seeded persisted answer otherwise.
 * The seed can be up to one interval old. That is safe for the ENGINE gate (engineChangeAllowed):
 * the gate only orders updates (desktop first when one is pending) — the hard guarantee that no
 * engine lands that this desktop cannot run is the compat contract, enforced on every install by
 * uv-manager's resolveCompatibleEngineVersion / _assertCandidateCompatible.
 */
function startLaunchDesktopCheck() {
  const plan = updateTest.isEnabled()
    ? { run: true, reason: 'update-test' } // the update-cycle harness drives the cadence itself
    : updateSchedule.planLaunchCheck({ state: scheduleStore.read(), intervalMs: currentIntervalMs(), now: Date.now() });
  if (plan.run) return boundedDesktopCheck();
  log.info(`[update] launch desktop check skipped (${plan.reason})${plan.seed ? '; reusing the last answer' : ''}`);
  if (plan.seed) setDesktopStatus(plan.seed);
  return Promise.resolve(null);
}
/** The recovery panels' check: runs for real if the scheduled one was skipped. */
function forcedLaunchDesktopCheck() {
  if (!launchDesktopCheckRan) launchDesktopCheck = boundedDesktopCheck();
  return launchDesktopCheck;
}
function markPhase(phase, extra) { if (journal) journal.mark(phase, extra); }
function recoveryStatePath() { return path.join(app.getPath('userData'), updateRecovery.RECOVERY_FILE); }
function readRecoveryState() { return updateRecovery.readRecoveryState((p) => fs.readFileSync(p, 'utf8'), recoveryStatePath()); }
function writeRecoveryState(state) {
  try { updateRecovery.writeRecoveryState((p, t) => fs.writeFileSync(p, t, 'utf8'), recoveryStatePath(), state); }
  catch (err) { log.warn(`[update-recovery] could not persist the recovery state: ${err.message}`); }
}
function readFailureRecord() { return fatalFailure.readFailureRecord((p) => fs.readFileSync(p, 'utf8'), INSTANCE_DIR); }
function clearFailureRecord(why) {
  if (fatalFailure.clearFailureRecord((p) => fs.unlinkSync(p), INSTANCE_DIR)) log.info(`[fatal-failure] record cleared: ${why}`);
}
/** What the monitor's fingerprint is compared with: the engine venv's interpreter and the installed engine version. */
function currentRuntimeFingerprint() {
  if (!uvManager) return null;
  const venv = uvManager._toolVenvDir();
  const python = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  return { python, engine_version: uvManager.getInstalledVersionSync() || null };
}
/** The key a recovery-update attempt is remembered under: the monitor's fingerprint hash, else kind + runtime. */
function failureFingerprintKey(record) {
  const fp = (record && record.fingerprint) || currentRuntimeFingerprint() || {};
  return fp.hash || `${(record && record.kind) || 'policy-blocked'}|${fp.python || ''}|${fp.engine_version || ''}`;
}

function quitPhase() {
  if (uvManager && uvManager.isInstalling()) return 'installing';
  return backendReady ? 'running' : 'starting';
}

// Every quit asks first — see quit-gate.js and the before-quit handler.
const quitGate = createQuitGate({
  confirm: async (phase) => {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const hasInstallMarker = !!(uvManager && uvManager.hasInstallMarker());
    const { response } = await dialog.showMessageBox(parent, quitDialogOptions(phase, { hasInstallMarker }));
    return response === QUIT_RESPONSE;
  },
  log,
});
// Automation that drives the packaged app (it quits it at the end of a run) has nobody to answer the dialog.
if (process.env.FLOWPAD_SKIP_QUIT_CONFIRM === '1') quitGate.allow('FLOWPAD_SKIP_QUIT_CONFIRM=1');

// Deep link that arrived before the window was ready to navigate.
let pendingDeepLink = null;

function isStartupOnlyDeepLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'flowpad:' && ['__probe', '__launch'].includes((parsed.hostname || '').toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Convert a flowpad:// URL to the equivalent http://localhost:9007 URL and
 * navigate the main window to it.
 *
 * flowpad://task/<id>  →  http://localhost:9007/task/<id>
 */
function handleDeepLink(url) {
  log.info(`[deep-link] received: ${redactUrl(url)}`);

  // Ignore install/probe URLs.
  // These are only used by the browser to detect whether FlowPad
  // is installed and must never replace a real task/message deep link.

  if (isStartupOnlyDeepLink(url)) {
    log.info('[deep-link] ignoring startup-only url');
    return;
  }

  try {
    const parsed = new URL(url);
    // host = "task", pathname = "/<id>"  (or just "" for the root)
    const typePart = parsed.hostname || '';
    const idPart = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    const tail = `${parsed.search}${parsed.hash}`;
    const localUrl = typePart ? `${BACKEND_URL}/${typePart}${idPart}${tail}` : `${BACKEND_URL}${tail}`;

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.loadURL(localUrl);
    } else {
      // Window not ready yet — apply after startup completes.
      pendingDeepLink = localUrl;
    }
  } catch (err) {
    log.warn(`[deep-link] failed to parse URL "${redactUrl(url)}": ${err}`);
  }
}

// macOS: flowpad:// links arrive here whether the app is running or cold-starting.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows / Linux: a second launch passes the URL as a CLI argument.
app.on('second-instance', (_event, argv) => {
  // A launch that lands while we are stopping the backend must not be dropped:
  // this process still holds the single-instance lock, so the new one exits
  // immediately. Hand it to the quit sequence, which relaunches once its stop
  // has released the lifecycle lock.
  if (shutdown && shutdown.requestRelaunch()) return;
  // If we're stuck on the startup-timeout panel, a second launch means the user
  // ran the recovery command and is "reopening" to pick up the fix. The backend
  // is already stopped, so relaunch from scratch (fresh startApp + upgrade path)
  // instead of just refocusing the dead window.
  if (startupFailed) {
    log.info('[second-instance] reopen while in startup-failed state — relaunching');
    relaunchAfterStop({
      pendingStop: pendingBackendStop,
      log,
      relaunch: () => app.relaunch(),
      exit: code => app.exit(code),
    });
    return;
  }
  const deepLinkUrl = argv.find(arg => arg.startsWith('flowpad://'));
  if (deepLinkUrl) handleDeepLink(deepLinkUrl);
  // Bring the existing window to the front.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Windows / Linux COLD START: when the OS launches the app via a flowpad://
// URL for the first time, the URL is in process.argv. There's no event for
// this — we have to read it ourselves before app.whenReady fires startApp.
// (On macOS this path is dead — the URL arrives via 'open-url' instead.)
//
// handleDeepLink will see mainWindow === null and stash the URL into
// pendingDeepLink, which startApp consumes after backend warmup.
if (!isMac) {
  const argvDeepLink = process.argv.find(arg => arg.startsWith('flowpad://'));
  if (argvDeepLink) {
    log.info(`[deep-link] picked up from process.argv: ${redactUrl(argvDeepLink)}`);
    handleDeepLink(argvDeepLink);
  }
}

// --- Application menu (view-mode gated) ---------------------------------
//
// The menu is shown only in Advanced/Dev view modes. The renderer owns the
// view-mode state and pushes the current "should the menu be visible" boolean
// over the `set-menu-visible` channel (see preload.js / view-mode-context.tsx).
//
// macOS caveat: the menu lives in the system bar, and `setMenuBarVisibility`
// is a no-op there. `setApplicationMenu(null)` would strip Cmd+Q, Copy/Paste,
// window shortcuts, etc. So on macOS we always install a MINIMAL BASELINE menu
// (App / Edit / Window) even when "hidden", and swap in the fuller menu (adds
// File + View) when advanced. On Windows/Linux the in-window bar is genuinely
// hidden when not advanced.
let menuVisible = false;

function buildMenuTemplate(advanced) {
  const template = [];
  if (isMac) template.push({ role: 'appMenu' });
  if (advanced) template.push({ role: 'fileMenu' });
  template.push({ role: 'editMenu' });
  if (advanced) template.push({ role: 'viewMenu' });
  template.push({ role: 'windowMenu' });
  return template;
}

function applyMenu() {
  // Non-mac + hidden: strip the bar entirely. Otherwise install the
  // advanced-or-baseline template (advanced === menuVisible); on macOS the
  // baseline stays so Cmd+Q / Copy-Paste / window shortcuts survive.
  const menu = !menuVisible && !isMac ? null : Menu.buildFromTemplate(buildMenuTemplate(menuVisible));
  Menu.setApplicationMenu(menu);
  // No-op on macOS (menu lives in the system bar); meaningful on Win/Linux.
  if (mainWindow) mainWindow.setMenuBarVisibility(menuVisible);
}

// Electron ships Chromium's renderer without Chromium's chrome, so there is no
// default right-click menu: the spellchecker underlines misspellings but its
// suggestions have nowhere to appear. This installs the standard one.
//
// Pinned to ^3 deliberately — v4+ is ESM-only and this file is CommonJS.
//
// shouldShowMenu is the important option. Electron fires this event even when
// the renderer calls preventDefault() on the DOM contextmenu, so without a gate
// the native menu would open on top of the app's own Radix context menus
// (BrowseableGrid, TabStrip, FavoriteStar, SimpleFileManager, terminal strip).
// Limiting it to text contexts leaves those menus alone and still covers the
// case this exists for.
require('electron-context-menu')({
  shouldShowMenu: (_event, params) => params.isEditable || !!params.selectionText || !!params.misspelledWord,
  showSearchWithGoogle: false, // sends the selection to an external search
});

ipcMain.on('focus-window', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // macOS keeps another app in front of a focused window; the person asked for this one.
  if (process.platform === 'darwin') app.focus({ steal: true });
});

ipcMain.on('set-menu-visible', (_event, visible) => {
  const next = !!visible;
  if (next === menuVisible) return;
  menuVisible = next;
  applyMenu();
});

// --- Zoom shortcuts (menu-independent) ----------------------------------
//
// Cmd/Ctrl + `=`/`+` zoom in, `-` zoom out, `0` reset — in EVERY view mode and
// on every platform. The View menu's zoom roles can't own these: that menu is
// absent outside Advanced (stripped on Win/Linux, baseline-only on macOS), and
// a menu accelerator only exists while its item does. Handling the keys here
// covers every app window (main + `/win/` focus windows). preventDefault stops
// the Advanced View menu's own accelerator from firing a second step.
const ZOOM_STEP = 0.5; // Chromium's own zoom step

function zoomDeltaFor(input) {
  if (input.type !== 'keyDown' || input.alt) return null;
  if (!(isMac ? input.meta : input.control)) return null;
  if (input.key === '=' || input.key === '+') return ZOOM_STEP;
  if (input.key === '-' || input.key === '_') return -ZOOM_STEP;
  if (input.key === '0') return 0;
  return null;
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'window') return;
  contents.on('before-input-event', (event, input) => {
    const delta = zoomDeltaFor(input);
    if (delta === null) return;
    event.preventDefault();
    contents.setZoomLevel(delta === 0 ? 0 : contents.getZoomLevel() + delta);
  });
});

// THE navigation-state string for the `[nav]` trace. Module scope so `startApp`
// can log it too, not just createWindow()'s closure — one formatter, so the
// fields can never drift between call sites.
function navStateFor(win) {
  try {
    const h = win.webContents.navigationHistory;
    return `idx=${h.getActiveIndex()}/${h.length() - 1} canBack=${h.canGoBack()} canFwd=${h.canGoForward()} url=${redactUrl(win.webContents.getURL())}`;
  } catch (err) {
    return `<navState unavailable: ${err.message}>`;
  }
}

// ---- Hung renderer: detect, then restart the window clean (renderer-watchdog.js) ----
// A busy renderer main thread (a render loop froze the app on 2026-10-23) stops the page's heartbeat.
// Recovery kills that renderer and opens Home with `?safeStart=1`: the UI then neither restores the
// last tab nor runs launch redirects, and the window's history is cleared — the page that hung must
// not come back by itself.
const SAFE_START_URL = `${BACKEND_URL}/?safeStart=1`;
let recoveringFromHang = false;
const rendererWatchdog = createRendererWatchdog({
  onScreen: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
  probe: (ms) => {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(true);
    return bounded(() => mainWindow.webContents.executeJavaScript('1', true).then(() => true, () => false), ms, false);
  },
  onHang: async ({ silentMs, source }) => {
    const url = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
    log.error(`[hang] renderer hung (${source}, silent ${Math.round(silentMs / 1000)}s) url=${redactUrl(url)} — restarting the window clean`);
    await recordRendererFailure('hang', { source, silentMs }); // before the kill: the stack lives in the hung renderer
    cleanRestartWindow({ hung: true, url });
  },
});

const RENDERER_FAILURES_DIR = path.join(MAIN_DESKTOP_LOG_DIR, 'renderer-failures');
/** One JSON report per hang / crash, for later analysis (hang-report.js). Never throws. */
async function recordRendererFailure(kind, detail) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const report = await collectFailureReport({
      kind, detail, webContents: mainWindow.webContents, app, redactUrl,
      backendHealth: async () => {
        const t0 = Date.now();
        const res = await fetch(`${BACKEND_URL}/api/v1/health`);
        return { status: res.status, ms: Date.now() - t0 };
      },
    });
    const file = writeFailureReport(RENDERER_FAILURES_DIR, report);
    log.error(`[hang] ${kind} report ${file || '(could not be written)'}${typeof report.jsCallStack === 'string' ? ` — top of stack: ${report.jsCallStack.split('\n').slice(0, 3).join(' | ')}` : ''}`);
  } catch (err) {
    log.warn(`[hang] ${kind} report failed: ${err.message}`);
  }
}
ipcMain.on('renderer-heartbeat', () => rendererWatchdog.beat());

/** Load the clean start; `hung` also kills the stuck renderer first and tells the user which page was dropped. */
function cleanRestartWindow({ hung, url: hungUrl }) {
  if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  rendererWatchdog.disarm();
  recoveringFromHang = true;
  const wc = mainWindow.webContents;
  wc.once('did-finish-load', () => {
    recoveringFromHang = false;
    try { wc.navigationHistory.clear(); } catch (err) { log.info(`[hang] could not clear history: ${err.message}`); }
    log.info(`[hang] clean restart done (${hung ? 'renderer hung' : 'renderer crashed'}) ${navStateFor(mainWindow)}`);
    rendererWatchdog.arm();
    if (hung) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: 'Flowpad stopped responding and was restarted.',
        detail: `The page that stopped responding was not reopened:\n${redactUrl(hungUrl || '(unknown)')}`,
        buttons: ['OK'],
      }).catch(() => {});
    }
  });
  if (!hung) { wc.loadURL(SAFE_START_URL); return; }
  // A hung renderer cannot run an unload, and a load issued while it is still alive is dropped: kill it,
  // and load once Electron reports it gone (a fresh renderer process serves the load).
  const loadWhenGone = () => {
    log.info('[hang] renderer gone — loading the clean start');
    // Out of the gone callback: a load issued inside it races the dead process's teardown.
    setTimeout(() => wc.loadURL(SAFE_START_URL).then(
      () => log.info('[hang] clean start loaded'),
      (err) => log.error(`[hang] clean start load failed: ${err.message}`),
    ), 100);
  };
  wc.once('render-process-gone', loadWhenGone);
  try {
    wc.forcefullyCrashRenderer();
  } catch (err) {
    wc.removeListener('render-process-gone', loadWhenGone);
    log.warn(`[hang] crash renderer failed: ${err.message} — loading the clean start in place`);
    wc.loadURL(SAFE_START_URL);
  }
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // A startup re-run (Retry after the unhealthy-engine restore) reuses the window it has: a second
    // window orphaned the error panel. Back to the loading screen — startApp waits for it to load.
    mainWindow.loadFile(path.join(__dirname, 'loading.html'));
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false, // Don't show until ready
    titleBarStyle: 'default',
    backgroundColor: '#1e1e1e',
  });

  // Mouse back/forward (X1/X2) buttons. Electron does not map these to history
  // navigation, so we wire them up — and the OS surfaces them differently per
  // platform, so we listen per platform (one source each, no double-navigation).
  //
  // This is the ONLY navigator for those buttons. The renderer deliberately
  // binds nothing (see the NOTE in `ui/src/main.tsx`): on hardware that sends a
  // real X1 the button reaches the web layer too, so a second handler there
  // makes one press step history twice.
  const nav = () => mainWindow.webContents.navigationHistory;

  // [nav] tracing: every back/forward source and every resulting history
  // transition is logged so a double-navigation (e.g. "back jumps two") shows
  // up as either two trigger lines for one gesture, or one trigger followed by
  // two did-navigate lines. Pairs with the frontend toplog `navigation` tag
  // (window.history pushState/popstate from NavigationActions) — together they
  // tell us whether the main process or the renderer is double-stepping.
  const navState = () => navStateFor(mainWindow);
  const goBack = (source) => {
    const can = nav().canGoBack();
    log.info(`[nav] goBack source=${source} willNavigate=${can} ${navState()}`);
    if (can) nav().goBack();
  };
  const goForward = (source) => {
    const can = nav().canGoForward();
    log.info(`[nav] goForward source=${source} willNavigate=${can} ${navState()}`);
    if (can) nav().goForward();
  };

  // Log the actual history transitions the main process observes, regardless of
  // who triggered them (gesture, renderer history.back, react-router). These are
  // the ground truth for "how many steps did one gesture cause".
  mainWindow.webContents.on('did-navigate', (_e, url) => {
    log.info(`[nav] did-navigate (full load) url=${redactUrl(url)} ${navState()}`);
  });
  mainWindow.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    log.info(`[nav] did-navigate-in-page (SPA/pushState) url=${redactUrl(url)} ${navState()}`);
  });

  if (isMac) {
    // macOS delivers the buttons two different ways, and only ONE of them needs
    // us — proved by real-hardware capture 2026-09-03 (see the `[nav]` trace):
    //
    //  - A real X1/X2 button. Chromium ALREADY navigates on it, on mouseUp, all
    //    by itself. `webContents.on('input-event')` only OBSERVES the event — it
    //    cannot consume it — so handling mouseDown here does not replace that
    //    navigation, it ADDS one. That was the double-back: our step on
    //    mouseDown, Chromium's on mouseUp, ~100ms apart.
    //  - With drivers like Logitech Options / Options+ (or the trackpad), a
    //    `swipe` GESTURE instead — left = back, right = forward — and ONLY a
    //    swipe: no mouse button for Chromium to act on, so this handler is the
    //    only thing that makes those work.
    //
    // Hence: swipe yes, input-event no. Do NOT "restore" the input-event branch
    // without a physical press against a built artifact — CDP-injected mouse
    // events do NOT drive Chromium's native path, so under automation the
    // button looks dead without our handler. That false signal is what sent the
    // 09-02 fix down the wrong path.
    // Observation only — Chromium performs the navigation itself. The log line
    // keeps the button visible in the `[nav]` trace so a future double/missing
    // step can still be attributed.
    mainWindow.webContents.on('input-event', (_e, input) => {
      if (input.type !== 'mouseDown') return;
      if (input.button === 'back' || input.button === 'forward') {
        log.info(`[nav] mouse ${input.button} button — Chromium navigates ${navState()}`);
      }
    });
    mainWindow.on('swipe', (_e, direction) => {
      if (direction === 'left') goBack('mac:swipe');
      else if (direction === 'right') goForward('mac:swipe');
    });
  } else {
    // Windows/Linux: the buttons arrive as an app-command.
    mainWindow.webContents.on('app-command', (_e, command) => {
      if (command === 'browser-backward') goBack('app-command');
      else if (command === 'browser-forward') goForward('app-command');
    });
  }

  // Show loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the system browser instead of the Electron window.
  // Carve-out (docs/tab-management.md Part 3 §7): same-origin `/win/` focus
  // windows (navigation.openDockInWindow) are legit in-app destinations —
  // allow them so Electron opens an in-app BrowserWindow. No teardown
  // handlers on those windows: close relies on disconnect-driven PTY detach.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isBackendUrl(url)) {
      try {
        if (new URL(url).pathname.startsWith('/win/')) {
          return { action: 'allow' };
        }
      } catch {
        // Unparseable URL — fall through to the deny path below.
      }
    }
    if (/^https?:\/\//.test(url)) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Opt the app's own pages in to JS call stacks in hang reports (see the enable-features switch).
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: [`${BACKEND_ORIGIN}/*`] }, (details, callback) => {
    if (details.resourceType !== 'mainFrame') return callback({});
    callback({ responseHeaders: { ...details.responseHeaders, 'Document-Policy': ['include-js-call-stacks-in-crash-reports'] } });
  });

  // Chromium's own hang monitor: the page stopped answering input.
  mainWindow.on('unresponsive', () => {
    log.warn(`[hang] window unresponsive url=${redactUrl(mainWindow.webContents.getURL())}`);
    rendererWatchdog.hang('unresponsive');
  });

  // A crashed or failed renderer is a blank window: say so, with a way to reach us, then reload.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error(`[renderer] process gone: ${details && details.reason} (exit ${details && details.exitCode})`);
    if (isQuitting || recoveringFromHang || (details && details.reason === 'clean-exit')) return;
    void recordRendererFailure('crash', { reason: details && details.reason, exitCode: details && details.exitCode });
    showFailureDialog({
      dialog,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      title: 'Flowpad window crashed',
      message: 'The Flowpad window stopped unexpectedly.',
      detail: `Reason: ${(details && details.reason) || 'unknown'}. Flowpad will reload the window.`,
      share: (text) => shareDiagnostics(text, 'window crashed'),
      log,
      // Not reload(): the page that crashed would come straight back. A clean start opens Home.
    }).then(() => cleanRestartWindow({ hung: false }));
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted by a newer navigation */ || !isBackendUrl(url)) return;
    log.error(`[renderer] failed to load ${redactUrl(url)}: ${desc} (${code})`);
    showFailureDialog({
      dialog,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      title: 'Flowpad could not load',
      message: 'Flowpad could not load its window.',
      detail: `${desc} (${code})`,
      share: (text) => shareDiagnostics(text, 'could not load its window'),
      log,
    });
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    log.info(`[nav] will-navigate url=${redactUrl(url)}`);
    // Allow navigation to the backend (same-origin), block everything else.
    // Same-origin /win/ URLs are covered by this allow — they are in-app
    // destinations, consistent with the window-open carve-out above.
    if (!isBackendUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) {
        require('electron').shell.openExternal(url);
      }
    }
  });

  // Clear the taskbar/dock "attention" flash once the user focuses the window.
  // On Linux/Windows a new-message notification calls flashFrame(true) (there is
  // no dock to bounce); this turns it off the moment the window is focused. No-op
  // on macOS where dock bounce self-clears on focus.
  mainWindow.on('focus', () => {
    try {
      mainWindow.flashFrame(false);
    } catch (err) {
      log.warn(`[notify] flashFrame(false) on focus failed: ${err.message}`);
    }
  });

  // The X does not close the window by itself: it asks to quit, and before-quit
  // asks the user (quit-gate.js). Closing first and asking after would leave
  // nothing to cancel back to.
  mainWindow.on('close', (event) => {
    if (isQuitting || startupFailed || quitGate.isConfirmed()) return;
    event.preventDefault();
    app.quit();
  });

  // Windows is logging off or shutting down: nobody is there to answer.
  mainWindow.on('session-end', () => quitGate.allow('the Windows session is ending'));

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// The startup gate over the whole chain: `flow start` (CLI import → migrations
// → monitor spawn), then the server's own boot. One clock and one base window
// for both, and two sources of evidence that the boot is still moving — a line
// from `flow start` on its pipe (`launch`, the handle uvManager.start() returned)
// or growth of the server log — either of which extends the wait past the base
// window. A non-zero `flow start` exit ends the wait at once: the launcher
// failed, and its output is the diagnosis. Resolves
// `{ ready, reason, extended, elapsedSec, checks }` — see backend-wait.js;
// `reason` is 'healthy' | 'timeout' | 'stalled' | 'hard-cap' | 'launcher-failed'.
async function waitForBackend({
  maxChecks = MAX_HEALTH_CHECKS,
  launch = uvManager ? uvManager.lastLaunch() : null,
} = {}) {
  const baseSec = Math.round((maxChecks * HEALTH_CHECK_INTERVAL) / 1000);
  const serverLogDir = path.join(BACKEND_LOGS, 'server');
  log.info(
    `Waiting for backend at ${BACKEND_URL} (${baseSec}s, longer while flow start or ${serverLogDir} reports progress)...`,
  );

  const serverLogActivity = createLogActivityProbe({
    newestLogFile: () => getNewestLogFile(serverLogDir),
    fileSize: (file) => fs.statSync(file).size,
  });
  const launchActivity = createChangeProbe(() => (launch ? launch.lines : 0));
  // A fatal error the server log already names ends the wait at once: no point in 120 s of
  // polling when the backend died on an import that Windows application control refused
  // (runtime-repair.js). Reads the log tail only when the file changed.
  const policyBlock = createPolicyBlockProbe({
    newestLogFile: () => getNewestLogFile(serverLogDir),
    fileSize: (file) => fs.statSync(file).size,
    fileMtimeMs: (file) => fs.statSync(file).mtimeMs,
    readTail: (file) => readFileTail(file, 64 * 1024),
  });
  let policyBlockMatch = null;
  // The monitor's own verdict (fatal-failure.js): it classifies every death of the backend it spawned and
  // writes <instance>/server-failure.json when restarting cannot help. Read on every poll, so the wait ends
  // on it 0.5 s after the monitor decided — not 120 s later on a timeout.
  const failureProbe = fatalFailure.createFailureRecordProbe({ readRecord: readFailureRecord, startedAt: Date.now() });
  let failureRecord = null;

  let statusLabel = 'Waiting for server';
  const showPhase = (line) => {
    const label = bootPhaseLabel(line);
    if (label && label !== statusLabel) {
      statusLabel = label;
      sendStatus(label);
    }
  };

  const result = await runBackendGate({
    probeHealth: async () => {
      try {
        // Re-read each probe: a gated engine writes its token on the first request it serves.
        const response = await fetch(`${BACKEND_URL}/health/status`, { headers: cookieGate.gateHeaders() });
        return response.ok;
      } catch {
        return false; // Backend not ready yet
      }
    },
    logActivity: () => {
      // Both probes run on every poll so both cursors advance — no short-circuit.
      const fromLauncher = launchActivity();
      const fromServerLog = serverLogActivity();
      if (fromLauncher && launch) showPhase(launch.lastLine);
      if (fromServerLog) showPhase(lastBootLine(serverLogDir));
      return fromLauncher || fromServerLog;
    },
    aborted: () => {
      if (isQuitting) return 'quitting'; // the backend is being stopped — nothing left to wait for
      if (launch && launch.exit && launch.exit.code !== 0) return 'launcher-failed';
      failureRecord = failureProbe();
      if (failureRecord) return 'fatal-failure';
      policyBlockMatch = policyBlock();
      return policyBlockMatch ? 'policy-blocked' : null;
    },
    maxChecks,
    stallChecks: LOG_STALL_CHECKS,
    hardCapChecks: MAX_EXTENDED_HEALTH_CHECKS,
    intervalMs: HEALTH_CHECK_INTERVAL,
    onExtended: (elapsedSec) => sendStatus(`${statusLabel} — still starting (${elapsedSec}s, progress is being reported)`),
    log,
  });

  if (result.reason === 'policy-blocked') result.policyBlock = policyBlockMatch;
  if (result.reason === 'launcher-failed' && launch) {
    // The block can hit the LAUNCHER's imports (`flow start` → flow_sdk.cli → pydantic → _pydantic_core,
    // seen under Smart App Control on 2026-10-10) before any server log exists: its stderr is the evidence
    // then. Same panel, same rules.
    const inLauncher = detectPolicyBlockInLog(`${launch.stderr || ''}\n${launch.stdout || ''}`, { launcher: true });
    if (inLauncher) {
      result.reason = 'policy-blocked';
      result.policyBlock = { ...inLauncher, path: 'flow start output (the launcher)' };
      policyBlockMatch = result.policyBlock;
    }
  }
  if (result.reason === 'fatal-failure') {
    result.failureRecord = failureRecord;
    result.policyBlock = policyBlock(); // Electron's own reading of the log, to check the two agree
  }
  if (result.ready) {
    // The one place the gate cookie goes in: the backend has written its token by now, and every
    // window shares the default session, so every load after this carries it. A failure still
    // loads the UI (the backend answers 403).
    await cookieGate.injectCookie(session.defaultSession, BACKEND_URL).catch((err) => {
      log.warn(`[cookie-gate] could not set the cookie: ${err && err.message}`);
    });
    log.info(`Backend is ready! (${result.elapsedSec}s, ${result.checks} checks${result.extended ? ', extended on reported progress' : ''})`);
  } else if (result.reason === 'policy-blocked') {
    log.error(`Backend blocked by Windows application control after ${result.elapsedSec}s: ${policyBlockMatch.line} (${policyBlockMatch.path})`);
  } else if (result.reason === 'fatal-failure') {
    log.error(`Backend stopped by its monitor after ${result.elapsedSec}s: ${failureRecord.kind} — ${failureRecord.reason} (${failureRecord.excerpt || 'no excerpt'})`);
  } else if (result.reason === 'quitting') {
    log.info(`[startup] stopped waiting for the backend: the app is quitting (${result.elapsedSec}s)`);
  } else {
    log.error(`Backend failed to start: ${result.reason} after ${result.elapsedSec}s (${result.checks} checks)`);
  }
  return result;
}

function sendStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('startup-status', message);
  }
}

/** The loading screen's update notice ({title, detail}, or null to hide it) — see loading.html. */
function sendStartupNotice(notice) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('startup-notice', notice);
  }
}

// Progress ticker for a `uv tool install` shown on the loading screen: uv's own
// per-step lines ("Downloading flowpad (34.6MiB)", "Resolved 132 packages…")
// under a fixed label, so a long install on a slow link is visibly alive
// instead of a frozen spinner. The install itself has no wall-clock cap.
function installProgress(label) {
  sendStatus(label);
  return (line) => sendStatus(`${label} — ${line}`);
}

// Render the in-app startup error panel (loading.html) instead of the bland
// native OS error box. Gives the user the two exact, copy-pasteable recovery
// commands — upgrade first, then `flow diagnose` — each with a copy button.
// `retryable` adds a Retry button that re-runs the install/start in-app (see
// installAndStartBackend). Falls back to the native dialog only if the loading
// window is already gone; returns whether the panel was rendered.
async function showStartupErrorPanel(detail, { retryable = false, policyBlocked = false, repairable = false, extras = null } = {}) {
  const payload = {
    detail,
    retryable,
    policyBlocked, // hides the "upgrade / diagnose" steps: neither helps when policy blocks the launchers
    repairable,    // shows "Repair FlowPad" (runtime-repair.js): Windows blocked the engine's Python, once per version
    upgradeCommand: upgradeCommand(),
    diagnoseCommand: DIAGNOSE_COMMAND,
    logPath: MAIN_DESKTOP_LOG_DIR,
    // Recovery extras (FLOWPAD-2231): retryLabel / retryWarning, updateVersion (an "Update FlowPad" button),
    // exportable ("Export logs"), fatalKind.
    ...(extras || {}),
  };
  startupFailed = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('startup-error', payload);
    mainWindow.show();
    mainWindow.focus();
    return true;
  }
  // No window to render into — degrade to the native dialog.
  // Awaited: the caller quits the app when this returns false, and quitting before the user answers would
  // close the one dialog that explains the failure (and the "Send Report" button on it).
  await showFailureDialog({
    dialog,
    title: 'Flowpad couldn’t start',
    message: 'Flowpad couldn’t start.',
    detail:
      `${detail}\n\n` +
      `1) Upgrade Flowpad, then relaunch:\n   ${upgradeCommand()}\n\n` +
      `2) If that doesn’t work, run:\n   ${DIAGNOSE_COMMAND}`,
    share: (text) => shareDiagnostics(text, 'did not start'),
    log,
  });
  return false;
}

function waitForRetryRequest() {
  return new Promise((resolve) => ipcMain.once('retry-startup', () => resolve()));
}

/** 'retry', 'repair' or 'update', whichever panel button the user presses first; the other listeners are dropped. */
function waitForPanelAction() {
  return new Promise((resolve) => {
    const channels = { 'retry-startup': 'retry', 'repair-runtime': 'repair', 'update-desktop-recovery': 'update' };
    const handlers = {};
    const settle = (action) => {
      for (const [ch, h] of Object.entries(handlers)) ipcMain.removeListener(ch, h);
      resolve(action);
    };
    for (const [ch, action] of Object.entries(channels)) {
      handlers[ch] = () => settle(action);
      ipcMain.once(ch, handlers[ch]);
    }
  });
}

// A deterministic backend failure (FLOWPAD-2231). Two sources, one panel:
//   - `record`: the monitor's verdict (<instance>/server-failure.json, fatal-failure.js) — it stopped restarting
//     the backend and says why (policy-blocked, interpreter-blocked, native-missing, unsupported-arch, crash-loop);
//   - `match`: Electron's own reading of the server log (runtime-repair.js detectPolicyBlockInLog), the fallback
//     when there is no record (an older engine), and the traceback shown for policy kinds.
// The panel names the cause with the traceback and the Code Integrity events, and offers, as applicable:
//   Repair FlowPad (Windows, repairable kinds, once per app+engine version — runtime-repair.js),
//   Update FlowPad to X (the desktop updater, checked without the backend, ONCE per version and failure —
//   update-recovery.js; never claimed to fix a blocked runtime), Retry anyway (with the warning that an
//   unchanged runtime will fail the same way), Export logs / Send Report.
// Resolves true when the backend is healthy again; false when the app is quitting (or quitting into an update).
// `retry`, for a block that hit the engine INSTALL (nothing to start yet): what "Retry anyway" runs instead of
// starting the engine — it re-runs the install and resolves `{ ok, installBlock? }` like installAndStartBackend.
// Such a block never launched a backend, so nothing is stopped: a bare `flow stop` would kill whatever holds the port.
// `autoRepair`: the block hit the FIRST install, so there is no engine to lose: the repair (the signed PSF runtime)
// runs at once, without the panel and the click; the panel appears only if the repair itself fails. It is tried once.
async function handleFatalFailure({ match: firstMatch, record: firstRecord, retry = null, autoRepair = false }) {
  let match = firstMatch;
  let record = firstRecord;
  let extraDetail = '';
  let autoRepairPending = !!autoRepair;
  const stopBackend = () => {
    if (retry && !(uvManager && uvManager.hasLaunchedBackend())) return;
    if (uvManager) pendingBackendStop = uvManager.stop().catch((e) => log.warn(`[fatal-failure] backend stop failed: ${e.message}`));
  };
  stopBackend(); // the monitor has stopped already on a record; on Electron's own match it would keep restarting
  for (;;) {
    const kind = record ? record.kind : 'policy-blocked';
    const policy = fatalFailure.isPolicyKind(kind);
    // Every time the panel is (re)shown — after a failed repair or a failed retry too — the journal's phase is
    // terminal again: the user is looking at the panel, so a quit or a kill from here is not a crash.
    markPhase('fatal-failure', { kind, source: record ? 'monitor' : 'electron', retried: !!extraDetail });
    const versions = {
      appVersion: app.getVersion(),
      engineVersion: (uvManager && uvManager.getInstalledVersionSync()) || 'unknown',
    };
    const state = readRuntimeState((p) => fs.readFileSync(p, 'utf8'), FLOW_HOME);
    // Repair = a signed interpreter. It helps when the blocked module ships with the interpreter; a block on
    // a third-party wheel's module (_pydantic_core, seen under Smart App Control two days after the
    // pydantic-core release) is not changed by it, so it is not offered (describeRuntimeBlock says why).
    const blockedModule = record ? record.module : (match && match.module);
    const moduleRepairable = !blockedModule || isInterpreterModule(blockedModule);
    const repairable = process.platform === 'win32' && !!uvManager && fatalFailure.isRepairableKind(kind) && moduleRepairable && canAttemptRepair(state, versions);
    // The desktop update as a way out: bounded, no backend needed; forced — a launch check the
    // schedule skipped is run now, the failure panel never trusts a stale answer. Offered once per
    // target version and failure fingerprint, never as a downgrade.
    const fingerprintKey = failureFingerprintKey(record);
    const latest = await forcedLaunchDesktopCheck();
    const plan = updateRecovery.planRecoveryUpdate({ state: readRecoveryState(), appVersion: app.getVersion(), latestVersion: latest, fingerprint: fingerprintKey, isNewer });
    const updateVersion = plan.action === 'offer' ? plan.version : null;

    let detail;
    if (policy && match) {
      // Windows Code Integrity events 3077/3089 name the exact blocked binary and the policy id —
      // the evidence that tells Smart App Control from an organization's policy.
      const ciEvents = uvManager ? await uvManager.codeIntegrityEvents(30) : '';
      detail = describeRuntimeBlock(match, { repairable, priorFailure: priorAttempt(state, versions) });
      if (record && record.restarts_stopped) {
        const n = Number(record.attempts) || 1;
        detail += `\n\nThe engine's supervisor stopped restarting it after ${n} attempt${n === 1 ? '' : 's'}: the same block repeats. ${fatalFailure.RETRY_WARNING}`;
      }
      detail +=
        (extraDetail ? `\n\n${extraDetail}` : '') +
        `\n\nEvidence — ${match.path}:\n${match.traceback}` +
        `\n\nWindows Code Integrity events (3077/3089, last 30 min):\n${ciEvents || '(none readable — the policy may not log to the Operational channel, or the log is empty)'}`;
    } else {
      detail = fatalFailure.describeFatalFailure(record || { kind, fatal: true, reason: (match && match.line) || 'The FlowPad engine stopped.' }) +
        (extraDetail ? `\n\n${extraDetail}` : '');
    }
    detail += `\n\n${updateRecovery.recoveryNote(kind, updateVersion)}`;
    if (plan.why === 'already-attempted') {
      detail += ` An update to ${latest} was already attempted for this failure (${plan.prior.at}, ${plan.prior.outcome}); it is not offered again.`;
    }
    log.error(`[fatal-failure] ${detail}`);
    let action;
    if (autoRepairPending && repairable) {
      autoRepairPending = false;
      log.info('[runtime-repair] the first install was blocked: repairing automatically (no engine to lose)');
      action = 'repair';
    } else {
      autoRepairPending = false;
      const shown = await showStartupErrorPanel(detail, {
        retryable: true,
        policyBlocked: policy,
        repairable,
        extras: { retryLabel: 'Retry anyway', retryWarning: fatalFailure.RETRY_WARNING, updateVersion, exportable: true, fatalKind: kind },
      });
      if (!shown) {
        app.quit();
        return false;
      }
      action = await waitForPanelAction();
    }
    if (isQuitting) return false;
    startupFailed = false;
    await pendingBackendStop;

    if (action === 'update' && updateVersion) {
      const r = await runRecoveryUpdate({ version: updateVersion, fingerprint: fingerprintKey });
      if (r.ok) return false; // quitting into the installer
      extraDetail = `Update to ${updateVersion} failed: ${String(r.error).split('\n')[0]}. The logs can still be exported.`;
      continue;
    }

    // Repair or Retry: the user's explicit act. The monitor refuses to start a runtime it recorded as fatally
    // failed (launch.py refuse_start_reason) — clearing the record is how that consent reaches it.
    clearFailureRecord(`the user chose ${action}`);

    if (action === 'repair' && repairable) {
      log.info(`[runtime-repair] user asked for the repair (${(match && (match.module || match.line)) || kind})`);
      sendStatus('Repairing the FlowPad runtime');
      try {
        const result = await uvManager.repairRuntime({
          versions,
          onProgress: (m) => sendStatus(`Repairing the FlowPad runtime — ${m}`),
          startBackend: async () => { sendStatus('Starting flowpad'); markPhase('backend-start', { repair: true }); await uvManager.start(); },
          healthCheck: async () => {
            const w = await waitForBackend({ maxChecks: POST_UPGRADE_HEALTH_CHECKS });
            if (backendWaitAborted(w)) throw new Error('the app is quitting');
            if (w.reason === 'policy-blocked') { match = w.policyBlock; record = null; }
            if (w.reason === 'fatal-failure') { record = w.failureRecord; match = fatalFailure.reconcileFatalReason({ record, probeMatch: w.policyBlock }).match; }
            return w.ready;
          },
        });
        log.info(`[runtime-repair] done: ${result.reused ? 'reused' : 'installed'} ${result.python}`);
        return true;
      } catch (err) {
        if (isQuitting) return false;
        log.error(`[runtime-repair] failed at ${err.step || 'repair'}: ${err.message}`);
        stopBackend();
        extraDetail =
          `Repair failed at step "${err.step || 'repair'}": ${String(err.message).split('\n')[0]}` +
          (err.rolledBack ? '\nThe previous engine was restored.' : '') +
          (err.policyBlocked
            ? '\nThe policy also blocked the repair itself. If this computer is managed by an organization, IT approval may be required before FlowPad can run.'
            : '') +
          '\nUse “Send Report” or “Export logs” to send the logs.';
        continue;
      }
    }

    // Retry anyway: start the engine again and wait for it; a repeat failure shows the panel again.
    sendStatus('Retrying');
    markPhase('backend-start', { retry: true });
    try {
      if (retry) {
        // The install is what was blocked: run it again (uv keeps what it fetched); a repeat block shows the panel again.
        const r = await retry();
        if (!r.ok) {
          if (r.installBlock) { match = r.installBlock; record = null; extraDetail = ''; }
          else extraDetail = `The install failed again: ${r.error ? describeStartupFailure(r.error) : 'see the logs'}`;
          continue;
        }
      } else {
        await uvManager.start();
      }
    } catch (err) {
      extraDetail = describeStartupFailure(err);
      continue;
    }
    // A retry that re-ran the install boots an engine that was just unpacked: the same wider window as after any
    // install (PyPI fetch, bytecode warm-up, antivirus scan on Windows).
    const w = await waitForBackend(retry ? { maxChecks: POST_UPGRADE_HEALTH_CHECKS } : undefined);
    if (backendWaitAborted(w)) return false;
    if (w.ready) return true;
    stopBackend();
    if (w.reason === 'fatal-failure') {
      record = w.failureRecord;
      match = fatalFailure.reconcileFatalReason({ record, probeMatch: w.policyBlock }).match;
      extraDetail = '';
    } else if (w.reason === 'policy-blocked') {
      match = w.policyBlock;
      record = null;
      extraDetail = '';
    } else {
      extraDetail = `Flowpad’s backend didn’t respond within ${w.elapsedSec} seconds (${w.reason}).`;
    }
  }
}

/**
 * The recovery update: download `version` through the existing updater (electron-updater verifies it
 * against latest.yml's sha512 and, on Windows, the installer's signature), then stop the backend and
 * quitAndInstall. The attempt is recorded BEFORE anything is downloaded (update-recovery.js), so a crash,
 * an interrupted download or a relaunch into the same failure can never start it a second time.
 */
async function runRecoveryUpdate({ version, fingerprint }) {
  writeRecoveryState(updateRecovery.recordRecoveryAttempt(readRecoveryState(), { targetVersion: version, fingerprint, fromVersion: app.getVersion() }));
  markPhase('recovery-update', { version });
  sendStatus(`Downloading FlowPad ${version}`);
  try {
    if (!app.isPackaged || process.windowsStore) throw new Error('desktop updates are not available for this build');
    downloadDesktopUpdateInBackground({ version, appliedByCaller: true });
    sendStartupNotice({
      title: `Downloading FlowPad ${version}`,
      detail: 'When the download finishes, FlowPad closes to install it and reopens by itself.',
      skipLabel: 'Cancel the update',
    });
    skippableDesktopDownload = true;
    try {
      await desktopDownloadSettled();
    } finally {
      skippableDesktopDownload = false;
    }
    if (desktopDownloadedVersion !== version) {
      sendStartupNotice(null);
      throw new Error('the download did not complete (see the updater lines in the log)');
    }
    log.info(`[update-recovery] ${version} downloaded and verified by the updater; installing and relaunching`);
    sendStatus(`Installing FlowPad ${version}`);
    sendStartupNotice({
      title: `Installing FlowPad ${version}`,
      detail: 'FlowPad closes now to install the update and reopens by itself in about a minute. If it does not reopen, start FlowPad again.',
    });
    // A failure inside the updater's own 'error' event (a cancelled pkexec, no $APPIMAGE, no dpkg) is
    // 'failed', not success: the attempt is marked failed below instead of leaving a dead recovery screen.
    const outcome = await restartApplier.apply({ keepWindow: true });
    if (outcome !== 'quitting') sendStartupNotice(null);
    if (outcome === 'busy') throw new Error('another install is already in progress');
    if (outcome !== 'quitting') throw new Error('the update could not be installed (see the updater lines in the log)');
    return { ok: true };
  } catch (err) {
    log.error(`[update-recovery] failed: ${err.message}`);
    writeRecoveryState(updateRecovery.markAttemptOutcome(readRecoveryState(), { targetVersion: version, fingerprint, outcome: 'failed', detail: String(err.message).slice(0, 300) }));
    markPhase('recovery-failed', { version, error: String(err.message).slice(0, 200) });
    return { ok: false, error: err.message };
  }
}

/**
 * Recovery mode (startup-watchdog.js): the previous launches died before showing anything, or the app was
 * started with --recovery. The panel first — Update / Export logs / Share — and the backend only on "Start".
 * Resolves true to continue the normal start, false when quitting (or quitting into an update).
 */
async function showRecoveryEntry(why) {
  let extraDetail = '';
  for (;;) {
    const latest = await forcedLaunchDesktopCheck(); // a skipped launch check is run for real: recovery never trusts a stale answer
    const fingerprintKey = `recovery|${app.getVersion()}`;
    const plan = updateRecovery.planRecoveryUpdate({ state: readRecoveryState(), appVersion: app.getVersion(), latestVersion: latest, fingerprint: fingerprintKey, isNewer });
    const updateVersion = plan.action === 'offer' ? plan.version : null;
    const detail =
      `FlowPad is starting in recovery mode: ${why}.\n\n` +
      'Nothing has been started yet. You can export the logs, update FlowPad if a newer version is available, ' +
      'or start FlowPad normally.' +
      (extraDetail ? `\n\n${extraDetail}` : '') +
      `\n\n${updateRecovery.recoveryNote('recovery', updateVersion)}`;
    log.warn(`[recovery] ${detail}`);
    const shown = await showStartupErrorPanel(detail, {
      retryable: true,
      policyBlocked: true, // no "upgrade the engine" steps: nothing is known about the engine yet
      extras: { retryLabel: 'Start FlowPad', updateVersion, exportable: true, fatalKind: 'recovery' },
    });
    if (!shown) { app.quit(); return false; }
    const action = await waitForPanelAction();
    if (isQuitting) return false;
    startupFailed = false;
    if (action === 'update' && updateVersion) {
      const r = await runRecoveryUpdate({ version: updateVersion, fingerprint: fingerprintKey });
      if (r.ok) return false;
      extraDetail = `Update to ${updateVersion} failed: ${String(r.error).split('\n')[0]}.`;
      continue;
    }
    return true;
  }
}

// Install (first launch) or upgrade the flowpad package and start the backend.
// Resolves { ok: true, backendJustUpgraded } — or { ok: false } after rendering
// the error panel with a Retry button, so startApp() can run it again. A fresh
// UvManager per attempt: nothing from a failed attempt leaks into the retry.
// A step of the install (uv itself, `uv tool install`, the broken-install reinstall): an error from it is tagged,
// so the catch below can tell "the install was blocked" from "the engine's launcher was blocked" (start()'s own
// policyBlockedError, whose text also says Device Guard, keeps its own path and its own evidence).
async function installStep(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object') err.fromInstall = true;
    throw err;
  }
}

/**
 * The installed engine needs a newer desktop than this one, and the update feed did not offer one: ask before
 * moving the engine backward. Resolves true to switch, false to keep the installed engine (Esc = keep).
 */
async function confirmEngineSwitch(issue, picked) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'FlowPad needs an update',
    message: `The installed FlowPad engine (${issue.engineVersion}) needs a newer FlowPad Desktop than this one (${app.getVersion()}).`,
    detail:
      `${issue.reasons.join('\n')}\n\n` +
      `Updating the desktop app is the best fix. Or FlowPad can switch to engine ${picked.version}, which works with this ` +
      'desktop. That is a downgrade: the newer engine may have changed files the older one cannot read.',
    buttons: [`Switch to engine ${picked.version}`, 'Keep the current engine'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

// `quiet`: the caller (the repair panel's Retry) shows its own panel for a failure — no second panel from here.
async function installAndStartBackend({ quiet = false } = {}) {
  let backendJustUpgraded = false;
  let firstInstall = false;
  // Install and start backend via uv + flow CLI
  uvManager = new UvManager(log, { stateDir: FLOW_HOME, appVersion: app.getVersion() });

  // Did the user just upgrade to a new desktop build? Logged for diagnostics.
  // The engine version saved for this desktop (if any) is installed below.
  const lastDesktopVersion = readLastDesktopVersion();
  const desktopUpgraded =
    app.isPackaged && lastDesktopVersion && lastDesktopVersion !== app.getVersion();
  if (desktopUpgraded) {
    log.info(`[update] desktop upgraded ${lastDesktopVersion} → ${app.getVersion()}`);
  }

  try {
    // FAST PATH: check if flow binary exists on disk (no subprocess, just fs.existsSync)
    let flowBin = uvManager.getInstalledFlowBin();

    // A previous run quit (or died) in the middle of an install: the tool venv
    // may be half-replaced. Repair it before anything reads or starts it.
    if (flowBin && uvManager.hadInterruptedInstall()) {
      sendStatus('Repairing Flowpad installation');
      try {
        await uvManager.repairIfInterrupted({ onProgress: installProgress('Repairing Flowpad installation') });
        backendJustUpgraded = true;
        flowBin = uvManager.getInstalledFlowBin() || flowBin;
      } catch (repairErr) {
        // Offline, or uv itself is unavailable: start what is installed (it may be perfectly
        // fine) instead of failing every launch. The marker is kept, so the repair is
        // retried next launch; a truly broken venv still hits the broken-install path below.
        log.warn(`[uv] repair of the interrupted install failed, starting the current install: ${repairErr.message}`);
      }
    }

    if (flowBin) {
      log.info(`Fast path: flow binary found at ${flowBin}`);

      // FLOWPAD-2231: the last run's backend died for a reason restarting cannot change, and the runtime
      // (interpreter + engine version) is the same: do not start it again — startApp shows the panel on
      // the record. (The monitor would refuse too: launch.py refuse_start_reason.) A record for another
      // runtime is stale and is cleared.
      const prior = readFailureRecord();
      if (prior && fatalFailure.isFatalRecord(prior)) {
        if (fatalFailure.recordMatchesRuntime(prior, currentRuntimeFingerprint())) {
          log.error(`[fatal-failure] the last backend stopped deterministically (${prior.kind} at ${prior.at}) and the runtime is unchanged — not starting it again`);
          uvManager.useFlowBin(flowBin); // the panel's "Retry anyway" starts this binary
          return { ok: false, fatalRecord: prior };
        }
        clearFailureRecord('the runtime changed since the recorded failure');
      }

      let activeBin = flowBin;

      // ── The desktop was just updated: install the engine version that was saved for it ──
      // When the desktop update started, the engine version X chosen for it was saved and agreed (whatever
      // the answer to the one question, the next start runs both). Install exactly X now, with THIS desktop
      // (its Python pin, its start contract). An unagreed record is dropped: the post-boot check stages the
      // engine and asks. See update-plan.js. A failure keeps the current engine; the next check stages it again.
      if (await applyPostponedDesktopOnLaunch()) return { ok: false };
      honorFailedEngineVersion();
      const enginePlan = planAfterDesktopUpdate({
        state: pendingEngineStore.read(),
        appVersion: app.getVersion(),
        installedEngine: uvManager.getInstalledVersionSync(flowBin),
        isNewer,
      });
      if (enginePlan.clear && enginePlan.action !== 'install') pendingEngineStore.clear();
      if (enginePlan.action === 'install') {
        log.info(`[update] installing the engine version agreed before the restart: ${enginePlan.version}`);
        updateTest.event('agreed-engine-install', { version: enginePlan.version, desktop: app.getVersion() });
        sendStatus(`Updating the FlowPad engine to ${enginePlan.version}`);
        // DEMOTE FIRST, then install: a crash mid-install leaves a QUESTION for the next launch
        // (consented:false → 'dialog'), and a disk that cannot persist the demotion must not get a
        // silent install it could re-run on every launch. previousEngine is what the health gate
        // restores if the new engine installs fine but never answers.
        const saved = pendingEngineStore.read() || {};
        const previousEngine = uvManager.getInstalledVersionSync(flowBin) || null;
        pendingEngineStore.write({ ...saved, consented: false, phase: 'installing', previousEngine });
        const demoted = pendingEngineStore.read();
        if (!demoted || demoted.consented !== false) {
          log.warn('[update] could not persist the install attempt — the engine dialog will ask instead of a silent install');
        } else {
          try {
            // Prepared in the background before the restart (prepareEngine): installs offline, in seconds.
            const prepared = saved.prepared && saved.prepared.version === enginePlan.version ? saved.prepared : null;
            await uvManager.upgrade({ version: enginePlan.version, prepared, onProgress: installProgress('Updating the FlowPad engine') });
            // NOT spent yet: the record (phase 'installed') holds previousEngine until the backend is
            // HEALTHY — an engine that installs fine but never answers is rolled back at that gate.
            pendingEngineStore.write({ ...demoted, phase: 'installed' });
            activeBin = uvManager.getInstalledFlowBin() || flowBin;
            backendJustUpgraded = true;
            if (enginePlan.source === 'panel' || enginePlan.source === 'engine') {
              // 'engine': a prepared engine-only update the user postponed ("Later") — the desktop did not change.
              resumedPanelUpdate = { kind: enginePlan.source === 'engine' ? 'engine' : 'coordinated', success: true, engineVersion: enginePlan.version, desktopVersion: app.getVersion() };
            }
          } catch (upgradeErr) {
            log.warn(`[uv] installing the agreed engine ${enginePlan.version} failed, starting the current engine: ${upgradeErr.message}`);
            // Already demoted on disk — the next launch ASKS ("FlowPad will offer it again" is true).
            if (enginePlan.source === 'panel' || enginePlan.source === 'engine') {
              resumedPanelUpdate = { kind: enginePlan.source === 'engine' ? 'engine' : 'coordinated', success: false, engineVersion: enginePlan.version, desktopVersion: app.getVersion(), error: upgradeErr.message };
            }
          }
        }
      }

      // ── Updates found at launch ─────────────────────────────────────────
      // Two independent channels: the desktop wrapper (electron-updater / GitHub) and the flowpad engine
      // (PyPI). Nothing here asks or blocks the start: once the app's UI is up, a newer desktop is downloaded
      // with the engine that will run on it (beginBackgroundUpdate), or a newer engine alone is staged (the
      // post-boot check) — and the user is asked once, when it is ready. The pre-start path keeps only what
      // cannot wait: a missing or broken engine (installed below) and an incompatible pair (repaired below).
      // The check was started at launch, bounded and independent of the backend (startApp); its answer is
      // reused here rather than checked a second time.
      const desktopLatest = await launchDesktopCheck;
      if (isQuitting) return { ok: false };
      desktopUpdateAfterLaunch = desktopLatest || null;

      // ── Installed-pair compatibility (engine-compat.js) ────────────────
      // A desktop downgrade, or an engine moved by hand (`uv tool install flowpad==X`), can leave
      // a pair the contract forbids. The repair installs the newest compatible release, under the
      // same gate every other engine change obeys -- and it has a DIRECTION:
      //   - the ENGINE is the old side (below the desktop's floor): upgrading it is the safe fix, done silently;
      //   - the DESKTOP is the old side (the engine demands a newer desktop): the repair moves the engine
      //     BACKWARD, and a newer engine may already have written state an older one cannot read -- ask first.
      //     (When the desktop feed knows a newer desktop, engineChangeAllowed() holds and the desktop update
      //     offer above is the fix; this question is for a feed that says "current" while the engine disagrees.)
      // When the repair is unavailable or declined (held for a pending desktop update, offline, "Keep"), start
      // what is installed and warn -- a running old pair beats a bricked app, and the next launch retries.
      const pairIssue = uvManager.installedPairIssue(activeBin);
      if (pairIssue) {
        log.warn(`[compat] installed desktop/engine pair is incompatible: ${pairIssue.reasons.join('; ')}`);
        // The repair installs a release chosen to fit the RUNNING desktop, so when the ENGINE is the
        // old side a pending/unknown newer desktop is irrelevant — holding the repair behind a failed
        // GitHub feed check left an incompatible pair running with only a log line. Only the backward
        // move (the DESKTOP is the old side → the engine would move DOWN) defers to desktop-first.
        const mayRepair = pairIssue.desktopTooOld
          ? engineChangeAllowed('repairing an incompatible engine') === 'allow'
          : true;
        if (mayRepair) {
          try {
            const picked = await uvManager.resolveCompatibleEngineVersion();
            if (picked && picked.version !== pairIssue.engineVersion) {
              const go = pairIssue.desktopTooOld ? await confirmEngineSwitch(pairIssue, picked) : true;
              if (isQuitting) return { ok: false };
              if (go) {
                sendStatus('Installing a compatible FlowPad engine');
                const engineBeforeRepair = uvManager.getInstalledVersionSync(activeBin) || null;
                // Recorded BEFORE the install: a kill between the install and the record left an engine
                // with no way back.
                noteStartupEngineInstall(engineBeforeRepair, picked.version, 'installing');
                try {
                  await uvManager.upgrade({ version: picked.version, onProgress: installProgress('Installing a compatible FlowPad engine') });
                } catch (repairErr) {
                  const rec = pendingEngineStore.read();
                  if (rec && rec.phase === 'installing' && rec.source === 'startup') pendingEngineStore.clear();
                  throw repairErr;
                }
                activeBin = uvManager.getInstalledFlowBin() || activeBin;
                backendJustUpgraded = true;
                noteStartupEngineInstall(engineBeforeRepair, picked.version, 'installed');
              } else {
                log.warn(`[compat] the user kept engine ${pairIssue.engineVersion}, which needs a newer desktop than ${app.getVersion()}`);
              }
            }
          } catch (compatErr) {
            log.warn(`[compat] could not repair the incompatible pair, starting the installed engine: ${compatErr.message}`);
          }
        }
        // Whatever path was taken, a pair that is STILL incompatible starts with a visible warning
        // ('update:get-info' reads the live pair state and the panel shows it) — "start what is
        // installed and warn" used to warn only the log.
        if (uvManager.installedPairIssue(activeBin)) {
          log.warn('[compat] starting an incompatible pair — the version panel shows the warning');
        }
      }

      const version = uvManager.getInstalledVersionSync(activeBin);
      const versionSuffix = version ? ` v${version}` : '';
      sendStatus(`Starting flowpad${versionSuffix}`);
      markPhase('backend-start', { engine: version || null });
      try {
        await uvManager.startWithBin(activeBin);
      } catch (startErr) {
        // A shim exists on disk (so we took the fast path), but its env can't
        // import flow_sdk — a corrupt/half-finished install. Without this the
        // app would crash on the same broken shim every launch and never
        // self-heal (a --force reinstall only runs in the first-time branch).
        // Repair once and retry; if it still fails, fall through to the dialog.
        if (!uvManager.isBrokenInstallError(startErr)) throw startErr;
        log.warn('Detected broken flow install (cannot import flow_sdk); reinstalling…');
        // The repair puts the NEWEST engine on the machine: a pending desktop update goes first, and the repair
        // runs after the relaunch, with the new desktop.
        if (engineChangeAllowed('repairing a broken install', { mustInstall: true }) === 'desktop-first'
            && await updateDesktopBeforeEngineInstall('repairing a broken install')) {
          return { ok: false };
        }
        sendStatus('Repairing Flowpad installation');
        await installStep(() => uvManager.ensureUv({ onProgress: installProgress('Repairing Flowpad installation') }));
        await installStep(() => uvManager.reinstall({ onProgress: installProgress('Repairing Flowpad installation') }));
        backendJustUpgraded = true;
        const repairedVersion = uvManager.getInstalledVersionSync();
        sendStatus(`Starting flowpad${repairedVersion ? ` v${repairedVersion}` : ''}`);
        await uvManager.start();
      }
    } else {
      // FIRST-TIME SETUP: uv tool install flowpad (latest)
      log.info('First-time setup: flow binary not found, installing latest from PyPI');
      sendStatus('Setting up Flowpad (first time)');

      // The install puts the NEWEST engine on the machine: a pending desktop update goes first, and the engine
      // is installed after the relaunch, with the new desktop. (The launch check ran in parallel; it is bounded.)
      await launchDesktopCheck;
      if (engineChangeAllowed('first-time setup', { mustInstall: true }) === 'desktop-first'
          && await updateDesktopBeforeEngineInstall('first-time setup')) {
        return { ok: false };
      }

      firstInstall = true;
      sendStatus('Checking Python installation');
      await installStep(() => uvManager.ensureUv({ onProgress: installProgress('Setting up Flowpad — installing uv') }));

      // A few seconds to learn whether the interpreter even runs (Windows application control): a blocked one goes
      // straight to the repair instead of failing a download-and-unpack of ~160 packages first.
      await installStep(() => uvManager.probeManagedInterpreter());
      await installStep(() => uvManager.installLatest({ onProgress: installProgress('Installing Flowpad') }));
      backendJustUpgraded = true;

      const version = uvManager.getInstalledVersionSync();
      const versionSuffix = version ? ` v${version}` : '';
      sendStatus(`Starting flowpad${versionSuffix}`);
      markPhase('backend-start', { engine: version || null, firstInstall: true });
      await uvManager.start();
    }
  } catch (error) {
    if (isQuitting || (error && error.quitInProgress)) {
      // The user quit mid-startup: the aborted install, or the start refused by
      // UvManager.close(), is why we are here. Do not show the error panel (it
      // would re-show the window we just hid); the app is quitting.
      log.info(`[startup] stopped by the user quitting: ${error && error.message}`);
      return { ok: false };
    }
    log.error(`Failed to start Python backend: ${String(error?.message || error).split('\n')[0]}`);

    // FLOWPAD-2231: Windows application control refused the interpreter DURING the install (uv builds a
    // dependency from source, compiles bytecode): the same block, earlier than any backend. The panel that
    // names it and offers the signed runtime (Repair), not the generic error whose Retry fails the same way.
    // Only an error of the install steps counts: the evidence is uv's output (the text exists on Windows only;
    // Repair itself is gated there).
    const installBlock = error && error.fromInstall ? policyBlockFromInstallError(error) : null;
    if (installBlock) {
      log.error(`[fatal-failure] the engine install was blocked by Windows application control: ${installBlock.line}`);
      // A block on the FIRST install leaves a half-built environment that is not an engine to roll back to
      // (a block during --compile-bytecode happens after the venv is populated and readable).
      if (firstInstall && uvManager && typeof uvManager.markFirstInstallBlocked === 'function') uvManager.markFirstInstallBlocked();
      return { ok: false, installBlock, firstInstall };
    }

    const details = [
      error?.message || String(error),
      `HOME=${process.env.HOME || ''}`,
      `cwd=${os.homedir()}`,
      `flowBin=${uvManager?._flowBin || ''}`,
      `PATH=${(process.env.PATH || '').slice(0, 500)}`
    ];

    // The whole of stderr, once: uv's `error:` line is usually near the TOP, far from the last 500 chars.
    if (error?.stderr) details.push(`stderr=${error.stderr.toString().slice(-8000)}`);
    if (error?.stdout) details.push(`stdout=${error.stdout.toString().slice(-500)}`);

    const detailText = details.join('\n');
    log.error(`[startup error details]\n${detailText}`);

    // In-app panel with Retry (uv keeps what it already fetched in its
    // cache, so a retry after a slow or flaky download is usually seconds).
    // Only if the loading window is already gone is the failure fatal.
    if (quiet) return { ok: false, error };
    if (!(await showStartupErrorPanel(describeStartupFailure(error), { retryable: true, policyBlocked: !!(error && error.policyBlocked) }))) {
      app.quit();
    }
    return { ok: false };
  }
  return { ok: true, backendJustUpgraded };
}

// The wait ended because the app is quitting. `isQuitting` also covers a restart-to-update that stopped the backend
// under the wait (`launcher-failed`): that is not a startup failure, so it must not reach the error panel.
function backendWaitAborted(backendWait) {
  return backendWait.reason === 'quitting' || isQuitting;
}

async function startApp() {
  updateTest.event('boot', { desktop: app.getVersion(), packaged: app.isPackaged });
  // The startup journal first (startup-watchdog.js): from here on every phase is on disk, so a main
  // process that dies before showing anything is recognised by the next launch.
  journal = createStartupJournal({
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, t) => fs.writeFileSync(p, t, 'utf8'),
    filePath: path.join(app.getPath('userData'), 'startup-journal.json'),
    appVersion: app.getVersion(),
    pid: process.pid,
    log,
  });
  journal.mark('electron-initialized');
  // A recovery install (update-recovery.js) brought us here? Record it. The failure history is cleared
  // only once the backend is confirmed healthy below — never by the install itself.
  {
    const r = updateRecovery.afterRelaunch({ state: readRecoveryState(), appVersion: app.getVersion() });
    writeRecoveryState(r.state);
    if (r.installed) log.info(`[update-recovery] running ${app.getVersion()} after the recovery update from ${r.installed.fromVersion} (${r.installed.at})`);
  }

  // Kick off the desktop wrapper update check at launch — runs in parallel with backend startup
  // and is a no-op when the app isn't packaged. Scheduled (FLOWPAD-2308): when a recent check
  // answered 'current', the persisted answer is reused and the network is not touched.
  setupElectronAutoUpdater();
  // The check itself, started now, bounded, and independent of the backend: a backend that cannot start
  // must not hide the way out, and the failure panel must not wait on a slow or absent network for it
  // (the recovery paths force the real check if the schedule skipped it here).
  launchDesktopCheck = startLaunchDesktopCheck();

  createWindow();

  // Install the default (hidden/baseline) menu now that the app is ready and the
  // window exists — so the app never flashes Electron's stock menu before the
  // renderer reports its view mode over `set-menu-visible`.
  applyMenu();

  // Wait for the loading page to finish loading so IPC listeners are ready
  if (mainWindow.webContents.isLoading()) {
    await new Promise((resolve) => mainWindow.webContents.once('did-finish-load', resolve));
  }
  markPhase('renderer-loaded');
  {
    const notice = startupUpdateNotice();
    if (notice) sendStartupNotice(notice);
  }

  // macOS App Translocation: an app launched from Downloads / the .dmg runs from a read-only temporary copy
  // and cannot update itself. Ask once per version to move to /Applications — BEFORE any install work, so an
  // accepted move (which restarts the app) does not interrupt one. See app-location.js.
  if (process.platform === 'darwin' && !isDev) {
    await offerMoveToApplications({
      platform: process.platform,
      // The move quits the app to relaunch it from /Applications — the user already said yes to that.
      app: {
        getVersion: () => app.getVersion(),
        isPackaged: app.isPackaged,
        isInApplicationsFolder: () => app.isInApplicationsFolder(),
        moveToApplicationsFolder: (opts) => {
          quitGate.allow('moving to Applications');
          let moved = false;
          try {
            moved = app.moveToApplicationsFolder(opts);
            return moved;
          } finally {
            if (!moved) quitGate.revoke('the move to Applications did not happen');
          }
        },
      },
      dialog,
      execPath: process.execPath,
      readState: () => { try { return JSON.parse(fs.readFileSync(locationPromptStatePath(), 'utf8')); } catch { return null; } },
      writeState: (state) => fs.writeFileSync(locationPromptStatePath(), JSON.stringify(state), 'utf8'),
      share: (text) => shareDiagnostics(text, 'could not move itself to Applications'),
      scriptedAnswer: () => updateTest.answerFor('move', { execPath: process.execPath }),
      log,
    }).catch((err) => log.warn(`[location] move offer failed: ${err.message}`));
  }

  let backendJustUpgraded = false;

  // Recovery mode: the previous launches died before reaching a terminal phase, or --recovery was passed.
  // The panel (Update / Export logs / Share / Start) before any backend work.
  if (!isDev && (recoveryRequested(process.argv) || journal.recoveryMode())) {
    const why = recoveryRequested(process.argv)
      ? 'started with --recovery'
      : `the previous ${journal.consecutiveAbnormalRuns()} launches ended before FlowPad was up`;
    log.warn(`[startup] recovery mode: ${why}`);
    if (!(await showRecoveryEntry(why))) return;
  }

  if (isDev) {
    log.info('Development mode: expecting backend to be running externally');
  } else {
    // Install/upgrade + start, retryable from the in-app error panel. A failed
    // `uv tool install` is usually transient (slow link, flaky mirror) and uv
    // keeps everything it already fetched, so the retry typically finishes in
    // seconds — no relaunch, no terminal. One start at a time (startGuard).
    const guardedInstallAndStart = async () => {
      const r = await startGuard.run('startup', installAndStartBackend);
      return r.skipped ? { ok: false, skipped: true } : r.result;
    };
    let result = await guardedInstallAndStart();
    while (!result.ok) {
      if (isQuitting) return;
      if (result.installBlock) {
        // The install itself was blocked: the repair panel; Retry re-runs the install.
        const recovered = await handleFatalFailure({
          match: result.installBlock,
          record: null,
          autoRepair: !!result.firstInstall,
          retry: async () => {
            const g = await startGuard.run('startup', () => installAndStartBackend({ quiet: true }));
            return g.skipped ? { ok: false } : g.result;
          },
        });
        if (!recovered) return;
        backendReady = true;
        break;
      }
      if (result.fatalRecord) {
        // The panel on the monitor's record, without starting the backend (installAndStartBackend).
        const rec = fatalFailure.reconcileFatalReason({ record: result.fatalRecord, probeMatch: null });
        const recovered = await handleFatalFailure({ match: rec.match, record: result.fatalRecord });
        if (!recovered) return;
        backendReady = true;
        break;
      }
      await waitForRetryRequest();
      log.info('[startup] retry requested from the error panel');
      startupFailed = false;
      // Only when a previous attempt actually launched the backend: a first-install failure
      // never did, and `stop()` would run a bare `flow stop` and kill whatever holds the port.
      if (uvManager && uvManager.hasLaunchedBackend()) {
        await uvManager.stop().catch((e) => log.warn(`[startup] pre-retry stop failed: ${e.message}`));
      }
      result = await guardedInstallAndStart();
    }
    backendJustUpgraded = !!result.backendJustUpgraded;
  }

  // Wait for backend to be ready. After an install/upgrade the freshly
  // unpacked Python env takes substantially longer to import on first boot
  // (PyPI fetch + bytecode warm-up + AV scan on Windows), so widen the
  // window when we know we just ran uv install/upgrade.
  // (Skipped when the fatal-record path above already brought the backend up.)
  const backendWait = backendReady ? { ready: true, reason: 'healthy', elapsedSec: 0 } : await (async () => {
    sendStatus('Waiting for server');
    const waitOpts = backendJustUpgraded ? { maxChecks: POST_UPGRADE_HEALTH_CHECKS } : undefined;
    return waitForBackend(waitOpts);
  })();
  if (backendWaitAborted(backendWait)) return;
  backendReady = backendWait.ready;
  if (backendWait.ready) {
    updateTest.event('engine-ready', { desktop: app.getVersion(), engine: (uvManager && uvManager.getInstalledVersionSync()) || null });
  }

  if (!backendWait.ready && (backendWait.reason === 'policy-blocked' || backendWait.reason === 'fatal-failure')) {
    // The cause is known — the monitor's record (fatal-failure), or Windows application control in the
    // server log (policy-blocked) — so no generic timeout text: the panel names it and offers the way out.
    const rec = backendWait.reason === 'fatal-failure'
      ? fatalFailure.reconcileFatalReason({ record: backendWait.failureRecord, probeMatch: backendWait.policyBlock })
      : { match: backendWait.policyBlock, record: null, agree: true, source: 'electron' };
    if (rec.source === 'both' && !rec.agree) {
      log.warn(`[fatal-failure] the monitor (${rec.record.module}) and the log probe (${backendWait.policyBlock.module}) name different modules; showing the monitor's`);
    }
    const repaired = await handleFatalFailure({ match: rec.match, record: rec.record });
    if (!repaired) return;
    backendReady = true;
  } else if (!backendWait.ready) {
    // Try to gather diagnostics for the error dialog
    const timeoutSec = backendWait.elapsedSec;
    let detail = `Backend server failed to respond within ${timeoutSec} seconds (${backendWait.reason}).`;
    const launch = uvManager ? uvManager.lastLaunch() : null;
    if (backendWait.reason === 'launcher-failed' && launch) {
      detail += `\n\nflow start exited with code ${launch.exit.code}:\n${launch.tail()}`;
    }
    try {
      const newest = getNewestLogFile(path.join(BACKEND_LOGS, 'monitor'));
      if (newest) {
        const logContent = fs.readFileSync(newest.path, 'utf8');
        const lastLines = logContent.split('\n').slice(-15).join('\n');
        detail += `\n\nMonitor log (${newest.path}):\n${lastLines}`;
      } else {
        detail += '\n\nNo monitor log found.';
      }
    } catch {
      detail += '\n\nNo monitor log found.';
    }
    log.error(detail);
    // Stop the hung/failed backend so it can't hold the tool-venv files open —
    // otherwise the manual `uv tool install flowpad@latest --force` we tell the
    // user to run could fail with "file in use" (notably on Windows), and the
    // port would stay occupied for the next launch. This restores the cleanup
    // the old app.quit()-on-timeout used to trigger via the before-quit handler;
    // we just keep the window open (instead of quitting) so the user can read
    // and copy the recovery commands. Fire-and-forget: the panel shows now.
    if (uvManager) {
      pendingBackendStop = uvManager
        .stop()
        .catch((e) => log.warn(`[startup-timeout] backend stop failed: ${e.message}`));
    }
    // Surface the in-app recovery panel with copy-pasteable commands instead of
    // the native OS error box. The user quits from the panel's Quit button; the
    // next launch re-runs startApp() (including the upgrade path) from scratch.
    const why = {
      stalled: 'It was starting but stopped reporting progress, so it has most likely hung. ',
      'hard-cap': 'It kept reporting progress but never became healthy within 10 minutes. ',
      'launcher-failed': 'Its launcher (flow start) exited with an error. ',
    }[backendWait.reason] || '';
    const launcherOutput = backendWait.reason === 'launcher-failed' && launch
      ? `\n\nflow start exited with code ${launch.exit.code}:\n${summarizeOutput(launch.tail())}`
      : '';
    markPhase('startup-failed', { reason: backendWait.reason, elapsedSec: backendWait.elapsedSec });
    // The AGREED engine installed but never became healthy: restarting it next launch would fail the
    // same way (the exact abandonment screen). Put the previous release back (uv's cache first — no
    // network needed), mark the attempt failed (the next launch ASKS, never a silent retry of the
    // same unhealthy build), tell the panel, and offer a Retry that starts the restored engine.
    const unhealthyInstall = pendingEngineStore.read();
    if (engineRecordAtHealthGate(unhealthyInstall, { healthy: false }) === 'restore' && uvManager && !isQuitting) {
      log.warn(`[update] engine ${unhealthyInstall.engineVersion} installed but never became healthy — restoring ${unhealthyInstall.previousEngine}`);
      pendingEngineStore.write({ ...unhealthyInstall, phase: 'failed-unhealthy', failedVersion: unhealthyInstall.engineVersion });
      if (unhealthyInstall.source === 'panel') {
        resumedPanelUpdate = { kind: 'coordinated', success: false, restored: true, engineVersion: unhealthyInstall.engineVersion, desktopVersion: app.getVersion(), error: 'the installed engine never became healthy' };
      }
      try {
        await pendingBackendStop;
        sendStatus(`Restoring FlowPad engine ${unhealthyInstall.previousEngine}`);
        await uvManager.restoreEngine(unhealthyInstall.previousEngine);
        if (await showStartupErrorPanel(
          `Flowpad’s backend didn’t respond within ${timeoutSec} seconds after the engine update to ` +
            `${unhealthyInstall.engineVersion}. ${why}The previous engine (${unhealthyInstall.previousEngine}) ` +
            'has been restored — Retry starts it.' + launcherOutput,
          { retryable: true },
        )) {
          await waitForRetryRequest();
          if (!isQuitting) {
            startupFailed = false;
            return startApp();
          }
        }
        return;
      } catch (restoreErr) {
        if (resumedPanelUpdate && resumedPanelUpdate.restored) resumedPanelUpdate.restored = false;
        log.warn(`[update] could not restore ${unhealthyInstall.previousEngine}: ${restoreErr.message} — showing the normal panel`);
      }
    }
    // Retry, not Quit only: a backend that timed out on a busy machine often starts on a second try, and
    // the next launch would only reach this same screen.
    if (await showStartupErrorPanel(
      `Flowpad’s backend didn’t respond within ${timeoutSec} seconds. ${why}` +
        'This usually means the installed Flowpad package is out of date or broken.' +
        launcherOutput,
      { retryable: true },
    )) {
      await waitForRetryRequest();
      if (!isQuitting) {
        startupFailed = false;
        return startApp();
      }
    }
    return;
  }

  // Backend is up — record this desktop version as the baseline so the next
  // launch can detect a wrapper upgrade and re-sync the flowpad package.
  if (app.isPackaged) {
    writeDesktopVersion(app.getVersion());
  }
  // A confirmed healthy startup: the journal's terminal phase, the recovery-update history spent, and any
  // fatal record (the monitor clears its own; this covers a record the monitor did not get to) gone.
  markPhase('backend-healthy');
  {
    // The agreed-engine record is spent only HERE: installed AND answering. Until then a re-run of the
    // startup keeps it (planAfterDesktopUpdate), so the unhealthy gate can still restore previousEngine.
    if (engineRecordAtHealthGate(pendingEngineStore.read(), { healthy: true }) === 'spend') pendingEngineStore.clear();
    // A swap that skipped bytecode (prepared install): finish it now, with the engine already serving.
    if (uvManager && typeof uvManager.compileBytecodeInBackground === 'function') void uvManager.compileBytecodeInBackground();
  }
  writeRecoveryState(updateRecovery.markStartupHealthy());
  clearFailureRecord('the backend is healthy');

  // Load the main UI (or a pending deep-link target if one arrived during startup).
  const startUrl = pendingDeepLink || BACKEND_URL;
  pendingDeepLink = null;
  log.info(`Loading UI from ${redactUrl(startUrl)}`);
  // The splash (`loading.html`) is a real document load, so without this it
  // stays in the navigation history as entry 0 — and Back from the app's home
  // screen lands the user on the loading screen. Drop it once the UI commits,
  // so the app's first screen is the first history entry.
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      mainWindow.webContents.navigationHistory.clear();
      log.info(`[nav] cleared startup history (splash dropped) ${navStateFor(mainWindow)}`);
    } catch (err) {
      log.info(`[nav] could not clear startup history: ${err.message}`);
    }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    appUiLoaded = true;
    // A newer desktop found at launch: downloaded (with its engine) now that the app is up — nothing is asked yet.
    if (desktopUpdateAfterLaunch) { void beginBackgroundUpdate(desktopUpdateAfterLaunch); desktopUpdateAfterLaunch = null; }
    rendererWatchdog.arm(); // the app UI is up: from now on, silence means hung
    if (resumedPanelUpdate) {
      // A panel-initiated coordinated update finished across the restart: tell the panel. The value is
      // kept for 'update:take-resumed' too (one-shot there): a renderer that mounted after this push pulls it.
      try { mainWindow.webContents.send('engine-update-resumed', resumedPanelUpdate); } catch { /* window going away */ }
    }
  });
  mainWindow.loadURL(startUrl);

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Background update check (non-blocking, after UI is loaded). Skipped in dev
  // for the same reason the startup block is: it would stop the developer's
  // live backend and reinstall the PyPI package underneath a running app.
  if (isDev) {
    log.info('Development mode: skipping background update check');
    return;
  }
  // A newer engine (when no desktop update is pending): staged in the background now that the app is up,
  // then asked about once — the launch itself never waits on it.
  checkPackageUpdateInBackground({ label: 'post-boot' });
}
// Anything that escapes to the top level must reach the user with "Send Report" — an unhandled rejection in
// startApp used to leave the loading splash up forever, and an uncaught exception only got Electron's stock box.
let crashReported = false;
async function reportStartupCrash(err, where) {
  const text = redact(String((err && (err.stack || err.message)) || err)).slice(0, 4000);
  log.error(`[crash] ${where}: ${text}`);
  if (crashReported) return;
  crashReported = true;
  try {
    // A window to render into → the in-app panel (Share, Copy, Open logs, Quit); otherwise the native dialog.
    await showStartupErrorPanel(`Flowpad hit an unexpected error (${where}).\n\n${text}`, { retryable: false });
  } catch (e) {
    log.error(`[crash] could not show the error: ${e && e.message}`);
  }
}
process.on('uncaughtException', (err) => { reportStartupCrash(err, 'uncaught exception'); });
process.on('unhandledRejection', (reason) => {
  // Logged only: most are benign (a cancelled request), and a dialog per rejection would be noise.
  log.error(`[unhandled rejection] ${redact(String((reason && (reason.stack || reason.message)) || reason)).slice(0, 2000)}`);
});

// App lifecycle events
app.whenReady().then(() => {
  // macOS / Linux shutting down or logging out: nobody is there to answer.
  powerMonitor.on('shutdown', () => quitGate.allow('the system is shutting down'));
  return startApp();
}).catch((err) => reportStartupCrash(err, 'startApp'));

app.on('window-all-closed', () => {
  log.info('All windows closed');
  app.quit();
});

app.on('activate', () => {
  // macOS: clicking the dock icon while stuck on the startup-timeout panel means
  // the user ran the recovery command and wants to retry — relaunch from scratch
  // (the dead window is still open, so the 0-windows path below won't fire).
  if (startupFailed) {
    log.info('[activate] reopen while in startup-failed state — relaunching');
    relaunchAfterStop({
      pendingStop: pendingBackendStop,
      log,
      relaunch: () => app.relaunch(),
      exit: code => app.exit(code),
    });
    return;
  }
  // On macOS, recreate window when dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    if (uvManager && uvManager.isInstalling()) {
      createWindow(); // the running startup owns the install; only the window is missing
    } else {
      startApp();
    }
  }
});

// Every quit — the window's X (it routes here, see createWindow), Cmd+Q,
// Alt+F4, the dock — asks first (quit-gate.js). Only on "Quit" does the
// shutdown run. Quitting while `uv tool install` is replacing the venv aborts
// it and the next launch repairs it (UvManager.hadInterruptedInstall).
// Nothing to ask when there is no window to ask over (the single-instance
// exit) or when the startup already failed (the backend is stopped; the panel
// has its own Quit button).
app.on('before-quit', (event) => {
  // The quit electron-updater scheduled for an install that then failed (a late NSIS spawn error):
  // the app is staying — without this the user got the failure dialog AND "Quit FlowPad?".
  if (restartApplier.consumeScheduledQuit()) { event.preventDefault(); return; }
  restartApplier.quitStarted(); // an apply in flight: its quitAndInstall really is quitting the app
  if (isQuitting) return;
  const askFirst = !quitGate.isConfirmed() && !startupFailed && mainWindow && !mainWindow.isDestroyed();
  if (askFirst) {
    event.preventDefault();
    quitGate.request(quitPhase()).then((yes) => {
      if (yes) app.quit();
    });
    return;
  }
  isQuitting = true;
  rendererWatchdog.stop();
  markPhase('clean-exit');
  // A background engine prepare's uv must not outlive the app (nothing live depends on it).
  if (uvManager && typeof uvManager.cancelPrepare === 'function') uvManager.cancelPrepare('the app is quitting');

  log.info('Quitting — stopping backend...');

  // Hide window immediately so the user sees instant close
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  if (uvManager) {
    event.preventDefault();

    // First refuse anything new: the startup chain is still running and would
    // otherwise launch `flow start` after the stop below — a detached backend
    // outliving the app. Also aborts a running install.
    uvManager.close();

    // Graceful shutdown: flow stop, then kill any remaining processes on port.
    // We exit only once that has finished — see shutdown.js for why exiting
    // on a timer stranded the next launch with "service_busy".
    shutdown = createShutdown({
      uvManager,
      log,
      exit: (code) => { if (!installWaitingUpdateOnExit()) app.exit(code); },
      relaunch: () => app.relaunch(),
    });
    shutdown.run();
  }
});

// IPC handlers for renderer communication
// Copy a command to the clipboard for the startup-timeout recovery panel.
ipcMain.handle('copy-to-clipboard', (_event, text) => {
  if (typeof text === 'string' && text.length > 0) {
    clipboard.writeText(text);
    return true;
  }
  return false;
});

ipcMain.handle('capture-region', async (event, rawRegion) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) {
    throw new Error('No active window to capture');
  }

  const region = rawRegion && typeof rawRegion === 'object' ? rawRegion : {};
  const toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const bounds = win.getContentBounds();
  const maxX = Math.max(0, bounds.width - 1);
  const maxY = Math.max(0, bounds.height - 1);
  const rect = {
    x: Math.min(maxX, Math.max(0, Math.floor(toNumber(region.x)))),
    y: Math.min(maxY, Math.max(0, Math.floor(toNumber(region.y)))),
    width: Math.max(1, Math.ceil(toNumber(region.width, bounds.width))),
    height: Math.max(1, Math.ceil(toNumber(region.height, bounds.height))),
  };
  rect.width = Math.min(rect.width, Math.max(1, bounds.width - rect.x));
  rect.height = Math.min(rect.height, Math.max(1, bounds.height - rect.y));

  const image = await win.webContents.capturePage(rect);
  return image.toDataURL();
});

// Quit from the startup-timeout recovery panel's "Quit" button.
ipcMain.handle('open-logs-folder', async () => {
  const err = await require('electron').shell.openPath(MAIN_DESKTOP_LOG_DIR);
  if (err) log.warn(`[logs] could not open ${MAIN_DESKTOP_LOG_DIR}: ${err}`);
  return !err;
});

// "Send Report" on the startup error panel. Builds a zip of the newest desktop log and the
// newest backend-server log (tails, obvious secrets masked) and uploads it to the hub's
// anonymous support-bundle intake (support-upload.js), which stores it in GCS and notifies
// the team — nothing for the user to attach or mail (FLOWPAD-2251). `email` is the user's
// optional reply address; empty means anonymous.

/**
 * Build the support bundle and upload it. On success the submissionId is the reference the
 * user can quote to support; on failure zipPath still points at the built zip, so the
 * caller can offer "Export logs" as the offline fallback.
 * `headline` says which failure this is ("window crashed", "did not start") in the bundle's info.txt.
 * Used by the error panel (IPC) and by every native failure dialog (failure-dialog.js).
 */
async function shareDiagnostics(detail, headline = 'did not start', email = '') {
  try {
    const shownError = redact(String(detail || '')).slice(0, 4000);
    const info = { ...supportInfo(), context: headline };
    const bundle = buildSupportZip({
      sources: supportSources(),
      info,
      detail: shownError + supportFailureRecordText(),
    });
    log.info(`[share-logs] built ${bundle.zipPath} (${bundle.bytes} bytes; included: ${bundle.included.join(', ') || 'none'})`);
    const upload = await uploadSupportBundle({ cloudUrl: FLOWPAD_CLOUD_URL, zipPath: bundle.zipPath, email, info });
    if (!upload.ok) {
      log.warn(`[share-logs] upload failed: ${upload.error}`);
      return { ok: false, error: upload.error, zipPath: bundle.zipPath };
    }
    log.info(`[share-logs] uploaded ${bundle.zipPath} as ${upload.submissionId}`);
    return { ok: true, submissionId: upload.submissionId, zipPath: bundle.zipPath, bytes: bundle.bytes, included: bundle.included, missing: bundle.missing };
  } catch (err) {
    log.warn(`[share-logs] failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('share-logs', (_event, detail, email) => shareDiagnostics(detail, 'did not start', email));

ipcMain.on('quit-app', () => {
  app.quit();
});

ipcMain.handle('get-backend-url', () => BACKEND_URL);

ipcMain.handle('get-app-version', () => app.getVersion());

// ── OS-level desktop notifications ───────────────────────────────────────────
// Native surfaces for the `desktop_notify` ui_command (see the renderer's
// handleDesktopNotify). Three channels: banner, dock/launcher badge, and an
// attention signal (dock bounce on macOS, taskbar flash on Linux/Windows).
let lastNote = null; // close the previous banner before the next so macOS doesn't coalesce
let notifySeq = 0; // unique-body suffix — a repeated identical body is silently dropped

// Show an OS banner. On click: focus the window (restoring if minimized) and
// round-trip the opaque clickTarget to the renderer, which owns navigation.
ipcMain.handle('notify-os', (_event, payload) => {
  const { title, body, clickTarget } = payload && typeof payload === 'object' ? payload : {};
  if (!Notification.isSupported()) return false;
  try {
    if (lastNote) {
      try { lastNote.close(); } catch { /* already gone */ }
    }
    notifySeq += 1;
    lastNote = new Notification({
      title: typeof title === 'string' && title ? title : 'Flowpad',
      // Zero-width space suffix keeps each body unique (invisible) so macOS
      // renders every banner instead of collapsing repeats.
      body: `${typeof body === 'string' ? body : ''}${'​'.repeat(notifySeq % 8)}`,
      silent: false,
    });
    lastNote.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('notification-click', { clickTarget });
      }
    });
    lastNote.show();
    return true;
  } catch (err) {
    log.warn(`[notify] notify-os failed: ${err.message}`);
    return false;
  }
});

// Set the dock (macOS) / launcher (Linux Unity) badge count. 0 clears it.
ipcMain.handle('set-badge', (_event, n) => {
  try {
    app.setBadgeCount(Math.max(0, Number(n) | 0));
    return true;
  } catch (err) {
    log.warn(`[notify] set-badge failed: ${err.message}`);
    return false;
  }
});

// Attention signal: dock bounce (macOS) or taskbar flash (Linux/Windows). Only
// fires when the window is NOT focused — no point yelling at a user already
// looking at the app.
ipcMain.handle('notify-attention', () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return false;
    if (process.platform === 'darwin') {
      app.dock?.bounce('critical');
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(true);
    }
    return true;
  } catch (err) {
    log.warn(`[notify] notify-attention failed: ${err.message}`);
    return false;
  }
});

ipcMain.handle('get-startup-logs', () => {
  const logs = [];

  // Electron log (newest in main_desktop/)
  try {
    const newest = getNewestLogFile(path.join(LOGS_BASE, 'main_desktop'));
    if (newest) {
      const content = fs.readFileSync(newest.path, 'utf8');
      logs.push({ name: 'Electron', path: newest.path, content });
    }
  } catch { /* ignore */ }

  // Monitor log (newest in monitor/)
  try {
    const newest = getNewestLogFile(path.join(BACKEND_LOGS, 'monitor'));
    if (newest) {
      const content = fs.readFileSync(newest.path, 'utf8');
      logs.push({ name: 'Monitor', path: newest.path, content });
    }
  } catch { /* ignore */ }

  // Server log (newest in server/)
  try {
    const newest = getNewestLogFile(path.join(BACKEND_LOGS, 'server'));
    if (newest) {
      const content = fs.readFileSync(newest.path, 'utf8');
      logs.push({ name: 'Server', path: newest.path, content });
    }
  } catch { /* ignore */ }

  return logs;
});

// ---------------------------------------------------------------------------
// Live log tailing — pushes new log lines to the renderer every second
// ---------------------------------------------------------------------------
let _logWatchInterval = null;
const _logFileOffsets = {};  // { filePath: bytesReadSoFar }

function _getLogFiles() {
  const files = [];

  // Re-discover newest file in each subdirectory on every tick
  const subdirs = [
    { name: 'Electron', dir: path.join(LOGS_BASE, 'main_desktop') },
    { name: 'Monitor', dir: path.join(BACKEND_LOGS, 'monitor') },
    { name: 'Server', dir: path.join(BACKEND_LOGS, 'server') },
  ];

  for (const { name, dir } of subdirs) {
    const newest = getNewestLogFile(dir);
    if (newest) {
      files.push({ name, path: newest.path });
    }
  }

  return files;
}

function _readNewContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const prev = _logFileOffsets[filePath] || 0;

    // File was truncated / rotated — reset
    if (stat.size < prev) {
      _logFileOffsets[filePath] = 0;
    }

    const offset = _logFileOffsets[filePath] || 0;
    if (stat.size <= offset) return '';

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    _logFileOffsets[filePath] = stat.size;
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

ipcMain.on('watch-startup-logs', (event) => {
  // Initialise offsets to current file sizes so we only stream NEW content
  const initialFiles = _getLogFiles();
  for (const f of initialFiles) {
    try {
      _logFileOffsets[f.path] = fs.statSync(f.path).size;
    } catch {
      _logFileOffsets[f.path] = 0;
    }
  }

  if (_logWatchInterval) clearInterval(_logWatchInterval);

  _logWatchInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(_logWatchInterval);
      _logWatchInterval = null;
      return;
    }
    // Re-discover log files each tick — server.log / monitor.log may appear later
    const logFiles = _getLogFiles();
    const updates = [];
    for (const f of logFiles) {
      // First time seeing this file — start tailing from current position
      if (_logFileOffsets[f.path] === undefined) {
        try {
          _logFileOffsets[f.path] = fs.statSync(f.path).size;
        } catch {
          _logFileOffsets[f.path] = 0;
        }
      }
      const newContent = _readNewContent(f.path);
      if (newContent) {
        updates.push({ name: f.name, content: newContent });
      }
    }
    if (updates.length) {
      mainWindow.webContents.send('startup-logs-update', updates);
    }
  }, 1000);
});

ipcMain.on('unwatch-startup-logs', () => {
  if (_logWatchInterval) {
    clearInterval(_logWatchInterval);
    _logWatchInterval = null;
  }
});

ipcMain.handle('restart-backend', async (event) => {
  assertTrustedSender(event, 'restart-backend');
  if (!uvManager) return false;
  // One backend start at a time: a restart asked for while startup (or another restart) is still
  // starting the backend is refused, never run under it.
  const r = await startGuard.run('restart-backend', async () => {
    await uvManager.restart();
    return (await waitForBackend()).ready;
  });
  return r.skipped ? false : r.result;
});

// The failure panel's "Update FlowPad": handled by waitForPanelAction's listener while the panel is up;
// a stray message outside that window is ignored (no listener → nothing happens).
ipcMain.on('update-desktop-recovery', () => {});

/**
 * "Export logs" on the failure panel: the same zip "Send Report" builds (support-bundle.js) saved where
 * the user chooses — the manual way to get the logs to the team when the upload cannot reach the
 * service (offline, blocked egress, or the intake itself failing).
 */
async function exportDiagnostics(detail) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(parent, {
      title: 'Export FlowPad logs',
      defaultPath: path.join(app.getPath('desktop'), `flowpad-support-${stamp}.zip`),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const bundle = buildSupportZip({
      sources: supportSources(),
      info: supportInfo(),
      detail: redact(String(detail || '')).slice(0, 4000) + supportFailureRecordText(),
      outDir: path.dirname(filePath),
    });
    if (bundle.zipPath !== filePath) fs.renameSync(bundle.zipPath, filePath);
    log.info(`[export-logs] saved ${filePath} (${bundle.bytes} bytes; included: ${bundle.included.join(', ') || 'none'})`);
    return { ok: true, zipPath: filePath, included: bundle.included, missing: bundle.missing };
  } catch (err) {
    log.warn(`[export-logs] failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
ipcMain.handle('export-logs', (_event, detail) => exportDiagnostics(detail));

/** The log directories a support bundle takes the newest file of. */
function supportSources() {
  return [
    { label: 'desktop', dir: path.join(LOGS_BASE, 'main_desktop') },
    { label: 'server', dir: path.join(BACKEND_LOGS, 'server') },
    { label: 'monitor', dir: path.join(BACKEND_LOGS, 'monitor') },
  ];
}
function supportInfo() {
  return {
    app: app.getVersion(),
    engine: (uvManager && uvManager.getInstalledVersionSync()) || 'unknown',
    runtime: (uvManager && uvManager.repairedRuntimePython && uvManager.repairedRuntimePython()) || 'uv-managed',
    instance: FLOW_INSTANCE,
    platform: `${process.platform} ${process.arch} ${os.release()}`,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    startupPhase: journal ? journal.phase() : null,
  };
}
/** The monitor's fatal-failure record, verbatim, when there is one. */
function supportFailureRecordText() {
  try { return `\n\nserver-failure.json:\n${fs.readFileSync(fatalFailure.failureRecordPath(INSTANCE_DIR), 'utf8')}`; } catch { return ''; }
}

ipcMain.handle('upgrade-flowpad', async (event, opts) => {
  assertTrustedSender(event, 'upgrade-flowpad');
  if (!uvManager) return { success: false, error: 'No uv manager' };
  const requested = (opts && opts.version) || null;
  // A pin is validated HERE, before the server is stopped or the window swapped: the panel's only pin
  // is the popup's "newest that works with this desktop", which is always an UPGRADE — this channel
  // never downgrades (that is the backend's version picker, with its own checks).
  if (requested) {
    if (!engineCompat.isInstallableVersion(requested)) return { success: false, error: `"${requested}" is not an installable version` };
    const installed = uvManager.getInstalledVersionSync() || null;
    if (installed && !isNewer(installed, requested)) {
      return { success: false, error: `${requested} is not newer than the installed ${installed}` };
    }
  }
  // Desktop first: refuse before touching the running server or the window.
  if (engineChangeAllowed('upgrade-flowpad IPC') !== 'allow') {
    // One exception, and only on POSITIVE knowledge (engineFloorAllows): a pinned release whose
    // floor the RUNNING desktop explicitly meets is safe to install while a desktop update is
    // pending — it is exactly the popup's "works with this desktop" fallback, which this hold used
    // to contradict. An unparseable or unreadable floor stays held: better refused here than a
    // stopped server and a splash before _assertCandidateCompatible says the same thing.
    const verdict = requested && engineCompat.isInstallableVersion(requested)
      ? await engineFloorAllows(requested, app.getVersion()) : { allowed: false };
    if (!verdict.allowed) {
      return { success: false, desktopUpdatePending: true, error: 'A newer FlowPad desktop must be installed first; the engine is updated after it.' };
    }
    log.info(`[update] engine change allowed despite the pending desktop: ${requested} runs on the current desktop`);
  }
  // Prepared in the background first — the backend keeps serving and nothing is held: startGuard (which
  // refuses restart-backend and the startup Retry) covers only the swap. `direct`: the panel's
  // "Upgrade directly" after a prepare that keeps failing — the old stop-and-install path.
  let prepared = null;
  if (!(opts && opts.direct) && typeof uvManager.prepareEngine === 'function') {
    try {
      const staged = await uvManager.prepareEngine({ version: requested });
      if (staged && staged.upToDate) return { success: true };
      prepared = staged;
    } catch (prepErr) {
      if (prepErr && prepErr.cancelled) return { success: false, error: 'cancelled' };
      log.warn(`[uv] could not prepare ${requested || 'the update'} in the background (${String(prepErr.message).split('\n')[0]}) — upgrading directly`);
    }
  }
  const guarded = await startGuard.run('upgrade-flowpad', () => upgradeFlowpadAndRestart({ version: requested, prepared }));
  return guarded.skipped ? { success: false, error: 'the backend is already being started' } : guarded.result;
});

// ── One update flow: staged in the background, asked once (FLOWPAD-2310) ──────
// The automatic checks (launch, the periodic pass) and the version panel's buttons start the SAME flow:
// the desktop downloads and the engine that will run with it is staged while the running versions keep
// serving; a newer release replaces whatever is pending; the user is asked once — update now or later —
// when everything is ready. "Later" keeps it ready: the panel installs it any time, and the next start (or
// quit) runs it either way.

/**
 * POSITIVE-knowledge floor gate: `allowed` only when the candidate engine release declares no floor,
 * or `desktopVersion` EXPLICITLY meets it. Unknown, unreadable or invalid metadata refuses — a
 * refusal here is words on a panel; optimism here is a stopped server or a restart that ends in a
 * rollback. (The install-time gates stay authoritative either way.)
 */
async function engineFloorAllows(engineVersion, desktopVersion) {
  if (!uvManager || typeof uvManager._readCandidateMinDesktop !== 'function') return { allowed: false, known: false, floor: null };
  const candidate = await uvManager._readCandidateMinDesktop(engineVersion);
  if (!candidate) return { allowed: false, known: false, floor: null };          // unreadable (offline): not a verdict
  if (candidate === 'invalid') return { allowed: false, known: true, floor: null }; // declared and broken: a verdict
  const floor = candidate.minDesktopVersion;
  const allowed = floor == null || engineCompat.meetsFloor(desktopVersion, floor) === true;
  return { allowed, known: allowed || engineCompat.meetsFloor(desktopVersion, floor) === false, floor: floor == null ? null : floor };
}

// ── Prepare in the background, swap in seconds (engine updates) ─────────────
// Every engine update downloads, stages and is checked WHILE the running engine keeps serving
// (uv-manager.prepareEngine); the user is then asked once whether to restart now (a swap of a few
// seconds: stop, an offline install, start) or later — and "later" still means the next launch runs the
// new version: the prepared release is saved as an agreed, prepared pending-engine record, which the
// next start installs offline before the engine boots.
let enginePrep = null; // { version, desktopVersion, source, background, state: 'preparing'|'ready'|'error', prepared, error, announced }

/** Engine prepare progress for the panel ('engine-update-state'). `background`: nobody asked — no toasts. */
function sendEngineUpdateState(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const background = !!(enginePrep && enginePrep.background);
  try { mainWindow.webContents.send('engine-update-state', { ...payload, background }); } catch { /* window going away */ }
}

/** The in-app "ready — update now or later?" dialog ('update-ready'). */
function sendUpdateReady(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('update-ready', payload); } catch { /* window going away */ }
}

function enginePrepSnapshot() {
  return enginePrep ? { state: enginePrep.state, version: enginePrep.version, coordinated: !!enginePrep.desktopVersion, error: enginePrep.error || null } : { state: 'idle' };
}

/**
 * Stage an engine release in the background. `desktopVersion`: a coordinated update — the engine is
 * checked against the desktop it will run on, and installed by THAT desktop after the restart.
 * `background`: started by an automatic check, not by a click. An engine-only release that is already
 * READY stays the candidate until the newer one is staged: if that fails or is cancelled, the ready one
 * is what the user can still apply (and is not asked about again).
 */
function startEnginePrepare({ version = null, desktopVersion = null, source, background = false }) {
  if (!uvManager || typeof uvManager.prepareEngine !== 'function') return null;
  if (enginePrep && enginePrep.state === 'preparing' && enginePrep.version === version && enginePrep.desktopVersion === desktopVersion) {
    if (!background) enginePrep.background = false; // a click adopts the automatic prepare
    return enginePrep;
  }
  const fallback = !desktopVersion && enginePrep && enginePrep.state === 'ready' && !enginePrep.desktopVersion ? enginePrep : null;
  const prep = { version, desktopVersion, source, background, state: 'preparing', prepared: null, error: null, announced: false };
  enginePrep = prep;
  sendEngineUpdateState({ state: 'preparing', version, coordinated: !!desktopVersion });
  const keepFallback = () => {
    if (!fallback) return false;
    enginePrep = fallback;
    sendEngineUpdateState({ state: 'ready', version: fallback.version, coordinated: false });
    return true;
  };
  uvManager.prepareEngine({ version, desktopVersion })
    .then((prepared) => {
      if (enginePrep !== prep) return; // superseded by a newer prepare
      if (prepared.upToDate) {
        enginePrep = null;
        sendEngineUpdateState({ state: 'idle' });
        return;
      }
      prep.state = 'ready';
      prep.prepared = prepared;
      prep.version = prepared.version;
      recordPreparedEngine(prep); // replaces the record of the release it supersedes
      sendEngineUpdateState({ state: 'ready', version: prepared.version, coordinated: !!desktopVersion });
      maybeAnnounceUpdateReady();
    })
    .catch((err) => {
      if (enginePrep !== prep) return;
      if (err && err.cancelled) {
        log.info(`[update] preparing the engine ${version || ''} was cancelled`);
        if (keepFallback()) return;
        enginePrep = null;
        sendEngineUpdateState({ state: 'idle' });
        return;
      }
      const error = String((err && err.message) || err).split('\n')[0];
      log.warn(`[update] preparing the engine ${version || ''} failed: ${error} — the running engine is untouched`);
      if (keepFallback()) return;
      prep.state = 'error';
      prep.error = error;
      sendEngineUpdateState({ state: 'error', version, coordinated: !!desktopVersion, error });
      maybeAnnounceUpdateReady(); // a coordinated update still goes ahead: the new desktop downloads the engine itself
    });
  return prep;
}

/**
 * The staged release becomes the agreed next engine — so ANY later start runs it, even when the user
 * never answers the dialog. A coordinated record already exists (startCoordinatedUpdate saved and consented
 * it): it just gains the prepared download. An engine-only one is saved for THIS desktop, replacing the
 * record of any older engine-only release it supersedes.
 */
function recordPreparedEngine(prep) {
  const saved = pendingEngineStore.read();
  if (prep.desktopVersion) {
    if (saved && saved.engineVersion === prep.prepared.version) pendingEngineStore.write({ ...saved, prepared: prep.prepared });
    return;
  }
  // Never over a coordinated agreement still waiting for its desktop, or a veto on this very version.
  if (saved && saved.consented && saved.desktopVersion && isNewer(app.getVersion(), saved.desktopVersion)) return;
  if (saved && saved.phase === 'failed-unhealthy' && saved.failedVersion === prep.prepared.version) return;
  savePendingEngine(pendingEngineStore, { engineVersion: prep.prepared.version, desktopVersion: app.getVersion(), source: 'engine' });
  markPendingEngineConsented(pendingEngineStore);
  const rec = pendingEngineStore.read();
  if (rec) pendingEngineStore.write({ ...rec, prepared: prep.prepared });
}

// The desktop update the flow is staging and will ask about: { desktopVersion, engineVersion, announced,
// background } (engineVersion null → the desktop goes alone). One at a time — a newer release replaces it.
// `background`: started by an automatic check; a panel click on the same release adopts it.
let panelUpdatePlan = null;

// The loaded UI announced it shows the in-app "ready — update now or later?" dialog ('update:panel-ready').
// The UI ships with the ENGINE, so an older engine's UI does not: then the question falls back to a
// native dialog (after launch — never blocking it).
let panelShowsReadyDialog = false;
// The app's own UI has loaded (not the splash): a native fallback question has a window to sit on.
let appUiLoaded = false;
// The newer desktop the launch check found: its background update starts once the app's UI is up.
let desktopUpdateAfterLaunch = null;

/** The one question that is due now — everything it covers is staged — or null. */
function dueReadyQuestion() {
  const plan = panelUpdatePlan;
  if (plan && plan.desktopVersion && !plan.announced) {
    if (desktopDownloadedVersion !== plan.desktopVersion) return null;
    // No prepare running for it (it could not start, or failed) counts as settled: the new desktop then
    // downloads the engine itself.
    const prep = enginePrep && enginePrep.desktopVersion === plan.desktopVersion ? enginePrep : null;
    if (plan.engineVersion && prep && prep.state === 'preparing') return null;
    const engineReady = !!(plan.engineVersion && prep && prep.state === 'ready');
    return {
      info: {
        kind: plan.engineVersion ? 'both' : 'desktop',
        desktopVersion: plan.desktopVersion,
        engineVersion: plan.engineVersion ? (engineReady ? prep.version : plan.engineVersion) : null,
        enginePrepared: engineReady,
      },
      markAsked: () => { plan.announced = true; },
    };
  }
  if (enginePrep && enginePrep.state === 'ready' && !enginePrep.desktopVersion && !enginePrep.announced) {
    const prep = enginePrep;
    return {
      info: { kind: 'engine', desktopVersion: null, engineVersion: prep.version, enginePrepared: true },
      markAsked: () => { prep.announced = true; },
    };
  }
  return null;
}

/**
 * Everything is staged: ask ONCE — update now or later? In the app when its UI shows the dialog. An older
 * engine's UI cannot: then `nativeFallback` (the scheduler's tick) asks with a native dialog — never from
 * the moment the UI loads, when the new UI has not had the chance to say it can.
 */
function maybeAnnounceUpdateReady({ nativeFallback = false } = {}) {
  if (isQuitting || restartApplier.busy) return;
  const due = dueReadyQuestion();
  if (!due) return;
  if (panelShowsReadyDialog) {
    due.markAsked();
    log.info(`[update] ready: asking (in the app) — ${JSON.stringify(due.info)}`);
    sendUpdateReady(due.info);
    return;
  }
  if (!nativeFallback || !appUiLoaded || !mainWindow || mainWindow.isDestroyed()) return;
  due.markAsked();
  log.info(`[update] ready: asking (native — this UI has no in-app dialog) — ${JSON.stringify(due.info)}`);
  void askUpdateReadyNatively(due.info).catch((err) => log.warn(`[update] ready prompt failed: ${err.message}`));
}

function announceNativelyIfNoPanel() {
  maybeAnnounceUpdateReady({ nativeFallback: true });
}

/** The ready question when the loaded UI cannot show the in-app dialog. Later: it stays ready (panel, next start). */
async function askUpdateReadyNatively(info) {
  const engineOnly = info.kind === 'engine';
  const versions = [info.desktopVersion && `FlowPad ${info.desktopVersion}`, info.engineVersion && `flow SDK ${info.engineVersion}`].filter(Boolean).join(', ');
  const scripted = updateTest.answerFor('ready', { kind: info.kind, desktop: info.desktopVersion, engine: info.engineVersion });
  const { response } = scripted !== null ? { response: scripted } : await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update available',
    message: 'A new version of FlowPad is available.',
    detail: versions,
    buttons: ['Update now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    log.info('[update] ready: the user chose Later — the update stays ready');
    return;
  }
  const r = engineOnly ? await applyPreparedEngine() : await applyDownloadedDesktop();
  if (!r.started) log.warn(`[update] "Update now" did not apply: ${r.reason}${r.error ? ` (${String(r.error).split('\n')[0]})` : ''}`);
}

/** The planned desktop download again (after a cancel or a failure) — the plan and its engine stay as they are. */
function restartPlannedDownload(version) {
  sendDesktopUpdateState({ state: 'downloading', percent: 0, version });
  downloadDesktopUpdateInBackground({ version });
}

/** Why a panel update action must be refused right now, or null when it may proceed. */
function desktopUpdateRefusal() {
  if (!app.isPackaged || process.windowsStore) return 'unsupported';
  if (restartApplier.busy) return 'busy';
  if (uvManager && uvManager.isInstalling()) return 'busy';
  return null;
}

/**
 * Drop the saved engine OFFER (a desktop update that now goes alone) — but never a record the update
 * machinery still needs: a swap in progress (its rollback) or a veto on a version that failed its health check.
 */
function clearPendingEngineOffer() {
  const rec = pendingEngineStore.read();
  if (rec && (rec.phase === 'installing' || rec.phase === 'installed' || rec.phase === 'failed-unhealthy')) return;
  pendingEngineStore.clear();
}

/**
 * Start (or replace) THE desktop update: the desktop downloads and `engineVersion` (chosen for that
 * desktop; null → the desktop goes alone) is staged in parallel, while everything running keeps serving.
 * Saved and agreed up front: whatever the answer to the one question, the next start runs both — so a quit
 * before "Update now" still completes them (install-on-quit + the resume). A different release that was
 * pending is superseded: its download stops and electron-updater keeps only the newest file.
 */
function startCoordinatedUpdate({ desktopVersion, engineVersion, background = false }) {
  if (desktopDownloadPending() && pendingDownloadVersion() !== desktopVersion) cancelDesktopDownload('superseded by a newer release');
  if (desktopDownloadedVersion && desktopDownloadedVersion !== desktopVersion) desktopDownloadedVersion = null;
  if (engineVersion) {
    savePendingEngine(pendingEngineStore, { engineVersion, desktopVersion, source: 'panel' });
    markPendingEngineConsented(pendingEngineStore);
  } else {
    // The desktop goes alone: an OLD record must not install a stale engine behind this update's back.
    clearPendingEngineOffer();
  }
  pendingDesktopVersion = desktopVersion;
  panelUpdatePlan = { desktopVersion, engineVersion: engineVersion || null, announced: false, background };
  if (engineVersion) startEnginePrepare({ version: engineVersion, desktopVersion, source: 'panel', background });
  maybeAnnounceUpdateReady(); // already downloaded and nothing to stage → ask right away
  if (desktopDownloadedVersion === desktopVersion) return { ready: true };
  if (desktopDownloadPending()) return {}; // the download in flight IS this release
  sendDesktopUpdateState({ state: 'downloading', percent: 0, version: desktopVersion });
  downloadDesktopUpdateInBackground({ version: desktopVersion });
  return {};
}

/** The one desktop version a panel action applies to — downloaded first (possibly "Later"-deferred),
 *  then the one downloading, then the feed's offer. A downloaded or in-flight update IS available,
 *  whatever the last feed check said: that is what lets a postponed update install from the panel. */
function effectiveDesktopVersion() {
  return desktopDownloadedVersion || pendingDownloadVersion()
    || (desktopStatus.state === 'available' ? desktopStatus.version : null);
}

/** The desktop side of 'update:get-info'. Re-checks the feed only when nothing is in flight yet. */
async function desktopUpdateInfo() {
  if (desktopStatus.state !== 'unsupported'
      && Date.now() - desktopFeedCheckedAt > 60 * 1000
      && !desktopDownloadPending() && !desktopDownloadedVersion && !restartApplier.busy) {
    // Unpackaged / Store builds: getDesktopUpdateVersion answers 'unsupported' by itself, without a
    // network call — skipping it here left desktopStatus on 'unknown' ("not checked yet") for ever,
    // and the panel showed a hopeless "Could not check / Check again" row in dev and Store builds.
    await getDesktopUpdateVersion();
  }
  // restartRequired: the updater cannot apply in this process any more — the row offers "Restart FlowPad".
  const restartRequired = restartApplier.restartRequired;
  const downloadState = restartApplier.busy ? 'installing'
    : desktopDownloadedVersion ? 'ready'
      : desktopDownloadPending() ? 'downloading' // on macOS this includes Squirrel preparing it
        : 'idle';
  const available = effectiveDesktopVersion();
  const state = available ? 'available' : desktopStatus.state;
  return { installed: app.getVersion(), state, available, downloadState, restartRequired, installsOnQuit: INSTALLS_ON_QUIT };
}

ipcMain.handle('update:get-info', async (event, opts) => {
  assertTrustedSender(event, 'update:get-info');
  // Two independent sides, in parallel: serially every popover open paid the desktop feed check,
  // then the PyPI document, then the wheel range read, end to end. `fresh` (the Upgrade click) skips
  // the engine snapshot and PyPI's CDN — a release published a minute ago must shape the popup.
  const fresh = !!(opts && opts.fresh);
  const [desktop, engine] = await Promise.all([
    desktopUpdateInfo(),
    uvManager ? uvManager.engineUpdatePreflight({ fresh }) : null,
  ]);
  // A pair the contract forbids that is RUNNING anyway (repair offline/held/declined at launch):
  // the panel shows it — "start what is installed and warn" must reach the user, not just the log.
  const runningPair = uvManager && uvManager.getInstalledFlowBin() ? uvManager.installedPairIssue() : null;
  // Would the desktop on the feed satisfy the latest engine's floor? false → the popup must not
  // offer Update Both yet ("wait for the next desktop release" is the honest advice).
  desktop.meetsEngineFloor = engine && engine.latestMinDesktop && desktop.available
    ? engineCompat.meetsFloor(desktop.available, engine.latestMinDesktop)
    : null;
  const busy = desktopUpdateRefusal() === 'busy';
  return { desktop, engine, busy, pairWarning: runningPair ? runningPair.message : null, engineUpdate: enginePrepSnapshot() };
});

// The loaded UI shows the in-app ready dialog (it ships with the engine; older ones do not).
ipcMain.handle('update:panel-ready', (event) => {
  assertTrustedSender(event, 'update:panel-ready');
  panelShowsReadyDialog = true;
  maybeAnnounceUpdateReady(); // something staged before this UI was up is asked about now
  return true;
});

// The resumed outcome's pull channel: the panel takes this the moment it mounts (no feed check), so
// it is reported even when the startup push beat the listener and the popover is never opened. The
// renderer-side key dedups the overlap with the push.
ipcMain.handle('update:take-resumed', (event) => {
  assertTrustedSender(event, 'update:take-resumed');
  const resumed = resumedPanelUpdate;
  resumedPanelUpdate = null;
  return resumed;
});

// A pair the contract forbids that is RUNNING (repair offline/held/declined at launch): the panel pulls
// this once at mount and toasts it — reading it only inside the popover warned nobody who never opened it.
ipcMain.handle('update:pair-warning', (event) => {
  assertTrustedSender(event, 'update:pair-warning');
  const issue = uvManager && uvManager.getInstalledFlowBin() ? uvManager.installedPairIssue() : null;
  return issue ? issue.message : null;
});

ipcMain.handle('update:download-desktop', async (event) => {
  assertTrustedSender(event, 'update:download-desktop');
  const refusal = desktopUpdateRefusal();
  if (refusal) return { started: false, reason: refusal };
  const plan = panelUpdatePlan;
  const current = effectiveDesktopVersion();
  if (plan && plan.desktopVersion && plan.desktopVersion === current) {
    // The automatic flow already has this release (downloading or ready): the click adopts it as is —
    // the engine riding along stays.
    plan.background = false;
    if (enginePrep && enginePrep.desktopVersion === plan.desktopVersion) enginePrep.background = false;
    const riding = plan.engineVersion ? { engineVersion: plan.engineVersion } : {};
    if (desktopDownloadedVersion === current) {
      plan.announced = false; // the click asks for the question again
      maybeAnnounceUpdateReady();
      return { started: true, ready: true, version: current, ...riding };
    }
    if (!desktopDownloadPending()) restartPlannedDownload(current); // cancelled or failed: the click retries it
    return { started: true, version: current, ...riding };
  }
  if (desktopStatus.state !== 'available' && !current) await getDesktopUpdateVersion();
  const version = effectiveDesktopVersion();
  if (!version) {
    return { started: false, reason: desktopStatus.state === 'current' ? 'no-update' : desktopStatus.state };
  }
  log.info(`[electron-updater] panel: downloading desktop ${version}`);
  const r = startCoordinatedUpdate({ desktopVersion: version, engineVersion: null });
  return r.ready ? { started: true, ready: true, version } : { started: true, version };
});

/** "Update now" for the downloaded desktop (with the engine agreed alongside it): the app restarts to install. */
async function applyDownloadedDesktop() {
  const refusal = desktopUpdateRefusal();
  if (refusal) return { started: false, reason: refusal };
  if (!desktopDownloadedVersion) return { started: false, reason: 'not-downloaded' };
  const version = desktopDownloadedVersion;
  log.info(`[electron-updater] installing the downloaded ${version} now`);
  // A desktop update never leaves the engine behind: installing now also agrees to any engine version
  // saved alongside this update.
  markPendingEngineConsented(pendingEngineStore);
  sendDesktopUpdateState({ state: 'installing', version });
  // The REAL outcome: when the updater fails (even after quitAndInstall returned), onFailure has
  // already pushed the error row and brought the backend back — the answer must not say "started".
  // keepWindow: the panel's "Restarting to install…" stays on screen until the quit takes the window —
  // a hidden window with nothing happening is the worst state to leave a user in.
  const outcome = await restartApplier.apply({ keepWindow: true });
  if (outcome === 'quitting') return { started: true, version };
  if (outcome === 'restart-required') return { started: false, reason: 'restart-required' };
  return { started: false, reason: outcome === 'busy' ? 'busy' : 'apply-failed' };
}

ipcMain.handle('update:apply-desktop', async (event) => {
  assertTrustedSender(event, 'update:apply-desktop');
  return applyDownloadedDesktop();
});

// The panel's "Cancel download": a stalled download never ends by itself (no timeout on Electron's net stack).
ipcMain.handle('update:cancel-desktop', (event) => {
  assertTrustedSender(event, 'update:cancel-desktop');
  return { cancelled: cancelDesktopDownload('cancelled from the version panel') };
});

// The loading screen's "Skip" during the desktop-first update (loading.html is a file:// page, so the
// check is the window, not the backend origin): set up with THIS desktop instead of waiting.
function ipcSkipDesktopUpdate(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !skippableDesktopDownload) return;
  cancelDesktopDownload('skipped from the loading screen');
}
ipcMain.on('skip-desktop-update', ipcSkipDesktopUpdate);

// "Restart FlowPad" after a late install failure: a fresh process installs the downloaded update cleanly.
ipcMain.handle('update:restart-app', (event) => {
  assertTrustedSender(event, 'update:restart-app');
  relaunchToRetryUpdate();
  return { started: true };
});

/** Quit (the normal graceful shutdown) and start again — the one way out once the updater is poisoned. */
function relaunchToRetryUpdate() {
  log.info('[update] relaunching so a fresh process can apply the update');
  relaunchPending = true;
  quitGate.allow('restarting to retry the update');
  app.relaunch();
  app.quit();
}

// The panel's Upgrade (and the popup's "works with this desktop" pin): stage the release in the background
// — the running engine keeps serving — then the in-app question: restart the engine now, or later.
ipcMain.handle('update:prepare-engine', async (event, opts) => {
  assertTrustedSender(event, 'update:prepare-engine');
  if (!uvManager) return { started: false, reason: 'unsupported' };
  const requested = (opts && opts.version) || null;
  if (requested) {
    if (!engineCompat.isInstallableVersion(requested)) return { started: false, reason: 'invalid-version' };
    const installed = uvManager.getInstalledVersionSync() || null;
    if (installed && !isNewer(installed, requested)) return { started: false, reason: 'not-newer' };
  }
  if (engineChangeAllowed('preparing an engine update') !== 'allow') {
    const verdict = requested ? await engineFloorAllows(requested, app.getVersion()) : { allowed: false };
    if (!verdict.allowed) return { started: false, desktopUpdatePending: true, reason: 'desktop-first' };
  }
  if (uvManager.isInstalling()) return { started: false, reason: 'busy' };
  panelShowsReadyDialog = true; // only a UI that shows the in-app dialog knows this channel
  if (enginePrep && enginePrep.state === 'ready' && !enginePrep.desktopVersion && (!requested || requested === enginePrep.version)) {
    // Already staged (in the background, or answered "Later"): the click asks the question again.
    enginePrep.background = false;
    enginePrep.announced = false;
    maybeAnnounceUpdateReady();
    return { started: true, ready: true, version: enginePrep.version };
  }
  const prep = startEnginePrepare({ version: requested, source: 'panel' });
  return prep ? { started: true, version: requested } : { started: false, reason: 'unsupported' };
});

// The panel's "Cancel" for a prepare in progress (a stalled network never ends it by itself).
ipcMain.handle('update:cancel-engine', (event) => {
  assertTrustedSender(event, 'update:cancel-engine');
  return { cancelled: !!(uvManager && typeof uvManager.cancelPrepare === 'function' && uvManager.cancelPrepare('cancelled from the version panel')) };
});

/** "Update now" for a prepared engine-only update: stop, install offline (seconds), start. */
async function applyPreparedEngine() {
  if (!enginePrep || enginePrep.state !== 'ready' || enginePrep.desktopVersion) return { started: false, reason: 'not-prepared' };
  // A desktop update that became pending after the prepare goes first (the same rule as everywhere).
  if (engineChangeAllowed('applying a prepared engine') !== 'allow') return { started: false, reason: 'desktop-first' };
  const prepared = enginePrep.prepared;
  const guarded = await startGuard.run('upgrade-flowpad', () => upgradeFlowpadAndRestart({ prepared }));
  if (guarded.skipped) return { started: false, reason: 'busy' };
  if (guarded.result && guarded.result.success) {
    enginePrep = null;
    const rec = pendingEngineStore.read();
    if (rec && rec.source === 'engine' && rec.engineVersion === prepared.version) pendingEngineStore.clear(); // applied now, not at the next start
  }
  return guarded.result && guarded.result.success ? { started: true, version: prepared.version } : { started: false, reason: 'apply-failed', error: guarded.result && guarded.result.error };
}

ipcMain.handle('update:apply-engine', async (event) => {
  assertTrustedSender(event, 'update:apply-engine');
  return applyPreparedEngine();
});

ipcMain.handle('update:both', async (event, requestedEngineVersion) => {
  assertTrustedSender(event, 'update:both');
  let engineVersion = requestedEngineVersion;
  if (!uvManager) return { started: false, reason: 'unsupported' };
  const refusal = desktopUpdateRefusal();
  if (refusal) return { started: false, reason: refusal };
  if (!engineCompat.isInstallableVersion(engineVersion)) return { started: false, reason: 'invalid-version' };
  if (desktopStatus.state !== 'available' && !desktopDownloadedVersion && !desktopDownloadPending()) {
    await getDesktopUpdateVersion();
  }
  const desktopVersion = effectiveDesktopVersion();
  if (!desktopVersion) return { started: false, reason: 'no-update' };
  // The engine's own floor must accept the desktop about to be installed — a pin the TARGET desktop
  // cannot run would doom the round (the new desktop refuses it, clears the pending state, and the
  // panel offers the same lost round again). Product rule: a desktop update never leaves the engine
  // behind AND never refuses outright — an unfit pin is SUBSTITUTED by the newest engine the target
  // desktop accepts; none newer than installed → the desktop goes alone (the installed engine was
  // selected for a desktop this one supersedes, and the startup pair repair has the last word).
  const verdict = await engineFloorAllows(engineVersion, desktopVersion);
  if (!verdict.allowed && !verdict.known) {
    // Unreadable metadata is NOT a verdict: dropping the engine on "unknown" contradicted the rule
    // ("a desktop update never leaves the engine behind"). Keep the pin — the install gates check
    // both directions before and after, with rollback.
    log.info(`[update] panel: ${engineVersion}'s floor is unreadable — keeping the pin; the install gates decide`);
  } else if (!verdict.allowed) {
    let substitute = null;
    try { substitute = await uvManager.resolveCompatibleEngineVersion({ desktopVersion }); } catch { substitute = null; }
    const installedEngine = uvManager.getInstalledVersionSync() || null;
    if (substitute && installedEngine && isNewer(installedEngine, substitute.version)) {
      log.info(`[update] panel: engine ${engineVersion} needs desktop ${verdict.floor || 'unknown'}; riding with ${substitute.version} instead (fits ${desktopVersion})`);
      engineVersion = substitute.version;
    } else {
      log.info(`[update] panel: no newer engine fits desktop ${desktopVersion} — updating the desktop alone`);
      engineVersion = null;
    }
  }
  log.info(`[update] panel: coordinated update — desktop ${desktopVersion}${engineVersion ? `, then engine ${engineVersion}` : ' (no engine rides along)'}`);
  const plan = panelUpdatePlan;
  if (plan && plan.desktopVersion === desktopVersion && plan.engineVersion === (engineVersion || null)) {
    // The automatic flow already stages exactly this pair: the click adopts it (no second download).
    plan.background = false;
    if (enginePrep && enginePrep.desktopVersion === desktopVersion) enginePrep.background = false;
    if (desktopDownloadedVersion === desktopVersion) { plan.announced = false; maybeAnnounceUpdateReady(); }
    else if (!desktopDownloadPending()) restartPlannedDownload(desktopVersion); // cancelled or failed: the click retries it
    return desktopDownloadedVersion === desktopVersion ? { started: true, ready: true, version: desktopVersion, engineVersion } : { started: true, version: desktopVersion, engineVersion };
  }
  // The popup click is the agreement to BOTH versions; everything else happens behind the scenes, and the
  // app asks once both are ready — update now or later (the next start installs both either way).
  const r = startCoordinatedUpdate({ desktopVersion, engineVersion });
  // `engineVersion` tells the panel whether an engine rides along (null → the desktop goes alone).
  return r.ready ? { started: true, ready: true, version: desktopVersion, engineVersion } : { started: true, version: desktopVersion, engineVersion };
});

async function upgradeFlowpadAndRestart({ version = null, prepared = null } = {}) {
  // Resolve the target while the backend still RUNS: a resolution failure ("no compatible release",
  // PyPI answered and refused) must come back as an error the panel can show — not stop the server
  // and swap the window to the splash first. A null (contract not evaluable) proceeds as before.
  let picked;
  try {
    // A requested pin (the popup's fallback) skips the resolve: upgrade()'s own candidate gate
    // (_assertCandidateCompatible) still checks both directions against the running desktop.
    picked = prepared ? { version: prepared.version } : version ? { version } : await uvManager.resolveCompatibleEngineVersion();
  } catch (resolveErr) {
    log.warn(`[uv] panel upgrade refused before stopping anything: ${String(resolveErr.message).split('\n')[0]}`);
    return { success: false, error: resolveErr.message };
  }
  // Captured while the old engine still runs: recovery must know what to put BACK — by the time the
  // upgrade fails, uv --force may already have replaced the installed engine with the unhealthy one.
  const versionBeforeUpgrade = uvManager.getInstalledVersionSync() || null;
  const targetVersion = picked ? picked.version : null;
  // The rollback record BEFORE the destructive step, as the launch path does: a close or a power cut
  // while the new engine boots must leave the next start a way back (installing → installed → spent at
  // the healthy gate; failed-unhealthy vetoes the version).
  const recordSwap = (state) => {
    if (targetVersion && versionBeforeUpgrade) pendingEngineStore.write({ engineVersion: targetVersion, previousEngine: versionBeforeUpgrade, consented: false, source: 'engine', ...state });
  };
  let installedNew = false;
  try {
    // Show loading screen
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadFile(path.join(__dirname, 'loading.html'));
      await new Promise(r => setTimeout(r, 200));
    }

    sendStatus('Stopping server');
    await uvManager._flowStop();
    await uvManager._killPort(9007);
    uvManager.isShuttingDown = false;
    uvManager._backendProcess = null;

    recordSwap({ phase: 'installing' });
    await uvManager.upgrade({ version: picked ? picked.version : undefined, prepared, onProgress: installProgress('Upgrading Flowpad') });
    installedNew = true;
    recordSwap({ phase: 'installed' });

    sendStatus('Starting server');
    await uvManager.start();

    sendStatus('Waiting for server');
    const { ready } = await waitForBackend({ maxChecks: POST_UPGRADE_HEALTH_CHECKS });
    // Not healthy is a FAILED upgrade, exactly like a throw: returning here left the window on the
    // splash with nothing serving it (the quieter half of the "stuck update" incident).
    if (!ready) throw new Error('the upgraded backend did not become healthy');
    // Healthy: the record is spent (only a swap's own record — never someone else's).
    const rec = pendingEngineStore.read();
    if (rec && rec.phase === 'installed' && rec.engineVersion === targetVersion) pendingEngineStore.clear();
    if (typeof uvManager.compileBytecodeInBackground === 'function') void uvManager.compileBytecodeInBackground();

    // The IPC's answer goes to a page loadFile() destroyed: the reloaded panel PULLS the outcome
    // (update:take-resumed, the same channel a post-restart resume uses).
    // kind 'engine': the desktop did not change — the toast must not claim it was updated.
    resumedPanelUpdate = { kind: 'engine', success: true, engineVersion: uvManager.getInstalledVersionSync() || (picked && picked.version) || null, desktopVersion: app.getVersion() };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(BACKEND_URL);
    }

    return { success: true };
  } catch (err) {
    // The backend is already stopped and the window is on the splash: restore the old engine the way
    // the dialog path does (the "stuck update" incident was exactly this catch returning with the
    // splash still up and nothing running). If even recovery fails, the startup error panel names it.
    log.error(`[uv] panel upgrade failed: ${String(err.message).split('\n')[0]} — restoring the running version`);
    // Installed but never healthy: veto that version (not offered again until a newer one exists) — a
    // consented record left behind used to install the same failed release silently at the next start.
    // Failed before installing: nothing to veto; the record goes.
    if (installedNew) recordSwap({ phase: 'failed-unhealthy', failedVersion: targetVersion });
    else { const rec = pendingEngineStore.read(); if (rec && rec.phase === 'installing' && rec.engineVersion === targetVersion) pendingEngineStore.clear(); }
    const restored = await uvManager.recoverAfterFailedUpgrade(mainWindow, {
      waitForBackend,
      backendUrl: BACKEND_URL,
      sendStatus,
      restoreVersion: versionBeforeUpgrade,
    });
    if (restored) {
      // The page the IPC answered was destroyed by loadFile(): the reloaded panel pulls the failure.
      resumedPanelUpdate = { kind: 'engine', success: false, restored: true, engineVersion: (picked && picked.version) || version || null, desktopVersion: app.getVersion(), error: err.message };
    } else {
      // Detached: the IPC answers now; the panel's Retry keeps re-running the recovery (it works
      // from uv's local cache, so it has a real chance even offline). Quit-only was a dead end.
      void offerRecoveryRetry(err, { restoreVersion: versionBeforeUpgrade });
    }
    return { success: false, error: err.message };
  }
}

/**
 * The error panel after a FAILED recovery, with a Retry that actually works: 'retry-startup' is
 * only listened for during the startup loop, so this re-arms it and re-runs the recovery until it
 * lands or the app quits. Each attempt is user-driven (a click), never a timer.
 */
async function offerRecoveryRetry(err, { restoreVersion = null } = {}) {
  for (;;) {
    await showStartupErrorPanel(describeStartupFailure(err), { retryable: true });
    if (isQuitting) return;
    await waitForRetryRequest();
    if (isQuitting) return;
    sendStatus('Retrying');
    const restored = await uvManager.recoverAfterFailedUpgrade(mainWindow, {
      waitForBackend,
      backendUrl: BACKEND_URL,
      sendStatus,
      restoreVersion,
    });
    if (restored) {
      // The error panel set startupFailed; the backend is healthy again — without this a macOS Dock
      // click (activate) treated the app as stuck and relaunched it over the healthy backend.
      startupFailed = false;
      return;
    }
  }
}

/**
 * Provision the per-instance Fernet sod-key in the OS keychain via the
 * bundled signed flow-rs binary. Returning the value here lets the
 * renderer hand it to Python via the /secrets/seed-key endpoint, so
 * Python never makes a keyring write of its own — keeping the keychain
 * ACL trust list flow-rs-only (no python3.x ownership).
 *
 * Two modes:
 *   * No argument: mint a fresh Fernet key (32 random bytes, url-safe
 *     base64). Used in fresh-install + SecretApprovalDialog approval.
 *   * `existingValue` supplied: write the supplied value verbatim.
 *     Used by the one-shot legacy migration flow — backend reads the
 *     legacy python3.x-owned key (which still decrypts the existing
 *     sodot) and hands it here so flow-rs can re-write it at the
 *     `.flow-rs` slot, preserving the user's secrets.
 *
 * Idempotent: if an entry already exists at the flow-rs slot, returns
 * it unchanged (skips both mint AND re-write).
 */
ipcMain.handle('secrets:provision-sod-key', async (event, existingValue) => {
  assertTrustedSender(event, 'secrets:provision-sod-key');
  let flowRs;
  try {
    flowRs = require('./flow-rs-keychain');
  } catch (err) {
    log.error(`[secrets] flow-rs-keychain not available: ${err.message}`);
    throw new Error('flow-rs-keychain unavailable');
  }
  const account = flowRs.sodKeyAccount();
  try {
    const existing = await flowRs.getKeyRestricted(SOD_KEY_KEYCHAIN_SERVICE, account);
    if (existing) {
      log.info(`[secrets] sod_key already present in keychain (${account}); returning existing`);
      return existing;
    }
  } catch (err) {
    log.warn(`[secrets] keychain probe failed (${err.message}); minting/migrating fresh`);
  }
  let key;
  if (typeof existingValue === 'string' && existingValue.length > 0) {
    key = existingValue;
    log.info(`[secrets] migrating supplied legacy sod_key to keychain (${account}) via flow-rs`);
  } else {
    // Fernet key: 32 random bytes, url-safe base64 with padding.
    key = crypto.randomBytes(32).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_');
    log.info(`[secrets] minted fresh sod_key for keychain (${account})`);
  }
  await flowRs.setKeyRestricted(SOD_KEY_KEYCHAIN_SERVICE, account, key);
  log.info(`[secrets] wrote sod_key to keychain (${account})`);
  return key;
});

ipcMain.handle('open-external', async (_, url) => {
  const { shell } = require('electron');
  log.info(`[open-external] requested: ${redactUrl(url)}`);
  // Only allow http/https URLs for security — and mailto:, which hands a draft to the mail app
  // (a page's "send by email"); no other scheme reaches the system.
  if (typeof url === 'string' && /^(https?:\/\/|mailto:)/.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  log.warn(`[open-external] blocked URL: ${redactUrl(url)}`);
  return false;
});

