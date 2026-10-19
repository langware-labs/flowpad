/**
 * Single source of truth for the "your records aren't indexed yet" copy.
 *
 * Every surface that prompts the user to build the index pulls its title /
 * description / action label from here, so improving the wording in one place
 * updates them all. Held as lazy `msg` descriptors — render them with `i18n._(...)`.
 */
import { msg } from '@lingui/core/macro';

export const INDEX_PROMPT_TITLE = msg`Make your records searchable`;

export const INDEX_PROMPT_DESCRIPTION = msg`Your records haven't been indexed yet. Building the index takes less than a minute and lets you find anything across all your notes, tasks, and sessions.`;

/** Primary call-to-action label for kicking off an index build. */
export const INDEX_BUILD_LABEL = msg`Build Index`;
