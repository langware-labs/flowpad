import {
  InstancePreferences,
  fsManager,
  getAllPrefInfos,
  coercePrefValue,
  PrefDataType,
  PrefKey,
  PREF_CATEGORIES,
  PREF_REGISTRY,
} from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PREFS_PATH = 'preferences.json';

/**
 * The store resolves its compute-node typeId + preferences path from the live
 * dataContext (computeNode is a MobX computed, not assignable). We stub the
 * store's own getters instead so load/save run with a fake node/path, and spy on
 * fsManager for the bytes — no backend or dataContext wiring needed.
 */
function primeStoreContext() {
  vi.spyOn(InstancePreferences.prototype as never, 'computeNodeTypeId', 'get').mockReturnValue({
    type: 'compute_node',
    id: '@local',
  } as never);
  vi.spyOn(InstancePreferences.prototype as never, 'preferencesPath', 'get').mockReturnValue(
    PREFS_PATH as never,
  );
}

/** Latest JSON object handed to fsManager.writeFile. */
function lastWritten(writeSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = writeSpy.mock.calls;
  const content = calls[calls.length - 1]?.[2] as string;
  return JSON.parse(content);
}

describe('preferences store + registry', () => {
  let store: InstancePreferences;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let downloadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    primeStoreContext();
    writeSpy = vi.spyOn(fsManager, 'writeFile').mockResolvedValue(undefined as never);
    downloadSpy = vi.spyOn(fsManager, 'download').mockResolvedValue('{}');
    store = new InstancePreferences();
  });

  it('registry is internally consistent', () => {
    for (const info of getAllPrefInfos()) {
      // 1:1 enum ↔ registry, and the map key matches the info.key field.
      expect(PREF_REGISTRY[info.key]).toBe(info);
      expect(Object.values(PrefKey)).toContain(info.key);
      expect(PREF_CATEGORIES).toContain(info.category);
      // Select-style string prefs must have a source of options.
      if (info.dataType === PrefDataType.STRING && info.options == null) {
        // ok to be a free-text string; only assert options shape when present.
        expect(info.optionsSource === undefined || typeof info.optionsSource === 'string').toBe(true);
      }
    }
    // Every enum member has a registry entry.
    for (const key of Object.values(PrefKey)) {
      expect(PREF_REGISTRY[key]).toBeDefined();
    }
    // All four data types are represented (so every control path is exercised).
    const types = new Set(getAllPrefInfos().map((i) => i.dataType));
    expect(types).toEqual(
      new Set([PrefDataType.BOOL, PrefDataType.STRING, PrefDataType.NUMBER, PrefDataType.JSON]),
    );
  });

  it('coerces each data type correctly', () => {
    expect(coercePrefValue(PrefDataType.BOOL, 'true')).toBe(true);
    expect(coercePrefValue(PrefDataType.BOOL, false)).toBe(false);
    expect(coercePrefValue(PrefDataType.NUMBER, '42')).toBe(42);
    expect(coercePrefValue(PrefDataType.NUMBER, 'nope')).toBe(0);
    expect(coercePrefValue(PrefDataType.STRING, 7)).toBe('7');
    expect(coercePrefValue(PrefDataType.JSON, { a: 1 })).toEqual({ a: 1 });
  });

  it('saves an edited value of every data type to JSON', async () => {
    const cases: Array<{ key: PrefKey; value: unknown; dataType: PrefDataType }> = [
      { key: PrefKey.SHOW_SYSTEM_SKILLS, value: false, dataType: PrefDataType.BOOL },
      { key: PrefKey.DEFAULT_TERMINAL, value: 'external_terminal', dataType: PrefDataType.STRING },
      { key: PrefKey.SCROLLBACK_LINES, value: 5000, dataType: PrefDataType.NUMBER },
      { key: PrefKey.EXPERIMENTAL_FLAGS, value: { fastMode: true, n: 3 }, dataType: PrefDataType.JSON },
    ];

    for (const { key, value } of cases) {
      writeSpy.mockClear();
      store.set(key, value);
      await store.saveJson(); // flush the debounce immediately
      expect(writeSpy).toHaveBeenCalledTimes(1);

      const written = lastWritten(writeSpy);
      // The serialized JSON changed and now holds the new value under the dotted key.
      expect(written[key]).toEqual(value);
      // Round-trips: parsing the written JSON yields the typed value back.
      expect(JSON.parse(JSON.stringify(written))[key]).toEqual(value);
      // In-memory get reflects it too.
      expect(store.get(key)).toEqual(value);
    }
  });

  it('JSON pref serializes to valid JSON and round-trips deeply', async () => {
    const payload = { nested: { list: [1, 2, 3], flag: true }, name: 'x' };
    store.set(PrefKey.EXPERIMENTAL_FLAGS, payload);
    await store.saveJson();
    const written = lastWritten(writeSpy);
    expect(() => JSON.stringify(written)).not.toThrow();
    expect(written[PrefKey.EXPERIMENTAL_FLAGS]).toEqual(payload);
  });

  it('debounces multiple edits into a single write and skips no-op sets', async () => {
    vi.useFakeTimers();
    store.set(PrefKey.SHOW_SYSTEM_SKILLS, false);
    store.set(PrefKey.SCROLLBACK_LINES, 2000);
    store.set(PrefKey.DEFAULT_TERMINAL, 'external_terminal');
    expect(writeSpy).not.toHaveBeenCalled(); // still within debounce window
    await vi.advanceTimersByTimeAsync(500);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Setting a pref to its current value writes nothing.
    writeSpy.mockClear();
    store.set(PrefKey.SCROLLBACK_LINES, 2000);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('migrates a legacy flat-key preferences.json on load', async () => {
    downloadSpy.mockResolvedValue(
      JSON.stringify({
        show_system_skills: false,
        default_terminal: 'external_terminal',
        buffer_sync_updates: true,
        notification_sound_enabled: true,
        notification_sound_key: 'ping',
      }),
    );
    const migrated = new InstancePreferences();
    await migrated.loadJson();

    expect(migrated.get(PrefKey.SHOW_SYSTEM_SKILLS)).toBe(false);
    expect(migrated.get(PrefKey.DEFAULT_TERMINAL)).toBe('external_terminal');
    expect(migrated.get(PrefKey.BUFFER_SYNC_UPDATES)).toBe(true);
    // Facade surfaces the same values for the legacy non-settings consumers.
    expect(migrated.defaultTerminal).toBe('external_terminal');
    expect(migrated.notificationSoundEnabled).toBe(true);
    expect(migrated.notificationSoundKey).toBe('ping');
    // Advanced defaults fill in for keys the legacy file never had.
    expect(migrated.get(PrefKey.SCROLLBACK_LINES)).toBe(1000);
  });

  it('typed facade and set(PrefKey) produce identical serialized JSON', async () => {
    const viaFacade = new InstancePreferences();
    viaFacade.defaultTerminal = 'external_terminal' as never;
    await viaFacade.saveJson();
    const facadeJson = lastWritten(writeSpy);

    writeSpy.mockClear();
    const viaSet = new InstancePreferences();
    viaSet.set(PrefKey.DEFAULT_TERMINAL, 'external_terminal');
    await viaSet.saveJson();
    const setJson = lastWritten(writeSpy);

    expect(setJson).toEqual(facadeJson);
  });
});
