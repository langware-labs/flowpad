/**
 * Prompt seeded into the agentic process launched by the "Resolve" action on a
 * failed push. Scoped from the user's spec plus published best practice for
 * AI-assisted conflict resolution: give per-side context, only auto-resolve
 * low-stakes/clear conflicts, flag (don't guess) anything critical, never
 * force-push.
 */
export function gitResolvePrompt(branch: string): string {
  const b = branch || 'the current branch';
  return `Resolve the in-progress git conflict on branch "${b}" in this project.

Context: a one-click push (commit-all → pull --rebase → push) hit a conflict during the rebase. Finish it SAFELY — do not resolve everything at any cost. "ours" = the user's local work; "theirs" = what is already on the remote branch.

1. Run \`git status\` and inspect every conflicted file and BOTH sides of each conflict.
2. ONLY auto-resolve when the correct resolution is UNAMBIGUOUS, e.g.: non-overlapping additions on each side (keep both); pure formatting / whitespace / import-order differences (keep the functional content); one side clearly supersedes the other by content or recency — a strictly newer value, or a regenerated lockfile / generated file (take the superseding side).
3. DO NOT guess on anything semantically ambiguous or high-stakes. Leave it unresolved and flag conflicts involving: overlapping logic changes on both sides, schema/DB migrations, security/auth/config/secrets, dependency downgrades, or delete-vs-edit. For each, briefly explain in plain language what conflicts and why you didn't auto-resolve it.
4. If — and only if — no files remain conflicted and nothing critical was flagged: \`git add -A\`, then \`git rebase --continue\` (repeat until the rebase completes), then \`git push origin ${b}\`, and report "pushed".
5. If ANY conflict is critical/ambiguous: STOP — do not continue the rebase or push — and give the user a short plain-language summary of exactly what needs their decision. Never force-push. Keep edits minimal; never invent code beyond merging the two sides.`;
}
