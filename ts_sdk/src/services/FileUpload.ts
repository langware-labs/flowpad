import { FSEntry } from '../fs/FSEntry';

/**
 * FileUpload - Represents an ongoing file upload with progress tracking
 */
export class FileUpload {
  private _fsItem: FSEntry;
  private _progress: number = 0;
  private _completed: boolean = false;
  private _error: Error | null = null;
  private _completionPromise: Promise<FSEntry>;
  private _completionResolve!: (value: FSEntry) => void;
  private _completionReject!: (error: Error) => void;
  private _progressCallbacks: Set<(progress: number) => void> = new Set();
  private _completeCallbacks: Set<(fsItem: FSEntry) => void> = new Set();
  private _errorCallbacks: Set<(error: Error) => void> = new Set();

  constructor(fsItem: FSEntry) {
    this._fsItem = fsItem;

    // Create completion promise
    this._completionPromise = new Promise<FSEntry>((resolve, reject) => {
      this._completionResolve = resolve;
      this._completionReject = reject;
    });
  }

  /**
   * Get the FSEntry being uploaded
   */
  get fsItem(): FSEntry {
    return this._fsItem;
  }

  /**
   * Get current upload progress (0-100)
   */
  get progress(): number {
    return this._progress;
  }

  /**
   * Check if upload is completed
   */
  get completed(): boolean {
    return this._completed;
  }

  /**
   * Get error if upload failed
   */
  get error(): Error | null {
    return this._error;
  }

  /**
   * Get filename
   */
  get filename(): string {
    return this._fsItem.name;
  }

  /**
   * Listen for progress updates
   * @param callback - Called with progress percentage (0-100)
   * @returns Unsubscribe function
   */
  onProgress(callback: (progress: number) => void): () => void {
    this._progressCallbacks.add(callback);
    return () => this._progressCallbacks.delete(callback);
  }

  /**
   * Listen for completion
   * @param callback - Called when upload completes successfully
   * @returns Unsubscribe function
   */
  onComplete(callback: (fsItem: FSEntry) => void): () => void {
    this._completeCallbacks.add(callback);
    // If already completed, call immediately
    if (this._completed && !this._error) {
      callback(this._fsItem);
    }
    return () => this._completeCallbacks.delete(callback);
  }

  /**
   * Listen for errors
   * @param callback - Called if upload fails
   * @returns Unsubscribe function
   */
  onError(callback: (error: Error) => void): () => void {
    this._errorCallbacks.add(callback);
    // If already errored, call immediately
    if (this._error) {
      callback(this._error);
    }
    return () => this._errorCallbacks.delete(callback);
  }

  /**
   * Wait for upload to complete
   * @returns Promise that resolves with FSEntry when upload completes
   * @throws Error if upload fails
   */
  async waitForCompletion(): Promise<FSEntry> {
    const fsItem = await this._completionPromise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return fsItem;
  }

  /**
   * Internal: Update progress
   */
  _updateProgress(progress: number): void {
    this._progress = progress;

    // Notify progress listeners
    this._progressCallbacks.forEach((callback) => callback(progress));

    // Check if completed
    if (progress >= 100 && !this._completed) {
      this._completed = true;
      this._completeCallbacks.forEach((callback) => callback(this._fsItem));
      this._completionResolve(this._fsItem);
    }
  }

  /**
   * Internal: Set error
   */
  _setError(error: Error): void {
    if (this._completed) return;

    this._error = error;
    this._completed = true;
    this._errorCallbacks.forEach((callback) => callback(error));
    this._completionReject(error);
  }

  /**
   * Cancel upload (if possible)
   */
  cancel(): void {
    if (!this._completed) {
      this._setError(new Error('Upload cancelled'));
    }
  }
}
