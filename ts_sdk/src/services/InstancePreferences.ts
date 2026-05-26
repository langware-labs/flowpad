import { EventEmitter } from 'events';
import { dataContext } from '../FlowSync/context';
import { fsManager } from './fsService';
import { TerminalType } from './shell/builtInShells';

/**
 * Per-instance UI preferences, persisted to
 * `<instance_dir>/preferences.json`. Distinct from the backend
 * `BaseInstanceSettings` dataclass: that holds process config (ports,
 * paths, db driver); this holds user-editable UI prefs.
 */
export interface InstancePreferencesData {
  show_system_skills: boolean;
  default_terminal: TerminalType;
  buffer_sync_updates: boolean;
  notification_sound_enabled: boolean;
  notification_sound_key: string;
}

export enum InstancePreferencesEvent {
  PREFERENCES_CHANGED = 'preferences_changed',
  PREFERENCES_LOADED = 'preferences_loaded',
}

const DEFAULT_PREFERENCES: InstancePreferencesData = {
  show_system_skills: true,
  default_terminal: TerminalType.BUILTIN_XTERM,
  buffer_sync_updates: false,
  notification_sound_enabled: true,
  notification_sound_key: 'supershort-ping',
};

const DEBOUNCE_MS = 500;

/**
 * Per-instance UI preferences with auto-save and EventEmitter pattern.
 * File: `<instance_dir>/preferences.json`. Changes are debounced.
 */
export class InstancePreferences extends EventEmitter {
  private _prefs: InstancePreferencesData = { ...DEFAULT_PREFERENCES };
  private _loaded = false;
  private _loadPromise: Promise<void> | null = null;
  private _saveTimeout: ReturnType<typeof setTimeout> | null = null;
  // Two-flag save state.
  // `_dirty` means there are in-memory changes not yet flushed to disk.
  // `_savingInFlight` guards against concurrent writes (out-of-order risk).
  private _dirty = false;
  private _savingInFlight = false;
  private _version = 0;

  get isLoaded(): boolean {
    return this._loaded;
  }

  /** Version counter for React useSyncExternalStore — bumps on every change. */
  get version(): number {
    return this._version;
  }

  get showSystemSkills(): boolean {
    return this._prefs.show_system_skills;
  }

  set showSystemSkills(value: boolean) {
    if (this._prefs.show_system_skills !== value) {
      this._prefs.show_system_skills = value;
      this._handleUpdate();
    }
  }

  get defaultTerminal(): TerminalType {
    return this._prefs.default_terminal;
  }

  set defaultTerminal(value: TerminalType) {
    if (this._prefs.default_terminal !== value) {
      this._prefs.default_terminal = value;
      this._handleUpdate();
    }
  }

  /**
   * Buffer PTY writes between DEC 2026 BSU/ESU markers to prevent
   * visible scroll jumps during Claude Code's TUI redraws.
   */
  get bufferSyncUpdates(): boolean {
    return this._prefs.buffer_sync_updates;
  }

  set bufferSyncUpdates(value: boolean) {
    if (this._prefs.buffer_sync_updates !== value) {
      this._prefs.buffer_sync_updates = value;
      this._handleUpdate();
    }
  }

  get notificationSoundEnabled(): boolean {
    return this._prefs.notification_sound_enabled;
  }

  set notificationSoundEnabled(value: boolean) {
    if (this._prefs.notification_sound_enabled !== value) {
      this._prefs.notification_sound_enabled = value;
      this._handleUpdate();
    }
  }

  get notificationSoundKey(): string {
    return this._prefs.notification_sound_key;
  }

  set notificationSoundKey(value: string) {
    if (this._prefs.notification_sound_key !== value) {
      this._prefs.notification_sound_key = value;
      this._handleUpdate();
    }
  }

  get preferences(): Readonly<InstancePreferencesData> {
    return { ...this._prefs };
  }

  private get preferencesPath(): string | null {
    return dataContext.bootstrapInfo?.desktop_info?.paths?.preferences ?? null;
  }

  private get computeNodeTypeId() {
    return dataContext.computeNode?.typeId ?? null;
  }

  /**
   * Load preferences from preferences.json. Concurrent callers share the same
   * in-flight request, and once loaded the result is reused.
   */
  loadJson(): Promise<void> {
    if (this._loaded) return Promise.resolve();
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoadJson().finally(() => {
      this._loadPromise = null;
    });
    return this._loadPromise;
  }

  private async _doLoadJson(): Promise<void> {
    const typeId = this.computeNodeTypeId;
    const path = this.preferencesPath;

    if (!typeId || !path) {
      console.warn('[InstancePreferences] Cannot load: no compute node or preferences path');
      this._loaded = true;
      this.emit(InstancePreferencesEvent.PREFERENCES_LOADED, this._prefs);
      return;
    }

    try {
      const content = await fsManager.download(typeId, path);
      if (typeof content === 'string') {
        const parsed = JSON.parse(content) as Partial<InstancePreferencesData>;
        this._prefs = { ...DEFAULT_PREFERENCES, ...parsed };
      }
    } catch (error) {
      console.warn('[InstancePreferences] Load failed, using defaults:', error);
      this._prefs = { ...DEFAULT_PREFERENCES };
    }

    this._loaded = true;
    this._version++;
    this.emit(InstancePreferencesEvent.PREFERENCES_LOADED, this._prefs);
  }

  /** Force-flush any pending debounced save and wait for it to land. */
  async saveJson(): Promise<void> {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    await this._flushSave();
  }

  private _handleUpdate(): void {
    this._version++;
    this._dirty = true;
    this._scheduleFlush();
  }

  /**
   * Trailing debounce: every call resets the timer to DEBOUNCE_MS in the
   * future. Sustained editing ends with exactly one save, fired
   * DEBOUNCE_MS after the *last* mutation — not after the first.
   */
  private _scheduleFlush(): void {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }
    this._saveTimeout = setTimeout(() => {
      this._saveTimeout = null;
      void this._flushSave();
    }, DEBOUNCE_MS);
  }

  private async _flushSave(): Promise<void> {
    if (!this._dirty) return;
    if (this._savingInFlight) {
      // A save is already running. Re-arm so we save the latest state
      // *after* the in-flight write completes, avoiding overlapping writes
      // that could land out of order.
      this._scheduleFlush();
      return;
    }

    const typeId = this.computeNodeTypeId;
    const path = this.preferencesPath;
    if (!typeId || !path) {
      console.warn('[InstancePreferences] Cannot save: no compute node or preferences path');
      // Keep _dirty=true so the next mutation (or a later flush once the
      // context is ready) retries. Don't silently lose pending writes.
      return;
    }

    // Snapshot before await so concurrent mutations during the write don't
    // bleed into the bytes we're persisting. Optimistically clear _dirty;
    // any mutation during the write will re-set it via _handleUpdate.
    const snapshot: InstancePreferencesData = { ...this._prefs };
    this._dirty = false;
    this._savingInFlight = true;
    try {
      const content = JSON.stringify(snapshot, null, 2);
      await fsManager.writeFile(typeId, path, content);
      this.emit(InstancePreferencesEvent.PREFERENCES_CHANGED, snapshot);
    } catch (error) {
      // Save failed — preserve the dirty state so the next mutation (or an
      // explicit saveJson() call) retries. Don't auto-retry on a timer:
      // that risks tight loops against a persistently-failing endpoint.
      this._dirty = true;
      console.error('[InstancePreferences] Save failed, prefs remain dirty:', error);
    } finally {
      this._savingInFlight = false;
    }
  }

  /**
   * Update multiple preferences at once. Triggers a single debounced save.
   *
   * Iterates the keys of `updates` rather than enumerating each field,
   * so adding a new field doesn't require touching this method.
   */
  update(updates: Partial<InstancePreferencesData>): void {
    let changed = false;
    for (const key of Object.keys(updates) as Array<keyof InstancePreferencesData>) {
      const value = updates[key];
      if (value === undefined) continue;
      if (this._prefs[key] === value) continue;
      Object.assign(this._prefs, { [key]: value });
      changed = true;
    }
    if (changed) {
      this._handleUpdate();
    }
  }

  reset(): void {
    this._prefs = { ...DEFAULT_PREFERENCES };
    this._handleUpdate();
  }
}

export const instancePreferences = new InstancePreferences();
