/**
 * Which screen draws a wizard run's questions.
 *
 * A question a ComputeOp asks is pushed to the active tab as a `navigate_dock` to `win/ask/<id>`,
 * which sends the whole tab to the question. That is right when nothing is showing the run — and
 * wrong when a setup screen IS showing it: the person would be sent away from the guide they are
 * following. So a screen showing a run claims it, and a question naming that run (`run`, stamped by
 * the backend) is handed to the claimer instead of navigating.
 *
 * Module state, not React context: the ui_command listener lives at the app root, far from any
 * screen, and needs one synchronous answer — "is anybody drawing this run?".
 */

export type AskClaimHandler = (questionId: string) => void;

const claims = new Map<string, AskClaimHandler>();

/** Draw `run`'s questions here. Returns the release; the latest claimer of a run wins. */
export function claimAskRun(run: string, handler: AskClaimHandler): () => void {
  claims.set(run, handler);
  return () => {
    if (claims.get(run) === handler) claims.delete(run);
  };
}

/** Hand a question to whoever claimed its run. False when nobody did (navigate as usual). */
export function deliverClaimedQuestion(run: string | undefined, questionId: string): boolean {
  const handler = run ? claims.get(run) : undefined;
  if (!handler) return false;
  handler(questionId);
  return true;
}

/**
 * The open question naming `run`, if one is waiting — one raised before a screen's claim landed, or whose
 * push missed the tab. Null when none (or the backend cannot be asked).
 */
export async function openQuestionOf(run: string): Promise<string | null> {
  const { default: apiClient } = await import('@sdk/client');
  const waiting = await apiClient.get<{ questions: { id: string; run?: string }[] }>('/api/v1/ask').catch(() => null);
  return waiting?.questions?.find((q) => q.run === run)?.id ?? null;
}
