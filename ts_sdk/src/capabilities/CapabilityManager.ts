import { lazyAssets, LazyAsset } from '../lazy';
import { EventEmitter } from 'events';

import { dataManager } from '../APIEntity';
import apiClient from '../client';
import {
  Capability,
  CapabilityActionName,
  CapabilityCheck,
  CapabilityResult,
  CapabilityState,
  ICapability,
} from '../entities/capability';
import { normalizeKind } from '../models/Kind';
import { EventBus } from '../tags/EventBus';
import { defineGlobal } from '../utils/globals';
import { isHubOnly } from '../utils/hub-runtime';

export interface CapabilitySnapshot {
  queryKind: string;
  capabilities: Capability[];
  capability: Capability | null;
  available: boolean;
  checked: boolean;
  result: CapabilityResult | null;
  dependencies: Record<string, CapabilityResult>;
  processId: string | null;
  /**
   * Concrete capability kind this snapshot resolves to. For a
   * CapabilityReference row (e.g. the `harness` Default-harness pointer) this
   * is the referenced kind (claude or codex); otherwise the picked
   * capability's own kind.
   */
  resolvedKind: string | null;
  /** Canonical process worker behind `resolvedKind`, from the backend summary. */
  resolvedWorkerType: string | null;
}

/** One dependency edge in a CapabilityAccess (mirror of backend summary.py). */
export interface CapabilityDependency {
  kind: string;
  available: boolean;
}

/**
 * One capability + everything the UI needs to show/use it. 1:1 with the
 * backend `CapabilityAccess` pydantic model (core/capabilities/summary.py).
 */
export interface CapabilityAccess {
  kind: string;
  intent: string;
  name: string;
  description: string;
  icon: string;
  available: boolean;
  checked: boolean;
  /** Persisted four-state readiness (mirror of CapabilityState). */
  state: CapabilityState;
  runnable: boolean;
  installable: boolean;
  worker_type: string | null;
  homepage_url: string | null;
  /** Install one-liner for this machine, or null. See `Capability.install_command`. */
  install_command: string | null;
  reference_kind: string | null;
  dependencies: CapabilityDependency[];
  value: unknown | null;
  value_type: string | null;
  last_process_id: string | null;
  message: string;
}

/** All capabilities answering one intent (segment-1 handle). */
export interface CapabilityIntent {
  intent: string;
  label: string;
  available: boolean;
  capabilities: CapabilityAccess[];
}

export interface CapabilitiesSummary {
  intents: CapabilityIntent[];
  capabilities: CapabilityAccess[];
  generated_at: string;
}

/**
 * Frontend singleton for capability state.
 *
 * The backend owns the real check/install/test logic. This manager owns client
 * caching, prefix resolution, and in-flight de-duplication so multiple callers
 * can ask for `harness.claude` without spawning repeated CLI checks.
 */
export class CapabilityManager extends EventEmitter {
  private static instance: CapabilityManager;

  private capabilities: Capability[] = [];
  private summary: CapabilitiesSummary | null = null;
  private actionPromises = new Map<string, Promise<CapabilityCheck>>();
  private ensureCheckPromises = new Map<string, Promise<CapabilitySnapshot>>();
  private actionResults = new Map<string, CapabilityCheck>();

  constructor() {
    super();
    // Each mounted `useCapability` (and the capabilities view) adds one
    // 'change' listener and removes it on unmount — they are per-mount, not
    // leaked. The app legitimately mounts >10 concurrent subscribers (the
    // Claude/Codex/Copilot triple is read by App, both terminal strips, and
    // the capabilities panel), which trips EventEmitter's default-10 leak
    // heuristic. Disable the cap rather than pick a bound that re-trips later.
    this.setMaxListeners(0);
  }

  static getInstance(): CapabilityManager {
    if (!CapabilityManager.instance) {
      CapabilityManager.instance = new CapabilityManager();
    }
    return CapabilityManager.instance;
  }

  subscribe(listener: () => void): () => void {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  kindMatches(queryKind: string, capabilityKind: string): boolean {
    return Capability.kindMatches(queryKind, capabilityKind);
  }

  /** Fetch the capability list once; subsequent calls reuse the cache unless invalidated. */
  load(invalidate = false): Promise<Capability[]> {
    return invalidate ? lazyAssets.refresh(LazyAsset.Capabilities) : lazyAssets.load(LazyAsset.Capabilities);
  }

  /** Registry loader; the manager remains the canonical live capability projection. */
  async fetchSnapshot(isCurrent: () => boolean): Promise<Capability[]> {
    const rows = isHubOnly() ? [] : await apiClient.get<unknown[]>('/graph/capability', { params: { include_system: true } });
    if (!isCurrent()) throw new Error('SDK scope changed');
    this.capabilities = (rows ?? []).map(row => dataManager.updateEntityFromJson<Capability>(row));
    this.emit('change');
    return this.capabilities;
  }

  getAll(): Capability[] {
    return [...this.capabilities];
  }

  /** Last known capabilities summary (bootstrap-seeded or fetched); null until loaded. */
  getCachedSummary(): CapabilitiesSummary | null {
    return this.summary;
  }

  /** Seed the summary from the bootstrap payload (avoids a first round-trip). */
  setSummary(summary: CapabilitiesSummary | null | undefined): void {
    if (!summary) return;
    this.summary = summary;
    lazyAssets.client.setQueryData(lazyAssets.key(LazyAsset.CapabilitySummary), summary);
    this.emit('change');
  }

  /** Discovery is only an initial seed; a live or requested refresh takes precedence. */
  seedSummary(summary: CapabilitiesSummary | null | undefined): void {
    if (this.summary || lazyAssets.client.isFetching({ queryKey: lazyAssets.prefix(LazyAsset.CapabilitySummary) })) return;
    this.setSummary(summary);
  }

  /**
   * The "all capabilities + how to access each" summary, grouped by intent.
   * Cached after first fetch; pass `invalidate` to force a refresh (e.g. after
   * an install completes).
   */
  getSummary(invalidate = false): Promise<CapabilitiesSummary> {
    return invalidate ? lazyAssets.refresh(LazyAsset.CapabilitySummary) : lazyAssets.load(LazyAsset.CapabilitySummary);
  }

  async fetchSummary(isCurrent: () => boolean): Promise<CapabilitiesSummary> {
    const data = await apiClient.get<CapabilitiesSummary>('/graph/capabilities/summary');
    if (!isCurrent()) throw new Error('SDK scope changed');
    this.summary = data ?? { intents: [], capabilities: [], generated_at: '' };
    this.emit('change');
    return this.summary;
  }

  /**
   * Launch a setup agent for a plain-language capability request ("I want
   * email"). Returns the spawned process id; refreshes the summary so the
   * row's running state surfaces.
   */
  async setupIntent(text: string): Promise<{ process_id?: string | null; message?: string }> {
    const result = await apiClient.post<{ process_id?: string | null; message?: string }>(
      '/graph/capabilities/setup-intent',
      { text },
    );
    void this.getSummary(true);
    return result ?? {};
  }

  getMatching(queryKind: string): Capability[] {
    const query = normalizeKind(queryKind);
    return this.capabilities
      .filter((capability) => this.kindMatches(query, capability.kind))
      .sort((a, b) => this.compareCapabilitiesForQuery(query, a, b));
  }

  getSnapshot(queryKind: string): CapabilitySnapshot {
    const query = normalizeKind(queryKind);
    const capabilities = this.getMatching(query);
    const capability = this.pickCapability(query, capabilities);
    const result = capability ? this.getResult(capability) : null;
    const available = capabilities.some((candidate) => this.getResult(candidate)?.available === true);
    const checked = capabilities.some((candidate) => this.getResult(candidate) !== null);
    const processId =
      this.getProcessId(capability) ??
      capabilities.map((candidate) => this.getProcessId(candidate)).find(Boolean) ??
      null;
    const resolvedKind = capability
      ? ((result?.details?.reference_kind as string | undefined) ?? capability.reference_kind ?? capability.kind)
      : null;
    const resolvedWorkerType =
      (resolvedKind
        ? this.summary?.capabilities.find((access) => access.kind === resolvedKind)?.worker_type
        : null) ??
      (capability
        ? this.summary?.capabilities.find((access) => access.kind === capability.kind)?.worker_type
        : null) ??
      null;

    return {
      queryKind: query,
      capabilities,
      capability,
      available,
      checked,
      result,
      dependencies: capability ? (this.actionResults.get(capability.kind)?.dependencies ?? {}) : {},
      processId,
      resolvedKind,
      resolvedWorkerType,
    };
  }

  async ensureChecked(queryKind: string): Promise<CapabilitySnapshot> {
    const query = normalizeKind(queryKind);
    const existing = this.ensureCheckPromises.get(query);
    if (existing) return existing;

    const promise = (async () => {
      await this.load();
      const snapshot = this.getSnapshot(query);
      // Settled when something was checked AND the picked capability (the
      // exact/reference row when one exists) has its own result — a checked
      // sibling must not leave the pointer row unresolved.
      const pickedChecked = !snapshot.capability || this.getResult(snapshot.capability) !== null;
      if (snapshot.checked && pickedChecked) return snapshot;

      for (const capability of snapshot.capabilities) {
        if (this.getResult(capability) !== null) continue;
        const check = await this.runActionForCapability(capability, 'test');
        if (check.result.available) break;
      }

      return this.getSnapshot(query);
    })();

    this.ensureCheckPromises.set(query, promise);
    try {
      return await promise;
    } finally {
      this.ensureCheckPromises.delete(query);
    }
  }

  /**
   * Tri-state readiness for an exact capability kind: true = available,
   * false = not available, null = unknown (never tried / errored — retryable
   * via setupCapability). Reads the persisted row state; does NOT probe.
   */
  async checkCapability(kind: string): Promise<boolean | null> {
    const query = normalizeKind(kind);
    await this.load(true);
    const state = this.capabilities.find((c) => c.kind === query)?.state ?? 'none';
    if (state === 'available') return true;
    if (state === 'not_available') return false;
    return null;
  }

  /**
   * Run the capability's setup (backend install verb) to a terminal verdict:
   * resolves true ⇔ the capability is available afterwards.
   *
   * When install spawns an agentic process, resolution waits for the install
   * monitor's terminal row write (`last_setup.details.install_finalized`,
   * arriving over the entity WS channel) — the monitor always terminates and
   * persists a verdict, so no client-side timeout is layered on top.
   */
  async setupCapability(kind: string): Promise<boolean> {
    const query = normalizeKind(kind);
    await this.load();
    const row = this.capabilities.find((c) => c.kind === query);
    if (!row) throw new Error(`Capability ${query} was not found`);

    let resolveTerminal: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    let expectedProcessId: string | null = null;
    const off = EventBus.on(
      'app.entity.updated',
      (event) => {
        const entity = (event.data?.entity ?? null) as ICapability | null;
        const setup = entity?.last_setup;
        if (!setup?.details?.install_finalized) return;
        if (expectedProcessId && setup.process_id !== expectedProcessId) return;
        resolveTerminal();
      },
      { target: `capability:${row.id}` },
    );
    try {
      const check = await row.setup();
      expectedProcessId = check.result.process_id ?? null;
      if (expectedProcessId) await terminal;
    } finally {
      off();
    }
    void this.getSummary(true);
    return (await this.checkCapability(query)) === true;
  }

  async test(queryKind: string): Promise<CapabilitySnapshot> {
    return this.runAction(queryKind, 'test');
  }

  async setup(queryKind: string): Promise<CapabilitySnapshot> {
    return this.runAction(queryKind, 'setup');
  }

  /** Mutate one capability entity's persisted fields, save, then invalidate the
   *  cached action result and re-check. The shared write path behind
   *  setReferenceKind / setAuthMode. */
  private async mutateAndRecheck(
    queryKind: string,
    mutate: (capability: Capability) => void,
  ): Promise<CapabilitySnapshot> {
    const query = normalizeKind(queryKind);
    await this.load();
    const capability = this.capabilities.find((candidate) => candidate.kind === query);
    if (!capability) {
      throw new Error(`Capability ${query} was not found`);
    }
    mutate(capability);
    await capability.save();
    this.actionResults.delete(query);
    await this.load(true);
    return this.test(query);
  }

  async setReferenceKind(queryKind: string, referenceKind: string): Promise<CapabilitySnapshot> {
    const query = normalizeKind(queryKind);
    const reference = normalizeKind(referenceKind);
    if (!this.kindMatches(query, reference) || reference === query) {
      throw new Error(`Capability ${query} cannot reference ${reference}`);
    }
    return this.mutateAndRecheck(queryKind, (capability) => {
      capability.reference_kind = reference;
    });
  }

  /**
   * Set a harness's auth mode (device vs a stored LLM-provider key) and the
   * chosen provider. Unlike setReferenceKind (which writes the `harness`
   * reference row), this writes the concrete LEAF capability, e.g.
   * `harness.claude.cli`. Persists via entity save() then re-checks.
   */
  async setAuthMode(
    queryKind: string,
    mode: 'device' | 'api',
    provider?: string | null,
  ): Promise<CapabilitySnapshot> {
    return this.mutateAndRecheck(queryKind, (capability) => {
      capability.auth_mode = mode;
      capability.api_provider = mode === 'api' ? (provider ?? null) : null;
    });
  }

  /** Persist a harness's tier→model override map ({provider: {name: slug}}),
   *  layered over the driver defaults at spawn. Written on the leaf capability. */
  async setModelMap(
    queryKind: string,
    map: Record<string, Record<string, string>>,
  ): Promise<CapabilitySnapshot> {
    return this.mutateAndRecheck(queryKind, (capability) => {
      capability.model_map = map;
    });
  }

  private async runAction(queryKind: string, actionName: CapabilityActionName): Promise<CapabilitySnapshot> {
    const query = normalizeKind(queryKind);
    await this.load();
    const capabilities = this.getMatching(query);

    for (const capability of capabilities) {
      const result = await this.runActionForCapability(capability, actionName);
      if (actionName !== 'test' || result.result.available) break;
    }

    return this.getSnapshot(query);
  }

  private async runActionForCapability(
    capability: Capability,
    actionName: CapabilityActionName,
  ): Promise<CapabilityCheck> {
    const key = `${actionName}:${capability.kind}`;
    const existing = this.actionPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const result = await capability[actionName]();
      this.actionResults.set(capability.kind, result);
      this.emit('change');
      return result;
    })();

    this.actionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      this.actionPromises.delete(key);
    }
  }

  /**
   * The best available verdict for a capability, strongest evidence first.
   *
   * ``actionResults`` is in-memory and lives only as long as the page, so the
   * persisted fallbacks are what every reload depends on. ``last_check`` was
   * missing from that chain, and it is the field the backend actually populates
   * on a routine check (``restamp_capability_state`` writes ``row.last_check``)
   * — so after any reload this returned null, ``getSnapshot`` computed
   * ``checked = false``, and an installed, working CLI rendered as "not
   * installed" until something happened to re-run a check.
   *
   * Ordered weakest-last on purpose: a setup or test is a stronger statement
   * than a check, so ``last_check`` only answers when nothing better has.
   */
  private getResult(capability: Capability): CapabilityResult | null {
    return (
      this.actionResults.get(capability.kind)?.result ??
      capability.last_setup ??
      capability.last_test ??
      capability.last_check ??
      null
    );
  }

  private getProcessId(capability: Capability | null): string | null {
    if (!capability) return null;
    return (
      this.actionResults.get(capability.kind)?.result.process_id ??
      capability.last_setup?.process_id ??
      capability.last_test?.process_id ??
      null
    );
  }

  private pickCapability(query: string, capabilities: Capability[]): Capability | null {
    // An exact-kind row wins outright: a CapabilityReference (e.g. `harness`)
    // IS the answer for its query — availability of sibling descendants must
    // not bypass the pointer.
    return (
      capabilities.find((capability) => capability.kind === query) ??
      capabilities.find((capability) => this.getResult(capability)?.available === true) ??
      capabilities[0] ??
      null
    );
  }

  private compareCapabilitiesForQuery(query: string, a: Capability, b: Capability): number {
    if (a.kind === query && b.kind !== query) return -1;
    if (b.kind === query && a.kind !== query) return 1;
    const aAvailable = this.getResult(a)?.available === true;
    const bAvailable = this.getResult(b)?.available === true;
    if (aAvailable !== bAvailable) return aAvailable ? -1 : 1;
    return a.kind.localeCompare(b.kind);
  }
}

export const capabilityManager = CapabilityManager.getInstance();
defineGlobal('capabilityManager', capabilityManager);
