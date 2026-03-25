/**
 * Options for download operations
 */
export interface DownloadOptions {
  /** File encoding, default: 'utf-8' */
  encoding?: string;
  /** Return Blob instead of string */
  asBlob?: boolean;
  /** Offset for partial download */
  offset?: number;
  /** Size for partial download */
  size?: number;
}

/**
 * Options for upload operations
 */
export interface UploadOptions {
  /** Progress callback invoked during upload */
  onProgress?: (progress: number, filename: string) => void;
  /** File encoding, default: 'utf-8' */
  encoding?: string;
  /** Overwrite existing file, default: true */
  overwrite?: boolean;
  /** Auto-create parent directories, default: true */
  createDirectories?: boolean;
}
