import { EventEmitter } from 'events';
import { dataContext } from '../FlowSync/context';
import { fsManager } from './fsService';
import { TerminalType } from './shell/builtInShells';
import {
  PrefKey,
  PREF_REGISTRY,
  LEGACY_KEY_MAP,
  coercePrefValue,
  defaultPreferences,
} from '../preferences/prefRegistry';

/**
 * Per-instance UI preferences, persisted to `<instance_dir>/preferences.json`.
 * Distinct from the backend `BaseInstanceSettings` dataclass: that holds process
 * config (ports, paths, db driver); this holds user-editable UI prefs.
 *
 * Storage shape is a flat object keyed by the dotted {@link PrefKey}
 * (`preferences.<category>.<name>`). The registry ({@link PREF_REGISTRY}) is the
 * single source of truth for which prefs exist, their defaults, and their dataType.
 * The typed getters/setters below are a back-compat facade for non-settings
 * consumers (terminal, notification sound) — they delegate to {@link get}/{@link set}.
 */

export enum InstancePreferencesEvent {
  PREFERENCES_CHANGED = 'preferences_changed',
  PREFERENCES_LOADED = 'preferences_loaded',
}

const DEBOUNCE_MS = 500;

/**
 * Per-instance UI preferences with auto-save and EventEmitter pattern.
 * File: `<instance_dir>/preferences.json`. Changes are debounced.
 */
export class InstancePreferences extends EventEmitter {
  private _prefs: Record<string, unknown> = defaultPreferences();
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

  // ===== Generic registry-keyed API =====

  /** Current value for a topic, falling back to the registry default. */
  get(key: PrefKey): unknown {
    return key in this._prefs ? this._prefs[key] : PREF_REGISTRY[key]?.defaultValue;
  }

  /**
   * Set a topic's value (coerced to its registered dataType). No-op when the
   * value is unchanged. Bumps the version and schedules a debounced save.
   */
  set(key: PrefKey, value: unknown): void {
    const info = PREF_REGISTRY[key];
    const next = info ? coercePrefValue(info.dataType, value) : value;
    if (this._equals(this._prefs[key], next)) return;
    this._prefs[key] = next;
    this._handleUpdate();
  }

  private _equals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    // Structural compare for JSON-shaped values so a deep-equal object/array
    // doesn't trigger a redundant write.
    if (a != null && b != null && typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }

  // ===== Back-compat typed facade (delegates to get/set) =====

  get showSystemSkills(): boolean {
    return this.get(PrefKey.SHOW_SYSTEM_SKILLS) as boolean;
  }
  set showSystemSkills(value: boolean) {
    this.set(PrefKey.SHOW_SYSTEM_SKILLS, value);
  }

  get defaultTerminal(): TerminalType {
    return this.get(PrefKey.DEFAULT_TERMINAL) as TerminalType;
  }
  set defaultTerminal(value: TerminalType) {
    this.set(PrefKey.DEFAULT_TERMINAL, value);
  }

  /**
   * Buffer PTY writes between DEC 2026 BSU/ESU markers to prevent visible scroll
   * jumps during Claude Code's TUI redraws.
   */
  get bufferSyncUpdates(): boolean {
    return this.get(PrefKey.BUFFER_SYNC_UPDATES) as boolean;
  }
  set bufferSyncUpdates(value: boolean) {
    this.set(PrefKey.BUFFER_SYNC_UPDATES, value);
  }

  get notificationSoundEnabled(): boolean {
    return this.get(PrefKey.SOUND_ENABLED) as boolean;
  }
  set notificationSoundEnabled(value: boolean) {
    this.set(PrefKey.SOUND_ENABLED, value);
  }

  get notificationSoundKey(): string {
    return this.get(PrefKey.SOUND_KEY) as string;
  }
  set notificationSoundKey(value: string) {
    this.set(PrefKey.SOUND_KEY, value);
  }

  /** Snapshot of the full dotted-key preferences map. */
  get preferences(): Readonly<Record<string, unknown>> {
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
        const parsed = JSON.parse(content) as Record<string, unknown>;
        this._prefs = this._migrate(parsed);
      }
    } catch (error) {
      console.warn('[InstancePreferences] Load failed, using defaults:', error);
      this._prefs = defaultPreferences();
    }

    this._loaded = true;
    this._version++;
    this.emit(InstancePreferencesEvent.PREFERENCES_LOADED, this._prefs);
  }

  /**
   * Merge a parsed preferences.json over registry defaults, re-keying any legacy
   * flat keys (`show_system_skills`, …) to their dotted PrefKey. Unknown keys are
   * dropped; known values are coerced to their registered dataType.
   */
  private _migrate(parsed: Record<string, unknown>): Record<string, unknown> {
    const out = defaultPreferences();
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
      const key = (LEGACY_KEY_MAP[rawKey] ?? rawKey) as PrefKey;
      const info = PREF_REGISTRY[key];
      if (!info) continue; // drop unknown / retired keys
      out[key] = coercePrefValue(info.dataType, rawValue);
    }
    return out;
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
   * Trailing debounce: every call resets the timer to DEBOUNCE_MS in the future.
   * Sustained editing ends with exactly one save, fired DEBOUNCE_MS after the
   * *last* mutation — not after the first.
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
      // A save is already running. Re-arm so we save the latest state *after* the
      // in-flight write completes, avoiding overlapping writes that could land
      // out of order.
      this._scheduleFlush();
      return;
    }

    const typeId = this.computeNodeTypeId;
    const path = this.preferencesPath;
    if (!typeId || !path) {
      console.warn('[InstancePreferences] Cannot save: no compute node or preferences path');
      // Keep _dirty=true so the next mutation (or a later flush once the context
      // is ready) retries. Don't silently lose pending writes.
      return;
    }

    // Snapshot before await so concurrent mutations during the write don't bleed
    // into the bytes we're persisting. Optimistically clear _dirty; any mutation
    // during the write will re-set it via _handleUpdate.
    const snapshot: Record<string, unknown> = { ...this._prefs };
    this._dirty = false;
    this._savingInFlight = true;
    try {
      const content = JSON.stringify(snapshot, null, 2);
      await fsManager.writeFile(typeId, path, content);
      this.emit(InstancePreferencesEvent.PREFERENCES_CHANGED, snapshot);
    } catch (error) {
      // Save failed — preserve the dirty state so the next mutation (or an
      // explicit saveJson() call) retries. Don't auto-retry on a timer: that
      // risks tight loops against a persistently-failing endpoint.
      this._dirty = true;
      console.error('[InstancePreferences] Save failed, prefs remain dirty:', error);
    } finally {
      this._savingInFlight = false;
    }
  }

}

export const instancePreferences = new InstancePreferences();
