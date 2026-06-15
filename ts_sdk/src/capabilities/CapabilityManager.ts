import { EventEmitter } from 'events';

import { dataManager } from '../APIEntity';
import apiClient from '../client';
import { Capability, CapabilityActionName, CapabilityCheck, CapabilityResult } from '../entities/capability';
import { defineGlobal } from '../utils/globals';

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
  runnable: boolean;
  installable: boolean;
  worker_type: string | null;
  homepage_url: string | null;
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
  private summaryPromise: Promise<CapabilitiesSummary> | null = null;
  private loadPromise: Promise<Capability[]> | null = null;
  private actionPromises = new Map<string, Promise<CapabilityCheck>>();
  private ensureCheckPromises = new Map<string, Promise<CapabilitySnapshot>>();
  private actionResults = new Map<string, CapabilityCheck>();

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
  async load(invalidate: boolean = false): Promise<Capability[]> {
    if (this.loadPromise && !invalidate) {
      return this.loadPromise;
    }
    if (this.capabilities.length && !invalidate) {
      return this.capabilities;
    }

    this.loadPromise = (async () => {
      const rows = await apiClient.get<unknown[]>('/graph/capability', {
        params: { include_system: true },
      });
      this.capabilities = (rows ?? []).map((row: unknown) => dataManager.updateEntityFromJson<Capability>(row));
      this.emit('change');
      return this.capabilities;
    })();

    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
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
    this.emit('change');
  }

  /**
   * The "all capabilities + how to access each" summary, grouped by intent.
   * Cached after first fetch; pass `invalidate` to force a refresh (e.g. after
   * an install completes).
   */
  async getSummary(invalidate: boolean = false): Promise<CapabilitiesSummary> {
    if (this.summary && !invalidate && !this.summaryPromise) {
      return this.summary;
    }
    if (this.summaryPromise && !invalidate) {
      return this.summaryPromise;
    }
    this.summaryPromise = (async () => {
      const data = await apiClient.get<CapabilitiesSummary>('/graph/capabilities/summary');
      this.summary = data ?? { intents: [], capabilities: [], generated_at: '' };
      this.emit('change');
      return this.summary;
    })();
    try {
      return await this.summaryPromise;
    } finally {
      this.summaryPromise = null;
    }
  }

  /**
   * Launch a setup agent for a plain-language capability request ("I want
   * email"). Returns the spawned process id; refreshes the summary so the
   * row's running state surfaces.
   */
  async installIntent(text: string): Promise<{ process_id?: string | null; message?: string }> {
    const result = await apiClient.post<{ process_id?: string | null; message?: string }>(
      '/graph/capabilities/install-intent',
      { text },
    );
    void this.getSummary(true);
    return result ?? {};
  }

  getMatching(queryKind: string): Capability[] {
    const query = this.normalizeKind(queryKind);
    return this.capabilities
      .filter((capability) => this.kindMatches(query, capability.kind))
      .sort((a, b) => this.compareCapabilitiesForQuery(query, a, b));
  }

  getSnapshot(queryKind: string): CapabilitySnapshot {
    const query = this.normalizeKind(queryKind);
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
    };
  }

  async ensureChecked(queryKind: string): Promise<CapabilitySnapshot> {
    const query = this.normalizeKind(queryKind);
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
        const check = await this.runActionForCapability(capability, 'check');
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

  async check(queryKind: string): Promise<CapabilitySnapshot> {
    return this.runAction(queryKind, 'check');
  }

  async install(queryKind: string): Promise<CapabilitySnapshot> {
    return this.runAction(queryKind, 'install');
  }

  async test(queryKind: string): Promise<CapabilitySnapshot> {
    return this.runAction(queryKind, 'test');
  }

  async setReferenceKind(queryKind: string, referenceKind: string): Promise<CapabilitySnapshot> {
    const query = this.normalizeKind(queryKind);
    const reference = this.normalizeKind(referenceKind);
    await this.load();
    const capability = this.capabilities.find((candidate) => candidate.kind === query);
    if (!capability) {
      throw new Error(`Capability ${query} was not found`);
    }
    if (!this.kindMatches(query, reference) || reference === query) {
      throw new Error(`Capability ${query} cannot reference ${reference}`);
    }
    capability.reference_kind = reference;
    await capability.save();
    this.actionResults.delete(query);
    await this.load(true);
    return this.check(query);
  }

  private async runAction(queryKind: string, actionName: CapabilityActionName): Promise<CapabilitySnapshot> {
    const query = this.normalizeKind(queryKind);
    await this.load();
    const capabilities = this.getMatching(query);

    for (const capability of capabilities) {
      const result = await this.runActionForCapability(capability, actionName);
      if (actionName !== 'check' || result.result.available) break;
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

  private getResult(capability: Capability): CapabilityResult | null {
    return (
      this.actionResults.get(capability.kind)?.result ??
      capability.last_install ??
      capability.last_check ??
      capability.last_test ??
      null
    );
  }

  private getProcessId(capability: Capability | null): string | null {
    if (!capability) return null;
    return (
      this.actionResults.get(capability.kind)?.result.process_id ??
      capability.last_install?.process_id ??
      capability.last_test?.process_id ??
      capability.last_check?.process_id ??
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

  private normalizeKind(kind: string): string {
    return kind.trim().toLowerCase();
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
