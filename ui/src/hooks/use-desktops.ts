import {
  ActionInfo,
  ComputeNode,
  ComputeProviderType,
  dataContext,
  dataManager,
  ExecutionEnvironmentStatus,
  QueryRequest,
  TypeId,
} from '@sdk';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Desktops = cloud FlowPad instances running in E2B — a ComputeNode whose
 * `node_config.flavor === 'workspace'`. This hook lists them and drives the
 * hub's EXISTING ComputeNode API to launch/terminate them (no hub API changes).
 *
 * The launch pipeline mirrors the hub's own `use-open-workspace.ts`:
 *   create (workspace-scoped) → ops/setup → ops/workspace-ready → get-host → open tab.
 *
 * Only meaningful against a hub backend: the `workspace` flavor + `workspace-ready`
 * op live in the hub, not the local desktop backend.
 */

/** The port the FlowPad app serves on inside a workspace sandbox. */
const WORKSPACE_PORT = 9007;
/** The flavor that marks a ComputeNode as a desktop (vs. an agent/exec-env node). */
const WORKSPACE_FLAVOR = 'workspace';

export type StepStatus = 'idle' | 'loading' | 'success' | 'error';
export type StepId = 'launch' | 'health' | 'open';

export interface Step {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
}

const INITIAL_STEPS: Step[] = [
  { id: 'launch', label: 'Launching desktop', status: 'idle' },
  { id: 'health', label: 'Starting FlowPad and signing in', status: 'idle' },
  { id: 'open', label: 'Opening desktop', status: 'idle' },
];

/** Only the fields we read from ops/workspace-ready. */
interface WorkspaceReadyResult {
  healthy: boolean;
  logged_in: boolean;
  login_detail: string;
}

/**
 * The OSS↔hub wire-field divergence lives ONLY in these two helpers. The hub's
 * ComputeNode field is `node_provider`, but the OSS entity types it
 * `node_provider_type` and drops the former on `toJSON()`. `readProvider`
 * tolerates both on read; `hubEntityJson` re-injects it on write (an existing
 * node's provider, else E2B for a fresh draft) so `ops/setup` doesn't fail with
 * "provider is not set".
 */
function readProvider(node: ComputeNode): string | undefined {
  return (node as unknown as { node_provider?: string }).node_provider ?? node.node_provider_type;
}

function hubEntityJson(node: ComputeNode, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...node.toJSON(), node_provider: readProvider(node) ?? ComputeProviderType.E2B, ...patch };
}

/** Invoke one of the ComputeNode `ops/<op>` actions (setup, status, shutdown, …). */
function opsCall<T = unknown>(nodeId: string, op: string, body?: Record<string, unknown>): Promise<T> {
  const info = new ActionInfo('ops', ComputeNode.type, nodeId, 'POST');
  info.subpath = [op];
  if (body) info.bodyParameters = body;
  return dataManager.callAction<Record<string, unknown> | undefined, T>(info);
}

/** A ComputeNode is a "desktop" iff it's an E2B node created from the workspace flavor. */
export function isDesktop(node: ComputeNode): boolean {
  const flavor = (node.node_config as { flavor?: string } | undefined)?.flavor;
  return readProvider(node) === ComputeProviderType.E2B && flavor === WORKSPACE_FLAVOR;
}

/** Next auto-name: one past the highest existing "Desktop N" (so it reads as latest). */
function nextDesktopName(desktops: ComputeNode[]): string {
  let max = 0;
  for (const d of desktops) {
    const m = /^Desktop (\d+)$/.exec(d.name ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Desktop ${max + 1}`;
}

/** Resolve a desktop's public URL via the hub's get-host action. */
async function resolveHostUrl(nodeId: string): Promise<string> {
  const host = new ActionInfo('get-host', ComputeNode.type, nodeId, 'GET');
  host.queryParameters = { port: WORKSPACE_PORT, redirect: false };
  const result = await dataManager.callAction<void, { url: string; port: number }>(host);
  if (!result?.url) throw new Error('Could not resolve the desktop URL');
  return result.url;
}

export function useDesktops() {
  const { user } = useAuth();

  const desktopsRequest = useMemo(
    () => new QueryRequest({ type: ComputeNode.type, query: null, scope: [], name: 'useDesktops-nodes' }),
    [],
  );

  const { data: nodes, isLoading, refetch } = useEntitiesQuery<ComputeNode>(desktopsRequest, { enabled: !!user });

  const desktops = useMemo(() => (nodes ?? []).filter(isDesktop), [nodes]);

  // ---- live status (probed on load) ----
  const [statuses, setStatuses] = useState<Record<string, ExecutionEnvironmentStatus>>({});
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  const probeStatus = useCallback(async (nodeId: string): Promise<ExecutionEnvironmentStatus> => {
    try {
      const res = await opsCall<{ status: string }>(nodeId, 'status');
      return (res?.status as ExecutionEnvironmentStatus) ?? ExecutionEnvironmentStatus.ERROR;
    } catch {
      return ExecutionEnvironmentStatus.ERROR;
    }
  }, []);

  // Probe only desktops we haven't seen yet, and forget ones that vanished —
  // re-probing the whole list on every add/delete would be one call per desktop.
  useEffect(() => {
    const liveIds = new Set(desktops.map((d) => d.id));
    setStatuses((prev) => {
      const kept = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
    const fresh = desktops.filter((d) => !(d.id in statusesRef.current));
    if (!fresh.length) return;
    void Promise.all(fresh.map(async (d) => [d.id, await probeStatus(d.id)] as const)).then((entries) =>
      setStatuses((prev) => ({ ...prev, ...Object.fromEntries(entries) })),
    );
  }, [desktops, probeStatus]);

  // ---- launch ----
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [launching, setLaunching] = useState(false);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const launchingRef = useRef(false);

  const patch = useCallback((id: StepId, next: Partial<Step>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...next } : s)));
  }, []);

  const launch = useCallback(async () => {
    if (launchingRef.current) return;
    // Prefer the workspace scope (hub does workspace.add_child); fall back to
    // owner scope ([]) when hub mode exposes no workspace — the node is still
    // owned by the caller and listed by the role-scoped query.
    const scope = dataContext.workspaceTypeId ? [dataContext.workspaceTypeId] : [];
    launchingRef.current = true;
    setLaunching(true);
    setLaunchUrl(null);
    setSteps(INITIAL_STEPS);

    // Claim the tab while we still hold the click gesture; fill its URL after the awaits.
    const tab = window.open('', '_blank');

    const run = async <T,>(id: StepId, fn: () => Promise<T>): Promise<T> => {
      patch(id, { status: 'loading', detail: undefined });
      try {
        const result = await fn();
        patch(id, { status: 'success' });
        return result;
      } catch (e) {
        patch(id, { status: 'error', detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };

    try {
      const node = await run('launch', async () => {
        const draft = new ComputeNode({ name: nextDesktopName(desktops), node_config: { flavor: WORKSPACE_FLAVOR } });
        await dataManager.save(draft.typeId, scope, hubEntityJson(draft) as never);
        // A bare workspace needs no LM-proxy key, and minting one costs round-trips.
        const providerId = await opsCall<string>(draft.id, 'setup', { skip_lm_proxy: true });
        if (!providerId) throw new Error('setup returned no provider id (provider was dropped)');
        return draft;
      });

      await run('health', async () => {
        const result = await opsCall<WorkspaceReadyResult>(node.id, 'workspace-ready');
        if (!result?.healthy) throw new Error('FlowPad did not come up in the sandbox');
        patch('health', {
          detail: result.logged_in ? `signed in as ${result.login_detail}` : 'opened without cloud sign-in',
        });
        return result;
      });

      const url = await run('open', () => resolveHostUrl(node.id));

      // The just-launched sandbox is up — seed its status so the list effect
      // doesn't re-probe it.
      setStatuses((s) => ({ ...s, [node.id]: ExecutionEnvironmentStatus.READY }));
      setLaunchUrl(url);
      if (tab) tab.location.href = url;
      await refetch();
    } catch {
      tab?.close();
    } finally {
      launchingRef.current = false;
      setLaunching(false);
    }
  }, [patch, refetch, desktops]);

  // ---- rename ----
  const renameDesktop = useCallback(
    async (node: ComputeNode, name: string) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === node.name) return;
      await dataManager.save(node.typeId, [], hubEntityJson(node, { name: trimmed }) as never);
      await refetch();
    },
    [refetch],
  );

  // ---- open an existing desktop ----
  const openDesktop = useCallback(
    async (node: ComputeNode) => {
      // Claim the tab synchronously (this runs within the click gesture) before the
      // async work below, so the browser doesn't block it as a popup.
      const tab = window.open('', '_blank');
      try {
        // A paused sandbox's URL 404s until it's resumed; a gone one can't open at all.
        const status = await probeStatus(node.id);
        if (status === ExecutionEnvironmentStatus.NOT_FOUND || status === ExecutionEnvironmentStatus.ERROR) {
          tab?.close();
          return;
        }
        if (status === ExecutionEnvironmentStatus.PAUSED) {
          await opsCall(node.id, 'resume');
          setStatuses((s) => ({ ...s, [node.id]: ExecutionEnvironmentStatus.READY }));
        }
        const url = await resolveHostUrl(node.id);
        if (tab) tab.location.href = url;
      } catch {
        tab?.close();
      }
    },
    [probeStatus],
  );

  // ---- delete / terminate ----
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const deleteDesktop = useCallback(
    async (node: ComputeNode) => {
      setDeletingId(node.id);
      try {
        // Shutdown BEFORE delete: it kills the sandbox and revokes the auto-login
        // key (needs the user session). DELETE alone would orphan a live sandbox.
        try {
          await opsCall(node.id, 'shutdown');
        } catch {
          // A node that never finished setup has no sandbox to shut down; delete anyway.
        }
        await dataManager.delete(new TypeId(ComputeNode.type, node.id));
        await refetch();
      } finally {
        setDeletingId(null);
      }
    },
    [refetch],
  );

  return {
    desktops,
    isLoading,
    refetch,
    launch,
    launching,
    steps,
    launchUrl,
    openDesktop,
    renameDesktop,
    deleteDesktop,
    deletingId,
    statuses,
  };
}
