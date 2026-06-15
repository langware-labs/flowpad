/**
 * Single source of truth for the "your records aren't indexed yet" copy.
 *
 * Every surface that prompts the user to build the index — the IndexNowModal
 * notification and the assets empty-state prompt — pulls its title/description/
 * action label from here, so improving the wording in one place updates them all.
 */
export const INDEX_PROMPT_TITLE = 'Make your records searchable';

export const INDEX_PROMPT_DESCRIPTION =
  "Your records haven't been indexed yet. Building the index takes less than a minute and " +
  'lets you find anything across all your notes, tasks, and sessions.';

/** Primary call-to-action label for kicking off an index build. */
export const INDEX_BUILD_LABEL = 'Build Index';
