import { dataManager } from '../APIEntity';
import type { TypeId } from '../models/TypeId';
import { isHubOnly } from '../utils/hub-runtime';

/**
 * WHEN a view mode is remembered — the one policy seam for `last_mode`.
 *
 * Reading memory (which mode a tab or project opens in) is navigation's job.
 * Writing it is this module's, and nothing else writes `last_mode`: callers
 * report WHAT happened as a `ViewModeEvent`, and the policy decides whether
 * that event is worth persisting. Changing when memory is minted is therefore
 * one edit to `VIEW_MODE_STORE`, not a hunt through loaders and click paths.
 */

/** Which event mints a scope's `last_mode`. */
export enum ViewModeStore {
  /** When the tab row is first created (and on every mode switch). */
  TabCreate = 'tab_create',
  /** Whenever the tab is opened, created or reused (and on every mode switch). */
  TabOpen = 'tab_open',
  /** Only when the user switches mode. */
  ModeSwitch = 'mode_switch',
  /** Never. */
  Never = 'never',
}

/** What just happened to a tab. */
export enum ViewModeEvent {
  TabCreate = 'tab_create',
  TabOpen = 'tab_open',
  ModeSwitch = 'mode_switch',
}

/** The policy per memory scope: the tab's own target, and its project. */
export interface ViewModeStorePolicy {
  tab: ViewModeStore;
  project: ViewModeStore;
}

export const VIEW_MODE_STORE: ViewModeStorePolicy = {
  tab: ViewModeStore.ModeSwitch,
  project: ViewModeStore.ModeSwitch,
};

/** Anything that remembers a mode — `Project` and `AgenticProcess` both fit. */
export interface ModeMemoryTarget {
  last_mode: string | null;
  save(): Promise<unknown>;
}

export interface ModeMemoryTargets {
  tab?: ModeMemoryTarget | null;
  project?: ModeMemoryTarget | null;
}

const STORED_ON: Record<ViewModeStore, ReadonlySet<ViewModeEvent>> = {
  [ViewModeStore.TabCreate]: new Set([ViewModeEvent.TabCreate, ViewModeEvent.ModeSwitch]),
  [ViewModeStore.TabOpen]: new Set([ViewModeEvent.TabCreate, ViewModeEvent.TabOpen, ViewModeEvent.ModeSwitch]),
  [ViewModeStore.ModeSwitch]: new Set([ViewModeEvent.ModeSwitch]),
  [ViewModeStore.Never]: new Set(),
};

export function shouldStore(policy: ViewModeStore, event: ViewModeEvent): boolean {
  return STORED_ON[policy].has(event);
}

/** The entity as a memory target, or null when its type carries no `last_mode`. */
function asModeMemoryTarget(entity: unknown): ModeMemoryTarget | null {
  const candidate = entity as Partial<ModeMemoryTarget> | null | undefined;
  return candidate && 'last_mode' in candidate && typeof candidate.save === 'function'
    ? (candidate as ModeMemoryTarget)
    : null;
}

export class ViewModeMemory {
  constructor(private readonly policy: ViewModeStorePolicy = VIEW_MODE_STORE) {}

  /** Whether any scope stores `event` — lets callers skip resolving targets. */
  wants(event: ViewModeEvent): boolean {
    return shouldStore(this.policy.tab, event) || shouldStore(this.policy.project, event);
  }

  /** The cached entity behind `typeId` as a memory target. Cache-only: memory
   *  is about what is on screen, which is always already loaded. */
  targetFor(typeId: TypeId | null | undefined): ModeMemoryTarget | null {
    return typeId ? asModeMemoryTarget(dataManager.getByTypeIdFromCache(typeId)) : null;
  }

  /** Persist `mode` onto each target whose scope policy stores `event`. */
  record(event: ViewModeEvent, targets: ModeMemoryTargets, mode: string): void {
    // View mode is a desk concept. On the hub a project save ships only the
    // hub schema's delta and wipes the project's name, so memory never writes.
    if (isHubOnly()) return;
    if (shouldStore(this.policy.tab, event)) stamp(targets.tab, mode);
    if (shouldStore(this.policy.project, event)) stamp(targets.project, mode);
  }
}

// The equality guard is what keeps a restored mode from costing a save: the mode
// a target was opened in comes straight back round as the value to record.
function stamp(target: ModeMemoryTarget | null | undefined, mode: string): void {
  if (!target || target.last_mode === mode) return;
  target.last_mode = mode;
  void target.save().catch((err: unknown) => {
    console.warn('[view-mode-memory] failed to record last_mode', err);
  });
}

export const viewModeMemory = new ViewModeMemory();
