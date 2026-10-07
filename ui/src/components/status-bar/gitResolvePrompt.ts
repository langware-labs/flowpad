/** Which one-click action left the rebase conflict in place. */
export type GitResolveOrigin = 'push' | 'pull';

/**
 * Prompt seeded into the agentic process launched by the "Resolve" action on a
 * failed push or pull — both leave a ``pull --rebase`` conflict in place. Scoped from the user's spec plus published best practice for
 * AI-assisted conflict resolution: give per-side context, only auto-resolve
 * low-stakes/clear conflicts, flag (don't guess) anything critical, never
 * force-push.
 */
export function gitResolvePrompt(branch: string, origin: GitResolveOrigin = 'push'): string {
  const b = branch || 'the current branch';
  const context =
    origin === 'pull'
      ? 'a one-click pull (pull --rebase --autostash) hit a conflict — either during the rebase, or when git re-applied the uncommitted work it had stashed first.'
      : 'a one-click push (commit-all → pull --rebase → push) hit a conflict during the rebase.';
  const finish =
    origin === 'pull'
      ? `if a rebase is in progress, \`git add -A\` then \`git rebase --continue\` (repeat until it completes). If no rebase is in progress, only re-applying the stashed work conflicted: leave those files resolved but uncommitted (\`git restore --staged\` anything you staged), then \`git stash drop\` the autostash. Do NOT push — the user only asked to pull. Report "pulled".`
      : `\`git add -A\`, then \`git rebase --continue\` (repeat until the rebase completes), then \`git push origin ${b}\`, and report "pushed".`;
  return `Resolve the in-progress git conflict on branch "${b}" in this project.

Context: ${context} Finish it SAFELY — do not resolve everything at any cost. "ours" = the user's local work; "theirs" = what is already on the remote branch.

1. Run \`git status\` and inspect every conflicted file and BOTH sides of each conflict.
2. ONLY auto-resolve when the correct resolution is UNAMBIGUOUS, e.g.: non-overlapping additions on each side (keep both); pure formatting / whitespace / import-order differences (keep the functional content); one side clearly supersedes the other by content or recency — a strictly newer value, or a regenerated lockfile / generated file (take the superseding side).
3. DO NOT guess on anything semantically ambiguous or high-stakes. Leave it unresolved and flag conflicts involving: overlapping logic changes on both sides, schema/DB migrations, security/auth/config/secrets, dependency downgrades, or delete-vs-edit. For each, briefly explain in plain language what conflicts and why you didn't auto-resolve it.
4. If — and only if — no files remain conflicted and nothing critical was flagged: ${finish}
5. If ANY conflict is critical/ambiguous: STOP — do not continue the rebase or push — and give the user a short plain-language summary of exactly what needs their decision. Never force-push. Keep edits minimal; never invent code beyond merging the two sides.`;
}
