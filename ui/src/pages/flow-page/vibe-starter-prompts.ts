import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

/**
 * The display's starter chips, shown when a vibe workspace has nothing in it yet.
 *
 * Lazy `msg` descriptors rather than plain strings, for the usual module-scope
 * reason: an eager `t` here would resolve once at import — before `initLocale`
 * activates the real catalog — and then never re-translate on a language switch.
 *
 * Note the chip's text IS the prompt: clicking one sends this exact string to
 * the agent. So translating is not merely cosmetic — in a Hebrew project the
 * instruction must go out in Hebrew, or the agent answers a Hebrew reader in
 * English. Resolve once per chip and use the SAME resolved string for the label,
 * the React key and the submitted prompt, so the three cannot drift apart.
 */
export const VIBE_STARTER_PROMPTS: MessageDescriptor[] = [
  msg`Build a landing page`,
  msg`Make a todo app`,
  msg`Create a dashboard`,
  msg`Design a pricing page`,
];
