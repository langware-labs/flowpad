/**
 * RuntimeKind — what the app is running as, and the ONLY answer to that
 * question anywhere in the frontend.
 *
 * The value is resolved by the BACKEND and arrives on `BootstrapInfo.runtime`.
 * No component, hook, or service re-derives it: not from `window.location`, not
 * from `env_name`, not from the presence of a bridge object. If you find
 * yourself testing a hostname to decide what to render, the answer you want is
 * `dataContext.runtimeKind`.
 *
 * The one exception is `isElectronShell()` below, and it is not a detector for
 * consumers — it is the single input the client CONTRIBUTES to the server's
 * decision, because the preload bridge is the only thing that can know it.
 *
 * LEAF module by design: zero imports. `hub-runtime.ts` (itself a leaf, to
 * avoid an entity→context→entity init cycle) imports `RuntimeKind` from here,
 * so anything this file pulled in would be pulled into that cycle too.
 */

export enum RuntimeKind {
  /** The Electron desktop shell. */
  DESKTOP = 'desktop',
  /** A browser tab pointed at a local server — same backend, different client. */
  BROWSER = 'browser',
  /** An E2B cloud box a human opened. */
  SANDBOX = 'sandbox',
  /** An E2B cloud box an agent Identity was deployed into. */
  AGENT = 'agent',
  /** The hub backend. */
  HUB = 'hub',
}

/** The aggregate the backend consolidated. Mirrors `flow_sdk/models/bootstrap_models.py`. */
export interface RuntimeInfo {
  /** The answer. Everything else here is the input that produced it. */
  kind: RuntimeKind;
  /** What the hub told this instance it is; wins over local signals when set. */
  assigned?: RuntimeKind | null;
  /** Echo of the `electron` flag this client sent. */
  electron?: boolean;
  /** Which backend built it. */
  host?: 'local' | 'hub';
}

/**
 * Is this bundle running inside the Electron shell?
 *
 * `electronAPI` is injected by the preload script and is absent in a browser
 * tab, so this is the one runtime fact only the client can observe. It exists
 * to be SENT to the server on bootstrap (`store.bootstrap`), which folds it in
 * and returns the consolidated `RuntimeKind`.
 *
 * Do not call this to decide what to render — read `runtimeKind` for that.
 * Testing for a specific bridge METHOD (e.g. `electronAPI.captureRegion`) is a
 * different question, a capability probe, and stays where it is.
 */
export function isElectronShell(): boolean {
  return typeof window !== 'undefined' && !!(window as { electronAPI?: unknown }).electronAPI;
}

/** Palette of the terminal a worker will paint into, or undefined off-DOM.
 *
 * The second client-contributed signal in this module, and for the same reason
 * as `isElectronShell()`: only the browser can know it. Workers paint in
 * truecolor (their PTY runs with `COLORTERM=truecolor`), so none of their
 * foregrounds are ANSI-indexed and the host xterm palette cannot recolor them.
 * The CLI picks those RGB values from its own theme setting at startup, so a
 * worker launched without this inherits the user's global (usually dark) theme
 * and paints pale grey on a light terminal.
 *
 * Read from the class next-themes writes on `<html>` rather than from
 * `useTheme()`, because every launch path that needs it — `AgenticProcess.start`,
 * `ComputeNode.createProcess`, the recovery retries — is outside React.
 *
 * Undefined off-DOM (node tests, headless callers) leaves the worker unpinned,
 * which is the right answer for a launch with no terminal to match.
 */
export function hostTerminalTheme(): 'light' | 'dark' | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}
