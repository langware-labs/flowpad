/**
 * The attachment type a host stamps on its reply to a prompt
 * (`prompt_completion-<id>`, minted by the backend's `_emit_prompt_completion`).
 *
 * It is a typed MARKER plus a header carrier, not something to open: the reply text
 * rides in the attachment's `prompt_preview`, and the entity row stays on the host —
 * a guest never receives one. So it must never become a chip, a Download-button
 * badge, or a "shared context" row: there is nothing behind it to resolve, and it
 * would render as a dead chip on every reply.
 */
export const REPLY_MARKER_TYPE = 'prompt_completion';
