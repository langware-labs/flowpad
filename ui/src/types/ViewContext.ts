import { CodeRef, ViewType } from '@sdk';

/**
 * ViewContext describes what content to view and how to view it
 */
export interface ViewContext {
  /**
   * Entity to view (e.g., Artifact, Task, etc.)
   * Using any for now to avoid circular dependency issues
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entity?: any;

  /**
   * Code reference to view (file, folder, glob, or external reference)
   */
  codeRef?: CodeRef;

  /**
   * Explicitly requested viewer type (overrides auto-detection)
   */
  viewerType?: ViewType;

  /**
   * Viewer-specific options (e.g., lineNumber for code editor, host/cacheKey for web app)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewerOptions?: Record<string, any>;

  /**
   * Error state - when set, UnsupportedContentViewer will be shown
   */
  viewerError?: {
    message: string;
    recoverable?: boolean;
  };
}
