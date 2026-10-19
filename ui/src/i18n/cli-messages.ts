import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

/**
 * Display-time translation for the handful of sentences a vendor CLI writes
 * itself.
 *
 * Unlike everything else in `src/i18n/`, the source text here is NOT ours: it is
 * Claude Code's (or codex's / copilot's) own transcript content, captured
 * verbatim by `worker_status.tail_status_detail` and rendered as an assistant
 * message. We translate it anyway because the user cannot act on a sentence they
 * cannot read, and "Not logged in · Please run /login" is precisely the error
 * that asks them to do something.
 *
 * Two rules keep that honest:
 *
 *  - **Whitelist only.** A sentence is translated when it matches one of the
 *    patterns below, and left EXACTLY as the CLI wrote it otherwise. There is no
 *    fuzzy or partial rewriting — an unrecognized error reaches the user in the
 *    provider's own words, which is the safe failure.
 *  - **Commands stay literal.** `/login` is something the user types; it is not
 *    a word. It survives translation unchanged in every locale, so the sentence
 *    still names the exact thing to run.
 *
 * Anchored patterns (`^…$`) on the trimmed text, so this can only ever replace a
 * message that IS one of these sentences — never a longer answer that happens to
 * quote one.
 */
const CLI_MESSAGES: { match: RegExp; message: MessageDescriptor }[] = [
  {
    match: /^not logged in\s*(?:[·•.,-]\s*)?please run \/login\.?$/i,
    message: msg`Not logged in · Please run /login`,
  },
  { match: /^not logged in\.?$/i, message: msg`Not logged in` },
  { match: /^please run \/login\.?$/i, message: msg`Please run /login` },
  { match: /^login required\.?$/i, message: msg`Login required` },
];

/**
 * Translate a CLI-authored sentence, or return it untouched.
 *
 * Cheap enough to call per rendered message: a handful of anchored regexes
 * against one trimmed string, and the common case (ordinary assistant prose)
 * fails the first `^not logged in` test immediately.
 */
export function translateCliMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const hit = CLI_MESSAGES.find((entry) => entry.match.test(trimmed));
  return hit ? i18n._(hit.message) : text;
}
