import { getTraceId } from './trace';

/**
 * Renderer logging that survives DevTools.
 *
 * The Electron desktop app already writes its MAIN process logs to
 * ``~/.flow/logs/main_desktop/*.log`` via electron-log. This module forwards
 * the RENDERER's console output to that same file over IPC (channel
 * ``renderer-log``, exposed as ``window.electronAPI.logToFile``), so the
 * frontend console is no longer ephemeral. Every forwarded line is prefixed
 * with the trace id (see trace.ts) so it joins the backend log lines for the
 * same action.
 *
 * In a plain browser (no ``window.electronAPI``) this is a no-op beyond the
 * normal console — nothing to forward to.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ElectronLogBridge {
  logToFile?: (level: LogLevel, message: string) => void;
}

function bridge(): ElectronLogBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: ElectronLogBridge }).electronAPI;
}

function safeStringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// Reentrancy guard: forwarding must never re-enter a patched console method.
let _forwarding = false;

function forward(level: LogLevel, args: unknown[]): void {
  const sink = bridge()?.logToFile;
  if (!sink || _forwarding) return;
  _forwarding = true;
  try {
    const message = args.map(safeStringify).join(' ');
    sink(level, `[${getTraceId()}] ${message}`);
  } catch {
    /* never let logging throw */
  } finally {
    _forwarding = false;
  }
}

let _consoleCaptured = false;

/**
 * Tee every ``console.{debug,info,log,warn,error}`` call to the Electron log
 * file. The original console method is always called first, so DevTools output
 * and Sentry's console instrumentation are unaffected. Idempotent.
 */
export function installConsoleCapture(): void {
  if (_consoleCaptured || typeof console === 'undefined') return;
  _consoleCaptured = true;

  const levels: Array<[string, LogLevel]> = [
    ['debug', 'debug'],
    ['info', 'info'],
    ['log', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ];

  const target = console as unknown as Record<string, (...a: unknown[]) => void>;
  for (const [method, level] of levels) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = (...args: unknown[]) => {
      original.apply(console, args);
      forward(level, args);
    };
  }
}

/**
 * Persist unhandled errors / promise rejections to the Electron log file.
 * (Sentry already ships these to the cloud; this keeps a local on-disk copy.)
 */
export function installGlobalErrorCapture(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (e: ErrorEvent) => {
    forward('error', ['[window.onerror]', e.message, e.error ?? '']);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    forward('error', ['[unhandledrejection]', e.reason ?? '']);
  });
}

/**
 * One-call init for the renderer. Installs console + global-error capture and
 * emits a startup line so each session is greppable by its trace id.
 */
export function initLogging(): string {
  installConsoleCapture();
  installGlobalErrorCapture();
  const traceId = getTraceId();
  if (bridge()?.logToFile) {
    forward('info', [`renderer logging initialized (trace=${traceId})`]);
  }
  return traceId;
}

/**
 * Thin convenience wrapper. Routes through console (which is captured), so
 * call sites that want explicit levels can use this instead of raw console.
 */
export const logger = {
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
