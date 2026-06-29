import { EventEmitter } from 'events';
import { dataContext, ContextEventType } from '../FlowSync/context';
import { fsManager } from './fsService';
import { TerminalType } from './shell/builtInShells';
import {
  PrefKey,
  PREF_REGISTRY,
  LEGACY_KEY_MAP,
  coercePrefValue,
  defaultPreferences,
  getAllPrefInfos,
  getBootPrefInfos,
  storageKeyFor,
  parseStoredValue,
  serializeStoredValue,
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
  // `_savingInFlight` guards against concurrent writes (out-of-order risk).
  private _savingInFlight = false;
  private _version = 0;
  // Dotted keys this session has actually changed since the last flush. The save
  // writes ONLY these over the current on-disk file, so keys another writer owns
  // (the backend's onboarding gate; another browser tab) are never clobbered by a
  // stale in-memory snapshot. It also IS the dirty flag — pending changes ⇔ non-empty.
  private _changedKeys = new Set<string>();

  /** Are there in-memory changes not yet flushed to disk? */
  private get _dirty(): boolean {
    return this._changedKeys.size > 0;
  }

  constructor() {
    super();
    // Boot keys (locale, viewMode, …) are read at module load before the backend
    // is reachable; seed them synchronously from localStorage so get() returns the
    // user's last value immediately and first paint isn't a flash-to-default.
    this._seedBootFromLocalStorage();
    // Self-load once the compute node + desktop paths land. usePreference consumers
    // may call loadJson() during first paint (before bootstrap wired the node) — that
    // early call is a retryable no-op; this reaction is the load that actually reads
    // preferences.json, so no caller has to know prefMan's load ordering.
    dataContext.on(ContextEventType.CONTEXT_CHANGED, () => {
      if (!this._loaded && this.computeNodeTypeId && this.preferencesPath) void this.loadJson();
    });
  }

  // ===== localStorage interop (private-mode / non-browser safe) =====

  private _localGet(key: string): string | null {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  private _localSet(key: string, value: string): void {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // private mode / quota — ignore, backend remains the source of truth.
    }
  }

  private _seedBootFromLocalStorage(): void {
    for (const info of getBootPrefInfos()) {
      const raw = this._localGet(storageKeyFor(info));
      if (raw == null) continue;
      const value = parseStoredValue(info, raw);
      if (value !== undefined) this._prefs[info.key] = value;
    }
  }

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
    this._changedKeys.add(key);
    // Boot keys write through to localStorage synchronously so the next module-load
    // read (before the backend loads) sees the latest value — no first-paint flash.
    if (info?.boot) this._localSet(storageKeyFor(info), serializeStoredValue(info, next));
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
      // Called before bootstrap wired up the compute node / preferences path (e.g. a
      // usePreference consumer mounted during first paint). Do NOT mark loaded — leave
      // it retryable so the post-bootstrap loadJson() (triggered in main.ts once the
      // compute node is set) actually reads preferences.json. get() keeps serving the
      // boot-seeded localStorage values meanwhile, so there's no flash.
      return;
    }

    try {
      const content = await fsManager.download(typeId, path);
      if (typeof content === 'string') {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        this._prefs = this._migrate(parsed);
        // One-time migration: adopt any pref the backend file didn't supply but the
        // user has under its legacy localStorage key. Backend always wins when set.
        this._adoptLegacyLocalStorage(this._backendProvidedKeys(parsed));
      }
    } catch (error) {
      console.warn('[InstancePreferences] Load failed, using defaults:', error);
      this._prefs = defaultPreferences();
    }

    // Mirror the canonical (post-reconcile) boot values back to localStorage so the
    // next module-load seed matches the backend, not a stale device value.
    for (const info of getBootPrefInfos()) {
      this._localSet(storageKeyFor(info), serializeStoredValue(info, this.get(info.key)));
    }

    this._loaded = true;
    this._version++;
    this.emit(InstancePreferencesEvent.PREFERENCES_LOADED, this._prefs);
    if (this._dirty) this._scheduleFlush(); // persist adopted legacy values up
  }

  /** Dotted PrefKeys the backend file actually supplied (after legacy re-keying). */
  private _backendProvidedKeys(parsed: Record<string, unknown>): Set<string> {
    const provided = new Set<string>();
    for (const rawKey of Object.keys(parsed)) {
      const key = LEGACY_KEY_MAP[rawKey] ?? rawKey;
      if (PREF_REGISTRY[key as PrefKey]) provided.add(key);
    }
    return provided;
  }

  /**
   * Adopt a user's existing localStorage value for any registry pref the backend
   * file didn't provide. Marks dirty so the adopted value persists up on the next
   * flush, making the migration permanent (after which the legacy key is ignored).
   */
  private _adoptLegacyLocalStorage(providedByBackend: Set<string>): void {
    for (const info of getAllPrefInfos()) {
      if (!info.legacyLocalStorageKey) continue; // only migratable prefs
      if (providedByBackend.has(info.key)) continue; // backend already owns it
      const raw = this._localGet(info.legacyLocalStorageKey);
      if (raw == null) continue;
      const value = parseStoredValue(info, raw);
      if (value === undefined) continue;
      this._prefs[info.key] = value;
      this._changedKeys.add(info.key); // persist the adopted value up on next flush (⇒ dirty)
    }
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
    // Caller (set) already added the key to _changedKeys ⇒ _dirty is true.
    // Announce the in-memory change immediately so every subscriber (not just the
    // component that called set) re-renders now — the backend save is debounced,
    // but reactivity must be synchronous (global prefs like locale/viewMode).
    this.emit(InstancePreferencesEvent.PREFERENCES_CHANGED, this._prefs);
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

    // Snapshot the keys+values we're about to persist before the await, then clear
    // the change set (⇒ not dirty). Concurrent mutations during the write re-add to
    // _changedKeys (⇒ dirty again) via _handleUpdate, so they flush next round.
    const changed = [...this._changedKeys];
    const values = new Map(changed.map((k) => [k, this._prefs[k]]));
    this._changedKeys.clear();
    this._savingInFlight = true;
    try {
      // Read-modify-write MERGE: start from the current on-disk file and overlay only
      // the keys we changed this session. This preserves keys owned by another writer
      // (the backend's onboarding gate, another browser tab) instead of clobbering
      // them with our possibly-stale snapshot.
      let disk: Record<string, unknown> = {};
      try {
        const current = await fsManager.download(typeId, path);
        if (typeof current === 'string') disk = JSON.parse(current) as Record<string, unknown>;
      } catch {
        // No file yet / unreadable — write a fresh object from our changes.
      }
      const merged = { ...disk };
      for (const k of changed) merged[k] = values.get(k);
      await fsManager.writeFile(typeId, path, JSON.stringify(merged, null, 2));
      // Note: PREFERENCES_CHANGED was already emitted synchronously in
      // _handleUpdate; the persisted state == the announced state, so no re-emit.
    } catch (error) {
      // Save failed — re-arm the keys (⇒ dirty again) so the next flush retries.
      // Don't auto-retry on a timer: that risks tight loops against a failing endpoint.
      for (const k of changed) this._changedKeys.add(k);
      console.error('[InstancePreferences] Save failed, prefs remain dirty:', error);
    } finally {
      this._savingInFlight = false;
    }
  }

}

export const instancePreferences = new InstancePreferences();

/**
 * Run `fn` whenever any preference changes (a set) OR the backend file finishes
 * loading — the two events a non-React consumer needs to keep a derived side-effect
 * (e.g. an `<html>` attribute) in sync. Returns an unsubscribe fn.
 */
export function onPreferenceChange(fn: () => void): () => void {
  instancePreferences.on(InstancePreferencesEvent.PREFERENCES_CHANGED, fn);
  instancePreferences.on(InstancePreferencesEvent.PREFERENCES_LOADED, fn);
  return () => {
    instancePreferences.off(InstancePreferencesEvent.PREFERENCES_CHANGED, fn);
    instancePreferences.off(InstancePreferencesEvent.PREFERENCES_LOADED, fn);
  };
}
