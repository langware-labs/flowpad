/**
 * Navigation error types for dock-based URL routing
 */
export enum NavigationErrorType {
  UNKNOWN_VIEW = 'UNKNOWN_VIEW',
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
