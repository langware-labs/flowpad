/**
 * `visibleWhen` — the conditional-visibility mechanism behind the Auto Index tab.
 *
 * Lives in the unit tier, not react: the rule is a pure comparison over the
 * registry plus a reader callback, so it needs no backend and no live instance.
 * The render half uses PrefControl through a thin harness rather than mounting
 * PreferencesView, which drags in useDockNavigation for no benefit here — the
 * filtering under test happens in the parent, so a harness that calls
 * `visiblePrefsForCategory` exercises exactly the production path.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_INDEX_FUNCTION_OPTIONS,
  AUTO_INDEX_TRIGGER_OPTIONS,
  AUTO_INDEX_TYPE_OPTIONS,
  CATEGORY_AUTO_INDEX,
  getAllPrefInfos,
  getSurfacedPrefInfos,
  isPrefVisible,
  PREF_CATEGORIES,
  PREF_REGISTRY,
  PrefDataType,
  PrefKey,
  prefsForCategory,
  visiblePrefsForCategory,
} from '@sdk';
import { SettingsCard } from '@src/components/settings/settings-card';
import { PrefControl } from '@src/components/preferences-view/PrefControl';

// The unit tier's setup does not install RTL's auto-cleanup (the react tier's
// does), so renders would otherwise accumulate and duplicate every label.
afterEach(cleanup);

/** A reader over an explicit map, mimicking instancePreferences.get. */
const reader = (values: Partial<Record<PrefKey, unknown>>) => (key: PrefKey) =>
  key in values ? values[key] : PREF_REGISTRY[key]?.defaultValue;

describe('visibleWhen registry invariants', () => {
  it('every rule points at a usable controller', () => {
    for (const info of getAllPrefInfos()) {
      const rule = info.visibleWhen;
      if (!rule) continue;
      const ctrl = PREF_REGISTRY[rule.key];
      expect(ctrl, `${info.key} controller must exist`).toBeDefined();
      // Not self — a self-referential rule can never resolve.
      expect(rule.key).not.toBe(info.key);
      // One level only: a controller with its own rule could form a cycle and
      // would need recursive evaluation.
      expect(ctrl.visibleWhen, `${rule.key} must not itself be conditional`).toBeUndefined();
      // An unsurfaced or off-tab controller would be unreachable for the user,
      // leaving the dependent row permanently hidden with no way to reveal it.
      expect(ctrl.surfaced, `${rule.key} must be surfaced`).toBe(true);
      expect(ctrl.category, `${rule.key} must share the dependent's tab`).toBe(info.category);
      // JSON prefs would need a structural compare; scalars keep it ===.
      expect(ctrl.dataType).not.toBe(PrefDataType.JSON);

      // The compared value must be one the controller can actually hold, or the
      // dependent row is unreachable.
      const v = rule.equals;
      if (ctrl.dataType === PrefDataType.BOOL) expect(typeof v).toBe('boolean');
      if (ctrl.dataType === PrefDataType.NUMBER) expect(typeof v).toBe('number');
      if (ctrl.dataType === PrefDataType.STRING) expect(typeof v).toBe('string');
      if (ctrl.options) expect(ctrl.options.map((o) => o.value)).toContain(v);
    }
  });

  it("every surfaced enum's default is one of its own options", () => {
    // Nothing validates stored preference values, so a default outside its option
    // list renders as an empty Select and ships a value the backend must reject.
    for (const info of getSurfacedPrefInfos()) {
      if (!info.options) continue;
      expect(
        info.options.map((o) => o.value),
        `${info.key} default must be selectable`,
      ).toContain(info.defaultValue);
    }
  });

  it('isPrefVisible gates a dependent pref on its controller', () => {
    const dep = PREF_REGISTRY[PrefKey.AUTO_INDEX_TYPE];
    expect(isPrefVisible(dep, () => true)).toBe(true);
    expect(isPrefVisible(dep, () => false)).toBe(false);
    // An unconditional pref is visible regardless of what the reader says.
    expect(isPrefVisible(PREF_REGISTRY[PrefKey.SHOW_SYSTEM_SKILLS], () => false)).toBe(true);
  });
});

describe('the Auto Index section', () => {
  it('is one tab holding the four auto-index prefs in order', () => {
    expect(PREF_CATEGORIES).toContain(CATEGORY_AUTO_INDEX);
    expect(prefsForCategory(CATEGORY_AUTO_INDEX).map((i) => i.key)).toEqual([
      PrefKey.AUTO_INDEX_ENABLED,
      PrefKey.AUTO_INDEX_TYPE,
      PrefKey.AUTO_INDEX_TRIGGER,
      PrefKey.AUTO_INDEX_FUNCTION,
    ]);
  });

  it('ships the defaults the backend also hard-codes', () => {
    expect(PREF_REGISTRY[PrefKey.AUTO_INDEX_ENABLED].defaultValue).toBe(true);
    expect(PREF_REGISTRY[PrefKey.AUTO_INDEX_TYPE].defaultValue).toBe('fast');
    expect(PREF_REGISTRY[PrefKey.AUTO_INDEX_TRIGGER].defaultValue).toBe('first_selection');
    expect(PREF_REGISTRY[PrefKey.AUTO_INDEX_FUNCTION].defaultValue).toBe('subprocess');
  });

  it('uses the machine values the Python enums parse, not the display labels', () => {
    expect(AUTO_INDEX_TYPE_OPTIONS.map((o) => o.value)).toEqual(['fast', 'full']);
    expect(AUTO_INDEX_TRIGGER_OPTIONS.map((o) => o.value)).toEqual([
      'project_create',
      'first_selection',
      'every_selection',
    ]);
    expect(AUTO_INDEX_FUNCTION_OPTIONS.map((o) => o.value)).toEqual(['subprocess', 'thread']);
  });

});

describe('rendering the Auto Index rows', () => {
  const renderRows = (values: Partial<Record<PrefKey, unknown>>) =>
    render(
      <SettingsCard>
        {visiblePrefsForCategory(CATEGORY_AUTO_INDEX, reader(values)).map((info) => (
          <PrefControl key={info.key} info={info} />
        ))}
      </SettingsCard>,
    );

  // Plain null checks rather than jest-dom matchers: the unit tier's setup does
  // not register @testing-library/jest-dom, and this needs no more than presence.
  it('renders the sub-option rows while enabled', () => {
    renderRows({ [PrefKey.AUTO_INDEX_ENABLED]: true });
    expect(screen.queryByText('Index project on selection')).not.toBeNull();
    expect(screen.queryByText('Index depth')).not.toBeNull();
    expect(screen.queryByText('Index when')).not.toBeNull();
    expect(screen.queryByText('Run the walk in')).not.toBeNull();
  });

  it('drops the sub-option rows entirely when disabled', () => {
    renderRows({ [PrefKey.AUTO_INDEX_ENABLED]: false });
    // The master toggle stays; a hidden row is not merely disabled, it never mounts.
    expect(screen.queryByText('Index project on selection')).not.toBeNull();
    expect(screen.queryByText('Index depth')).toBeNull();
    expect(screen.queryByText('Index when')).toBeNull();
    expect(screen.queryByText('Run the walk in')).toBeNull();
  });
});
