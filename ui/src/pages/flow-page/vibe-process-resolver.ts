import { lastChatQuery } from '@sdk';
import { mostRecentProcess } from '@src/utils/process-recency';

/** The latest real Chat opened in this project — the SDK's rule (`lastChatQuery`), shared with served pages. */
export const lastVibeChatQuery = lastChatQuery;

export const pickLastVibeChat = mostRecentProcess;
