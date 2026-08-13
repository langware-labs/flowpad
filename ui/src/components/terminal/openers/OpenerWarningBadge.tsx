/**
 * Small "!" sub-icon overlaid on a harness icon whose capability check failed.
 *
 * Shared by every surface that offers a harness and can render one as missing:
 * the terminal strip's inline openers, the "+" new-tab menu rows, and the chat
 * worker switcher. The caller supplies the `relative` positioning context (the
 * badge is absolutely positioned against it) — see `TerminalOpenerToolbar`'s
 * `<span className="relative inline-flex">` wrapper for the canonical shape.
 *
 * `id` only names the testid; it takes an `OpenerId` from the toolbars and a
 * `WorkerType` from the switcher, which is why it is a plain string.
 */
export function OpenerWarningBadge({ id }: { id: string }) {
  return (
    <span
      className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold leading-none text-black"
      data-testid={`opener-warning-${id}`}
      aria-hidden="true"
    >
      !
    </span>
  );
}
