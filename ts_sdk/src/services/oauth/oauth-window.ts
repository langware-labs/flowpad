export interface OAuthWindow {
  open(url: string): void;
  close(): void;
  get isOpen(): boolean;
  /**
   * Called when the USER closed the window, where that is reliably observable (a
   * window the app owns). Returns the unsubscribe. Optional: a web popup cannot
   * say — a COOP provider severs it, and it then reads closed mid-consent.
   */
  onClosed?(listener: () => void): () => void;
}

type ElectronAuthApi = {
  openAuthWindow?: (url: string) => Promise<number | null>;
  closeAuthWindow?: (id: number) => Promise<boolean>;
  onAuthWindowClosed?: (listener: (id: number) => void) => () => void;
  openExternal?: (url: string) => Promise<boolean>;
};

function electronApi(): ElectronAuthApi | undefined {
  return (window as unknown as { electronAPI?: ElectronAuthApi }).electronAPI;
}

// Shared reference so it survives across BrowserAuthWindow instances (e.g. logout → login)
let _sharedPopup: Window | null = null;

export class BrowserAuthWindow implements OAuthWindow {
  private _window: Window | null = null;
  private _openedExternal: boolean = false;
  // Electron: a consent window the app OWNS, so a confirmed grant can close it.
  private _ownedId: number | null = null;
  private _ownedOpen: boolean = false;
  private _offOwnedClosed: (() => void) | null = null;
  private _closedListeners = new Set<() => void>();

  open(url: string) {
    const electron = electronApi();

    if (electron?.openAuthWindow) {
      this._ownedOpen = true;
      this._offOwnedClosed =
        electron.onAuthWindowClosed?.((id) => {
          if (id !== this._ownedId) return;
          this._ownedOpen = false;
          this._releaseOwned();
          this._closedListeners.forEach((listener) => listener());
        }) ?? null;
      void electron.openAuthWindow(url).then((id) => {
        this._ownedId = id;
        if (id === null) this._ownedOpen = false;
      });
      return;
    }

    // An Electron shell that predates owned auth windows: the system browser,
    // which the app can neither observe nor close.
    if (electron?.openExternal) {
      void electron.openExternal(url);
      this._openedExternal = true;
      return;
    }

    // If a popup from a previous flow (e.g. logout page) is still open, blank it immediately
    // before navigating — otherwise the old content flashes while the new page loads.
    if (_sharedPopup && !_sharedPopup.closed) {
      try {
        _sharedPopup.document.body.innerHTML = '';
      } catch {
        // Cross-origin at this point — can't blank, just proceed
      }
      _sharedPopup.location.href = url;
      _sharedPopup.focus();
      this._window = _sharedPopup;
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
    _sharedPopup = this._window;
  }

  close(): void {
    if (this._ownedId !== null) {
      void electronApi()?.closeAuthWindow?.(this._ownedId);
      this._ownedId = null;
    }
    this._ownedOpen = false;
    this._releaseOwned();
    if (this._window) {
      this._window.close();
      this._window = null;
    }
    _sharedPopup = null;
    this._openedExternal = false;
  }

  get isOpen(): boolean {
    if (this._ownedOpen) {
      return true;
    }
    // When opened in external browser, we can't track if it's still open
    // Return true to indicate auth flow is in progress
    if (this._openedExternal) {
      return true;
    }
    return this._window !== null && !this._window.closed;
  }

  onClosed(listener: () => void): () => void {
    this._closedListeners.add(listener);
    return () => this._closedListeners.delete(listener);
  }

  private _releaseOwned(): void {
    this._offOwnedClosed?.();
    this._offOwnedClosed = null;
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
