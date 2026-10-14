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

/**
 * A call on a message and its answer (backend `process_call_spec`): `process_call-<call_id>` carries
 * the call, `returned_value-<call_id>` its outcome, each as JSON in `prompt_preview`. Neither has an
 * entity behind it on any machine — the call card renders them, never a chip.
 */
export const CALL_MARKER_TYPE = 'process_call';
export const ANSWER_MARKER_TYPE = 'returned_value';
