/**
 * A `shell` display target is an ADDRESS, not something the display renders.
 *
 * Every other `flow show` kind resolves to content the display pane mounts
 * (an editor, an iframe, a preview). A terminal is different: it is HOSTED as
 * a tab — opening its dock inside a mounted vibe workspace adopts it as a
 * child (`isAdoptableChildDock`), which puts it in the display pane with a
 * chip in the child strip and a real close/lifecycle story.
 *
 * That is deliberately the SAME mechanism a guided journey's `open_terminal`
 * act uses, so there is one way a terminal reaches the workspace no matter who
 * asked for it. Consequently a shell target must never be pinned as `shown`:
 * pinning it would fight the tab for the pane, and re-pinning on every reload
 * would yank the user back to the terminal.
 */
export interface ShowTargetLike {
  kind?: string;
  type?: string;
  id?: string;
}

/** The Shell id a show target addresses, or null if it addresses anything else. */
export function shellIdFromShowTarget(target: ShowTargetLike | null | undefined): string | null {
  if (!target || target.kind !== 'shell') return null;
  return target.id?.trim() || null;
}
