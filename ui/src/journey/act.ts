import { Capability, capabilityManager, dataContext, EventBus, FSRef, GitWorkdir, oauthService, Shell } from '@sdk';

import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import type { JourneyActSpec } from './use-journey';

/** A step's act landed / could not land. The step's `await` listens for these
 *  like any other bus event — gating stays ONE mechanism (see docs/topics.md). */
export const ACT_DONE_TOPIC = 'app.journey.act.done';
export const ACT_FAILED_TOPIC = 'app.journey.act.failed';

/** Bus target for an act: `<kind>:<topic word>` — e.g. `fill:AgentInstructions`. */
export function actTarget(kind: string, target: string): string {
  return `${kind}:${target}`;
}

/**
 * The editable the act should type into: the tagged element itself when it IS
 * one, else the first editable inside it. A journey tags the CONTAINER (the
 * editor pane), not the inner surface — which for a rich editor is a
 * ProseMirror node the component owns and may re-create.
 */
function editableWithin(host: HTMLElement): HTMLElement | null {
  const isEditable = (el: HTMLElement) =>
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el.isContentEditable;
  if (isEditable(host)) return host;
  return host.querySelector<HTMLElement>('input, textarea, [contenteditable="true"]');
}

/**
 * Type `text` into a `data-topic`-tagged surface, as a user would.
 *
 * Inputs/textareas are set through the NATIVE value setter + an `input` event,
 * because React installs its own value property on the instance and a plain
 * `el.value = …` is invisible to it. Rich editors (the agent instructions are a
 * Milkdown/ProseMirror doc) are fed through `insertText`, the same
 * `beforeinput` path a keystroke or a paste takes — so the editor's own parsing,
 * undo history and change events all run. Poking their DOM directly would
 * desync the document model.
 *
 * Returns false when the target isn't on screen or can't be typed into; the
 * caller emits `app.journey.act.failed` so the step can fall back to asking the
 * user to type it themselves.
 */
export function performFill(target: string, text: string): boolean {
  const host = document.querySelector<HTMLElement>(`[data-topic="${CSS.escape(target)}"]`);
  const el = host ? editableWithin(host) : null;
  if (!el) return false;

  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call below
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // contenteditable: place the caret at the end, then insert as real input.
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return document.execCommand('insertText', false, text);
}

function announce(act: { kind: string; target: string }, ok: boolean): boolean {
  EventBus.emit(
    ok ? ACT_DONE_TOPIC : ACT_FAILED_TOPIC,
    actTarget(act.kind, act.target),
    { act },
    { origin: 'app' },
  );
  return ok;
}

/** The capability row an act aims at (exact kind), or null. */
async function capabilityRow(kind: string | undefined): Promise<Capability | null> {
  if (!kind) return null;
  await capabilityManager.load();
  return capabilityManager.getAll().find((c) => c.kind === kind) ?? null;
}

/**
 * The async act kinds drive the capability system through its existing verbs.
 * "Done" here means the flow STARTED (install process spawned, OAuth window
 * opened, login session live) — the step's `await` gates on the capability
 * row actually reaching the wanted state.
 */
async function runSetupAct(act: JourneyActSpec): Promise<boolean> {
  try {
    if (act.kind === 'setup_capability') {
      if (!act.capability) return announce(act, false);
      await capabilityManager.setup(act.capability);
      return announce(act, true);
    }
    if (act.kind === 'oauth_connect') {
      await oauthService.connect(act.provider ?? 'github');
      return announce(act, true);
    }
    if (act.kind === 'device_login') {
      const row = await capabilityRow(act.capability);
      if (!row) return announce(act, false);
      // Progress (URL + one-time code) arrives on the row's login_* fields
      // over WS — the tray renders them for device_login steps.
      await row.deviceLogin();
      return announce(act, true);
    }
    return announce(act, false);
  } catch {
    return announce(act, false);
  }
}

/** A path inside the journey's project — the same base the footer git pill
 *  uses. `rel` is optional: no `rel` is the project root itself. */
function projectPath(rel?: string): string | null {
  const base = dataContext.project?.fs_storage_mount_path ?? dataContext.workdir;
  if (!base) return null;
  return rel ? `${base.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}` : base;
}

/**
 * Verify the working tree against REAL git state — the step is done only when
 * the repo says so (event ≠ proof: the user's terminal commands are invisible
 * to the bus; the repo is the truth). All probes go through the compute node's
 * `git-ops` action, the same backend the footer git pill reads.
 */
async function runGitCheck(act: JourneyActSpec): Promise<boolean> {
  try {
    const workdir = projectPath(act.dir);
    if (!workdir) return announce(act, false);
    const git = new GitWorkdir(workdir, dataContext.computeNodeTypeId?.id ?? '@local');
    switch (act.expect) {
      case 'repo':
        return announce(act, await git.isInit());
      case 'branch':
        return announce(act, !!act.branch && (await git.getBranch()) === act.branch);
      case 'staged':
      case 'clean':
      case 'dirty': {
        const status = await git.getStatus();
        if (status.error) return announce(act, false);
        if (act.expect === 'staged') return announce(act, status.files.some((f) => f.staged));
        if (act.expect === 'dirty') return announce(act, status.files.length > 0);
        return announce(act, status.files.length === 0 && (await git.hasCommit()));
      }
      default:
        return announce(act, false);
    }
  } catch {
    return announce(act, false);
  }
}

/**
 * What the manager lends an act that needs app powers it cannot reach from a
 * pure module: opening a terminal, and the id of the one currently on screen.
 */
export interface ActContext {
  /** Create + open a terminal in the current project; resolves its shell id. */
  openTerminal?: () => Promise<string | null>;
  /** The shell the current dock is showing, if any — where `run` types. */
  shellId?: string | null;
  /** Aborted when the step changes or the tray unmounts, so a watcher waiting
   *  on output lets go instead of outliving the step that started it. */
  signal?: AbortSignal;
}

/**
 * Type a command into the terminal and — when the step asserts something —
 * WATCH WHAT IT PRINTS.
 *
 * `sendInput` is fire-and-forget: it proves bytes reached the PTY, never that
 * the command worked. A step with `contains` therefore appends a sentinel
 * (`; echo "<marker>_$?"`), collects the ANSI-stripped line stream via
 * `Shell.onLine`, and decides only once the sentinel line arrives — that is
 * the one moment we know the command FINISHED. `ls` printing "No such file"
 * now fails the step instead of going green.
 *
 * Deliberately unbounded: no timer races the user's command. A command that
 * never finishes leaves the step pending (Skip is still there) rather than
 * being declared failed by a clock.
 */
async function runShellCommand(act: JourneyActSpec, ctx: ActContext): Promise<boolean> {
  try {
    // The terminal on screen IS the target, and the navigation layer owns
    // "what am I looking at" — never re-parse the address bar here.
    if (!ctx.shellId || !act.command) return announce(act, false);
    const shell = await Shell.getById(ctx.shellId);
    if (!shell) return announce(act, false);

    const needle = act.contains;
    if (!needle) {
      await shell.sendInput(`${act.command}\r`);
      return announce(act, true);
    }

    // Assert on output: watch the line stream until the sentinel reports the
    // exit code. Only the verdict is kept — never a growing transcript.
    const marker = `__journey_${Math.random().toString(36).slice(2, 10)}`;
    let seen = false;
    const settled = await new Promise<boolean>((resolve) => {
      let stop = () => {};
      // The sentinel's own echo carries the marker — ignore those lines so a
      // step can never "pass" by matching the command it just typed.
      const offLine = shell.onLine((line: string) => {
        if (!line.includes(marker) && line.includes(needle)) seen = true;
      });
      const offTrigger = shell.addTrigger({
        label: 'journey step',
        pattern: new RegExp(`${marker}_(\\d+)`),
        onMatch: (_line: string, m: RegExpMatchArray) => {
          stop();
          resolve(m[1] === '0' && seen);
        },
      });
      // ONE teardown, reached by both endings: the sentinel, and the step
      // being abandoned. Without the abort path a hung command would leave
      // these listeners (and this promise) on the PtyConnection for its life.
      stop = () => {
        offTrigger();
        offLine?.();
        ctx.signal?.removeEventListener('abort', onAbort);
      };
      function onAbort() {
        stop();
        resolve(false);
      }
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener('abort', onAbort);
    });
    await shell.sendInput(`${act.command}; echo "${marker}_$?"\r`);
    return announce(act, settled);
  } catch {
    return announce(act, false);
  }
}

/** Open a real terminal in this project — the same path the Terminal tile takes. */
async function runOpenTerminal(act: JourneyActSpec, ctx: ActContext): Promise<boolean> {
  try {
    const shellId = ctx.openTerminal ? await ctx.openTerminal() : null;
    return announce(act, !!shellId);
  } catch {
    return announce(act, false);
  }
}

/** The project-relative file an `fs_check` act probes. */
function projectFile(path: string): FSRef | null {
  const full = projectPath(path);
  return full ? new FSRef(full, dataContext.computeNodeTypeId ?? LOCAL_COMPUTE_NODE) : null;
}

/**
 * Prove a file is really there (and optionally that it carries `contains`) —
 * the filesystem is the truth. The user's terminal commands never reach the
 * bus, so "they said they ran it" is not evidence; this reads the file back.
 */
async function runFsCheck(act: JourneyActSpec): Promise<boolean> {
  try {
    const ref = projectFile(act.path ?? '');
    if (!ref || !act.path) return announce(act, false);
    if (!act.contains) return announce(act, await ref.exists());
    const body = await ref.read().catch(() => null);
    return announce(act, !!body && body.includes(act.contains));
  } catch {
    return announce(act, false);
  }
}

/** Run a step's act and announce the outcome on the bus. */
export function runAct(act: JourneyActSpec, ctx: ActContext = {}): boolean | Promise<boolean> {
  switch (act.kind) {
    case 'fill':
      return announce(act, performFill(act.target, act.text ?? ''));
    case 'open_terminal':
      return runOpenTerminal(act, ctx);
    case 'run':
      return runShellCommand(act, ctx);
    case 'fs_check':
      return runFsCheck(act);
    case 'git_check':
      return runGitCheck(act);
    default:
      return runSetupAct(act);
  }
}
