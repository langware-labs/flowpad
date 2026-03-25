/**
 * Interface for backend history messages
 */
export interface HistoryMessage {
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
}

/**
 * Type for event unsubscriber functions - can be function or any return value from .on()
 */
export type EventUnsubscriber = (() => void) | (() => unknown);
