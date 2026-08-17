/**
 * Navigation error types for dock-based URL routing
 */
export enum NavigationErrorType {
  UNKNOWN_VIEW = 'UNKNOWN_VIEW',
  /** A pointer reached a parser in a form that parser cannot own — e.g. a
   *  project pointer still carrying its workspace host segments. */
  INVALID_POINTER = 'INVALID_POINTER',
}

/**
 * Navigation error class for structured error handling
 */
export class NavigationError extends Error {
  constructor(
    public readonly type: NavigationErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'NavigationError';
  }
}
