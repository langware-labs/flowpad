'use strict';

/*
 * A hung or crashed window leaves a report for later analysis: one JSON file per event under
 * `<main_desktop logs>/renderer-failures/`, named by time and kind, plus a log line naming it. Everything
 * the main process can still see goes in — the renderer's JS call stack (taken from the live, busy
 * renderer before it is killed), every process's CPU / memory, the window's history, the backend's
 * answer, and the crash reason — so the next freeze is diagnosed from the file, not reproduced.
 *
 * Collection never throws and never waits long: each source is bounded and a failed source is recorded
 * as its error instead.
 */

const fs = require('fs');
const path = require('path');

const KEEP = 30; // newest reports kept; older ones are pruned on write

/** Run `fn`, bounded to `ms`; its result, `onTimeout` when it does not answer in time, or `{ error }`. */
async function bounded(fn, ms, onTimeout = { error: `no answer within ${ms} ms` }) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); }),
    ]);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} o
 * @param {'hang'|'crash'} o.kind
 * @param {object} o.detail          what detected it (source, silentMs) or the crash details (reason, exitCode)
 * @param {Electron.WebContents} o.webContents
 * @param {Electron.App} o.app
 * @param {(url: string) => string} o.redactUrl
 * @param {() => Promise<object>} [o.backendHealth]
 */
async function collectFailureReport({ kind, detail, webContents: wc, app, redactUrl, backendHealth }) {
  // Metrics first: the CPU numbers belong to the moment of the failure, not to after the waits below.
  const processes = safe(() => app.getAppMetrics().map((m) => ({
    pid: m.pid, type: m.type, name: m.name, cpuPercent: m.cpu && m.cpu.percentCPUUsage,
    workingSetKB: m.memory && m.memory.workingSetSize, peakWorkingSetKB: m.memory && m.memory.peakWorkingSetSize,
  })));
  const [jsCallStack, backend] = await Promise.all([
    // Only a live renderer has a stack; a crashed one has none.
    kind === 'hang' ? bounded(() => wc.mainFrame.collectJavaScriptCallStack(), 3000) : null,
    backendHealth ? bounded(backendHealth, 3000) : null,
  ]);
  return {
    kind,
    at: new Date().toISOString(),
    detail,
    url: safe(() => redactUrl(wc.getURL())),
    title: safe(() => wc.getTitle()),
    rendererPid: safe(() => wc.getOSProcessId()),
    versions: { app: safe(() => app.getVersion()), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    platform: `${process.platform} ${process.arch}`,
    uptimeSec: Math.round(process.uptime()),
    systemMemory: safe(() => process.getSystemMemoryInfo()),
    history: safe(() => {
      const h = wc.navigationHistory;
      return { active: h.getActiveIndex(), entries: h.getAllEntries().map((e) => redactUrl(e.url)) };
    }),
    jsCallStack,
    processes,
    backend,
  };
}

function safe(fn) {
  try { return fn(); } catch (err) { return { error: String((err && err.message) || err) }; }
}

/** Write `report` into `dir`, prune old ones; returns the file path (or null when the disk refused). */
function writeFailureReport(dir, report) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${report.at.replace(/[:.]/g, '-')}_${report.kind}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  } catch {
    return null;
  }
}

module.exports = { bounded, collectFailureReport, writeFailureReport };
