export interface OAuthWindow {
  open(url: string): void;
  close(): void;
  get isOpen(): boolean;
}

export class BrowserAuthWindow implements OAuthWindow {
  private _window: Window | null = null;
  private _openedExternal: boolean = false;

  open(url: string) {
    // Electron: open in system default browser for better UX
    // (user's browser profile has saved passwords/sessions)

    const electronAPI = (window as any).electronAPI;
    if (electronAPI?.openExternal) {
      electronAPI.openExternal(url);
      this._openedExternal = true;
      return;
    }

    // Fallback: open popup window
    const width = 500;
    const height = window.screen.height;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = 0;

    this._window = window.open(url, 'oauth-popup', `popup,width=${width},height=${height},left=${left},top=${top}`);

    if (!this._window) {
      console.error(`[BrowserAuthWindow] Failed to open popup window`);
      return null;
    }
  }

  close(): void {
    if (this._window) {
      this._window.close();
      this._window = null;
    }
    this._openedExternal = false;
  }

  get isOpen(): boolean {
    // When opened in external browser, we can't track if it's still open
    // Return true to indicate auth flow is in progress
    if (this._openedExternal) {
      return true;
    }
    return this._window !== null && !this._window.closed;
  }
}
export class MockAuthWindow implements OAuthWindow {
  private _isOpen: boolean = false;

  open(url: string) {
    console.log('MockAuthWindow open called with:', url);
    this._isOpen = true;
  }

  close(): void {
    console.log('MockAuthWindow closed');
    this._isOpen = false;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }
}
