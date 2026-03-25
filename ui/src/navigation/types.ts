/**
 * Options for tab navigation
 */
export interface TabOptions {
  pinned?: boolean;
  setActive?: boolean;
}

/**
 * Options for file navigation
 */
export interface FileOptions {
  line?: number;
  column?: number;
  openInNewTab?: boolean;
}
