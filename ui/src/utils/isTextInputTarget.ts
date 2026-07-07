/**
 * True when the target is a text-entry surface (input/textarea/select or
 * contentEditable) — the standard "is the user typing here?" predicate for
 * hotkey suppression and focus-steal guards.
 */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}
