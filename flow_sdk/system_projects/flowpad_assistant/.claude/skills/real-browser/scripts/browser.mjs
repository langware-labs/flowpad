#!/usr/bin/env node
// One real browser per Flowpad instance, driven through the chrome-devtools CLI
// (the CLI face of Chrome DevTools MCP). Node only — the CLI needs Node anyway —
// so the same script runs from bash, Git Bash and PowerShell on macOS, Linux and
// Windows. Every command prints what it did.
//
//   browser start          launch the user's installed Chrome (or Edge) on the agent profile
//   browser start --real   attach to the user's own running Chrome (consent flow)
//   browser run <tool> …   run one chrome-devtools tool in this instance's session
//   browser front          ask the OS to bring the agent's browser window forward, by pid
//   browser status         print mode, browser, pid, port, session
//   browser stop           end the session; closes the browser only if this script launched it
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const INSTANCE = process.env.FLOW_INSTANCE || 'prod';
const BASE = path.join(os.homedir(), '.flow', 'instances', INSTANCE, 'browser');
const STATE = path.join(BASE, 'state.json');
const PROFILE = path.join(BASE, 'profile');
fs.mkdirSync(BASE, { recursive: true });

const fail = (code, ...lines) => { for (const l of lines) console.error(l); process.exit(code); };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
let state = readState();

// The chrome-devtools CLI is installed by Flowpad's `browser-setup` wizard
// (`npm install -g chrome-devtools-mcp`). On Windows npm installs a .cmd shim,
// which only a shell can run, so there the call is ONE quoted command line
// (handing an args array to a shell is deprecated: Node does not escape it).
const SETUP = 'run `flow wizard run browser-setup` -- it asks the user before installing Node.js, the chrome-devtools CLI and a browser -- then start again';
const cliInstalled = () => spawnSync(WIN ? 'where.exe' : 'which', ['chrome-devtools'], { stdio: 'ignore' }).status === 0;
function cli(args, opts = {}) {
  if (!cliInstalled()) fail(8, 'NEEDS_SETUP: the chrome-devtools CLI is not installed.', `  ${SETUP}`);
  if (!WIN) return spawnSync('chrome-devtools', args, { encoding: 'utf8', ...opts });
  const line = ['chrome-devtools', ...args].map(a => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  return spawnSync(line, { shell: true, encoding: 'utf8', ...opts });
}

// The user's installed browsers, preferred first. Edge is last on purpose: it is
// what a Windows user has when they never installed Chrome.
function findBrowser() {
  const env = process.env;
  const candidates = [env.CHROME_BIN];
  if (MAC) candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  else if (WIN) for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) candidates.push(
    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  else for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0) candidates.push(r.stdout.trim());
  }
  if (WIN) candidates.sort((a, b) => Number(/msedge/i.test(a ?? '')) - Number(/msedge/i.test(b ?? '')));
  return candidates.find(c => c && fs.existsSync(c));
}

// Chrome's own data dir — where --autoConnect looks for DevToolsActivePort.
function userChromeDir() {
  if (MAC) return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  if (WIN) return path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'google-chrome');
}

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function cdpUp(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
}
const agentAlive = async () => state.mode === 'agent' && pidAlive(state.pid) && await cdpUp(state.port);
const freePort = () => new Promise(res => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

// `chrome-devtools start` RESTARTS a running daemon, which would cut off another
// agent mid-call on the same session — so start only when none is running.
function startDaemon(connectArgs) {
  if (/is running/.test(cli(['status', '--sessionId', state.session]).stdout ?? '')) return;
  const r = cli(['start', ...connectArgs, '--sessionId', state.session, '--no-usage-statistics', '--no-performance-crux']);
  if (r.status !== 0) fail(6, 'DAEMON_FAILED:', r.stdout ?? '', r.stderr ?? '');
}

async function startAgent() {
  if (await agentAlive()) {
    console.log(`reusing agent browser pid=${state.pid} port=${state.port}`);
  } else {
    const exe = findBrowser();
    if (!exe) fail(2, 'NO_BROWSER: neither Chrome nor Edge is installed.', `  ${SETUP}`);
    const port = await freePort();
    const log = fs.openSync(path.join(BASE, 'browser.log'), 'w');
    const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    for (let i = 0; i < 75 && !(await cdpUp(port)); i++) {
      if (!pidAlive(child.pid)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!(await cdpUp(port))) fail(3,
      'BROWSER_DID_NOT_START: the agent profile may already be open in another browser process',
      `  profile: ${PROFILE}`, fs.readFileSync(path.join(BASE, 'browser.log'), 'utf8').split('\n').slice(-5).join('\n'));
    state = { mode: 'agent', browser: exe, pid: child.pid, port, session: state.session };
    console.log(`launched agent browser ${path.basename(exe)} pid=${child.pid} port=${port} profile=${PROFILE}`);
  }
  state.session ||= randomUUID();
  saveState(state);
  startDaemon(['--browserUrl', `http://127.0.0.1:${state.port}`]);
  console.log(`session=${state.session} ready`);
}

function copyToClipboard(text) {
  const tool = MAC ? ['pbcopy', []] : WIN ? ['clip', []] : ['xclip', ['-selection', 'clipboard']];
  return spawnSync(WIN ? 'clip.exe' : tool[0], tool[1], { input: text }).status === 0;
}

function startReal() {
  if (!fs.existsSync(userChromeDir())) fail(7,
    "NO_CHROME: Google Chrome is not installed for this user, and attaching works only with Chrome.",
    '  Tell the user, and offer the agent profile (browser start) instead.');
  if (!fs.existsSync(path.join(userChromeDir(), 'DevToolsActivePort'))) {
    const copied = copyToClipboard('chrome://inspect/#remote-debugging');
    fail(4, "NEEDS_USER: remote debugging is off in the user's Chrome (or Chrome is not running).",
      '  Ask the user to: open their Chrome, paste chrome://inspect/#remote-debugging',
      `  into the address bar${copied ? ' (it is on the clipboard)' : ''}, turn remote debugging on,`,
      '  then say so. Chrome will then show an Allow dialog for them to click.');
  }
  state = { mode: 'real', session: randomUUID() };
  saveState(state);
  startDaemon(['--autoConnect']);
  console.log(`session=${state.session} attached to the user's Chrome (they must click Allow in Chrome)`);
}

function front() {
  if (state.mode !== 'agent' || !pidAlive(state.pid)) fail(1, `nothing to bring forward (mode=${state.mode ?? 'none'}); ask the user to switch to the window`);
  const r = MAC
    ? spawnSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${state.pid}).activateWithOptions(3)`])
    : WIN
      ? spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${state.pid}) | Out-Null`])
      : { status: 1 };
  if (r.status !== 0) fail(1, 'could not request focus on this OS; ask the user to switch to the window');
  console.log(`focus requested for agent browser pid=${state.pid}; the OS may keep a full-screen app in front, so confirm with the user`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'start':
    if (rest[0] === '--real') startReal(); else await startAgent();
    break;
  case 'run': {
    if (!state.session) fail(5, "NOT_STARTED: run 'browser start' first");
    const r = cli([...rest, '--sessionId', state.session], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  case 'front': front(); break;
  case 'status':
    console.log(`mode=${state.mode ?? 'none'} browser=${state.browser ?? ''} pid=${state.pid ?? ''} port=${state.port ?? ''} session=${state.session ?? ''}`);
    if (state.session) process.stdout.write(cli(['status', '--sessionId', state.session]).stdout ?? '');
    break;
  case 'stop':
    if (state.session) cli(['stop', '--sessionId', state.session]);
    if (state.mode === 'agent' && state.pid && pidAlive(state.pid)) {
      if (WIN) spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(state.pid);
      console.log(`closed agent browser pid=${state.pid}`);
    }
    fs.rmSync(STATE, { force: true });
    console.log('stopped');
    break;
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(1);
}
