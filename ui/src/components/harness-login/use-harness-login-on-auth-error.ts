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
 * Reporting the denial to the backend fixes the value everywhere it is read —
 * the backend records it on ``Capability.login_denied`` and broadcasts, and the
 * modal renders from that one row. The record is awaited before opening so the
 * modal's first paint already carries the refusal, rather than flashing the
 * stale "Signed in" it was summoned to contradict.
 *
 * Fires once per refused TURN, keyed on ``detailId`` — the transcript entry's
 * own uuid, which the backend sends beside the sentence. The status is
 * re-derived on every serialize, so the same entry arrives many times per turn
 * and must fire only once; the id is stable across those re-reads and different
 * for a genuinely new refusal, which is exactly the distinction needed.
 *
 * It used to key on the SENTENCE, and that was the bug. Every signed-out turn
 * writes the byte-identical "Not logged in · Please run /login", so after the
 * user dismissed the modal once, the next refused turn changed nothing React
 * could see: the effect's deps were unchanged and it never ran at all — no
 * modal, just the composer's small red "Error" chip, which is driven by
 * ``worker_status`` and is a different field. It could not self-heal either,
 * since the re-arm below needs a turn that SUCCEEDS, and none can while the
 * harness is signed out.
 *
 * The id goes in the dependency array as well as the latch. The latch alone is
 * not enough — with identical deps the effect is skipped before the latch is
 * ever reached.
 */
export function useHarnessLoginOnAuthError(
  detail: string | null | undefined,
  workerType?: string | null,
  detailId?: string | null,
): void {
  const lastFired = useRef<string | null>(null);

  useEffect(() => {
    const text = detail?.trim() ?? '';
    if (!isSignedOut(text)) {
      // Cleared or unrelated — re-arm so a later sign-out pops again.
      lastFired.current = null;
      return;
    }
    // Fall back to the sentence when the backend sent no id: that is the old
    // fire-once-per-message behaviour, which is still better than firing on
    // every poll.
    const turnKey = detailId ?? text;
    if (lastFired.current === turnKey) return;
    lastFired.current = turnKey;
    const kind = harnessKindForWorkerType(workerType);
    void (async () => {
      if (kind) await recordSignedOut(kind, text).catch(() => undefined);
      openHarnessLoginModal();
    })();
  }, [detail, workerType, detailId]);
}
