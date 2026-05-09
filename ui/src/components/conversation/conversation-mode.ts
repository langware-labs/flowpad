/** Approve & Execute backend used by `ConversationView` / `ConversationPanel`.
 *  - PTY: forks Claude Code into a visible terminal tab (legacy default).
 *  - HEADLESS: runs invisibly via task/<id>/run-headless; output lands as a
 *    draft reply that the user reviews before sending. */
export enum ConversationMode {
  PTY = 'pty',
  HEADLESS = 'headless',
}
