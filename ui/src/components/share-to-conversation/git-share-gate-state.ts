/**
 * The share gate's state machine, as a pure function of the backend preflight
 * `code`. Sharing files always travels over Git, so a folder that isn't ready
 * gets ONE actionable fix rather than a disabled control:
 *
 *   checking — the backend hasn't answered yet; no state is trustworthy
 *   ready    — clean + pushed: open the share
 *   setup    — no repo / no usable origin: run the git-setup wizard
 *   commit   — dirty / uncommitted / unpushed: commit AND push, then re-check
 *   blocked  — real, but not fixable by either button. Say so; don't offer a
 *              button that cannot work.
 *
 * Kept separate from the dialog so the mapping is data, not rendering.
 */
export type GitShareGateState = 'checking' | 'ready' | 'setup' | 'commit' | 'blocked';

/**
 * Every code the backend can return (`_REASONS` in
 * flow_sdk/app/actions/git_share_preflight_action.py) → the one thing the user
 * can do about it. One table, so adding a code is one line and the choice is
 * visible rather than spread across membership tests.
 *
 * `setup` = the repo/origin doesn't exist yet, so creating it fixes this.
 * `commit` = the content exists locally and just hasn't travelled.
 * `blocked` = real, but neither button resolves it:
 *   - `detached-head`   committing doesn't reattach a HEAD
 *   - `status-failure`  a status we couldn't read is not a state we may act on
 *   - `unresolved-folder` there's no local directory for the wizard to adopt
 *   - `not-file-backed` the type has no on-disk source at all — nothing to set up
 */
const CODE_STATES: Record<string, GitShareGateState> = {
  'not-in-repo': 'setup',
  'missing-remote': 'setup',
  'unsupported-origin': 'setup',
  dirty: 'commit',
  'no-commit': 'commit',
  unpushed: 'commit',
  'detached-head': 'blocked',
  'status-failure': 'blocked',
  'unresolved-folder': 'blocked',
  'not-file-backed': 'blocked',
};

/**
 * Map a `git_share_preflight` code to the gate's state. A null code is the
 * action's "available". Unknown codes fail closed to `blocked` — never infer a
 * remediation for a state we don't recognize.
 */
export function gitShareGateState(code: string | null | undefined): GitShareGateState {
  if (code == null) return 'ready';
  return CODE_STATES[code] ?? 'blocked';
}
