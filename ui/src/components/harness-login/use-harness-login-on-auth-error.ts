import { useEffect, useRef } from 'react';

import { openHarnessLoginModal } from './harness-login-store';

/**
 * Text the vendor CLIs write when the failure is "you are signed out", as
 * opposed to any other error. Claude Code says
 * ``"Not logged in · Please run /login"``; codex and copilot phrase their
 * signed-out state the same way.
 *
 * Matched on the CLI's own sentence rather than on a status code because the
 * status collapses every synthetic stop into one ``ERROR`` token — the sentence
 * is the only thing that distinguishes "sign in again" from "something broke".
 */
const SIGNED_OUT_PATTERNS = [/\bnot logged in\b/i, /\bplease run \/login\b/i, /\blogin required\b/i];

function isSignedOut(detail: string | null | undefined): boolean {
  const text = detail?.trim();
  return !!text && SIGNED_OUT_PATTERNS.some((re) => re.test(text));
}

/**
 * Pop the harness-login modal when a worker reports that it is signed out.
 *
 * Why this exists: when the harness is logged out, Claude Code answers with a
 * perfectly clear ``"Not logged in · Please run /login"`` — and Flowpad used to
 * render that as the single word "Error", which tells the user nothing and does
 * not tell them the one thing they can act on. The CLI has already said all it
 * can; getting the user signed back in is Flowpad's job, and the modal for it
 * already exists.
 *
 * Fires once per distinct message: the status is re-derived on every serialize,
 * so without the latch a signed-out process would re-open the modal on each
 * poll. A different message (or the same one after a successful turn clears it)
 * arms it again.
 */
export function useHarnessLoginOnAuthError(detail: string | null | undefined): void {
  const lastFired = useRef<string | null>(null);

  useEffect(() => {
    const text = detail?.trim() ?? '';
    if (!isSignedOut(text)) {
      // Cleared or unrelated — re-arm so a later sign-out pops again.
      lastFired.current = null;
      return;
    }
    if (lastFired.current === text) return;
    lastFired.current = text;
    openHarnessLoginModal();
  }, [detail]);
}
