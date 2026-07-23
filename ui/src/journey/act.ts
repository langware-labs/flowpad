import { Capability, capabilityManager, dataContext, EventBus, GitWorkdir, oauthService } from '@sdk';

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
      await capabilityManager.install(act.capability);
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

/** The repo a `git_check` act inspects: the current project's working tree
 *  (the same base the footer git pill uses), plus the act's `dir` subfolder. */
function gitCheckWorkdir(dir: string | undefined): string | null {
  const base = dataContext.project?.fs_storage_mount_path ?? dataContext.workdir;
  if (!base) return null;
  return dir ? `${base.replace(/\/+$/, '')}/${dir.replace(/^\/+/, '')}` : base;
}

/**
 * Verify the working tree against REAL git state — the step is done only when
 * the repo says so (event ≠ proof: the user's terminal commands are invisible
 * to the bus; the repo is the truth). All probes go through the compute node's
 * `git-ops` action, the same backend the footer git pill reads.
 */
async function runGitCheck(act: JourneyActSpec): Promise<boolean> {
  try {
    const workdir = gitCheckWorkdir(act.dir);
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

/** Run a step's act and announce the outcome on the bus. */
export function runAct(act: JourneyActSpec): boolean | Promise<boolean> {
  if (act.kind === 'fill') {
    return announce(act, performFill(act.target, act.text ?? ''));
  }
  if (act.kind === 'git_check') {
    return runGitCheck(act);
  }
  return runSetupAct(act);
}
