import { EventBus } from '@sdk';

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

/** Run a step's act and announce the outcome on the bus. */
export function runAct(act: { kind: string; target: string; text?: string }): boolean {
  const ok = act.kind === 'fill' ? performFill(act.target, act.text ?? '') : false;
  EventBus.emit(
    ok ? ACT_DONE_TOPIC : ACT_FAILED_TOPIC,
    actTarget(act.kind, act.target),
    { act },
    { origin: 'app' },
  );
  return ok;
}
