import { Capability, capabilityManager, dataManager, harnessKindForWorkerType, TypeId } from '@sdk';
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
 * Tell the backend what the harness just said about itself, so the sign-out is
 * recorded rather than merely displayed.
 *
 * Best-effort and deliberately unawaited by the caller: the modal opens either
 * way. Failing to record leaves the old (wrong) state, which is exactly where
 * we were before — never worse.
 */
async function recordSignedOut(kind: string, message: string): Promise<void> {
  const id = capabilityManager.getSnapshot(kind).capability?.id;
  if (!id) return;
  const capability = await dataManager.getByTypeId<Capability>(new TypeId(Capability.type, id));
  await capability?.reportSignedOut(message);
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
 * The sentence is also EVIDENCE, not just a trigger, and that is the second
 * half of this hook. ``login_state`` is written by the last device login or
 * auth probe and nothing invalidates it when the user signs out elsewhere;
 * an auth probe that cannot reach a verdict (a 5s timeout, unparseable output)
 * deliberately leaves it alone. So the modal could open on this error and greet
 * the user with a green "Signed in" from a login that had since been revoked.
 * Reporting the denial to the backend fixes the value everywhere it is read,
 * and handing it to the modal makes that row honest even if the write fails.
 *
 * Fires once per distinct message: the status is re-derived on every serialize,
 * so without the latch a signed-out process would re-open the modal on each
 * poll. A different message (or the same one after a successful turn clears it)
 * arms it again.
 */
export function useHarnessLoginOnAuthError(detail: string | null | undefined, workerType?: string | null): void {
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
    const kind = harnessKindForWorkerType(workerType);
    if (kind) void recordSignedOut(kind, text).catch(() => undefined);
    openHarnessLoginModal(kind ? { kind, message: text } : undefined);
  }, [detail, workerType]);
}
