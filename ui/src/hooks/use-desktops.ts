import {
  ActionInfo,
  ComputeNode,
  ComputeProviderType,
  dataContext,
  dataManager,
  ExecutionEnvironmentStatus,
  type GitOrigin,
  gitOriginFromUrl,
  QueryRequest,
  TypeId,
} from '@sdk';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import {
  type ContentInstallSpec,
  type InstallNavigationResult,
  installProjectLandingUrl,
} from '@src/lib/content-install';
import { notify } from '@src/notifications';
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

// Step/StepStatus are the shared checklist model (`@src/hooks/use-step-flow`),
// re-exported here so existing importers of this module keep working. This
// hook predates that extraction and still drives its own steps inline, because
// it also mirrors each transition into the claimed tab's placeholder document
// (see paintTab) — something the generic runner has no concept of.
import type { Step as GenericStep } from './use-step-flow';

export type StepId =
  | 'launch'
  | 'health'
  | 'validate'
  | 'clone'
  | 'init'
  | 'index'
  | 'context'
  | 'default'
  | 'open';
export type Step = GenericStep<StepId>;

/** Every row from `validate` to `default` is one `computeNodeTools` command, so
 *  a row finishing IS a command returning — the checklist needs no separate
 *  progress channel. Which rows appear is decided by {@link plannedSteps}. */
const STEP_LABELS: Record<StepId, string> = {
  launch: 'Launching desktop',
  health: 'Starting FlowPad and signing in',
  validate: 'Checking the project name',
  clone: 'Cloning the repository',
  init: 'Setting up the project',
  index: 'Indexing the project',
  context: 'Attaching context projects',
  default: 'Choosing the project to open',
  open: 'Opening desktop',
};

/**
 * Could this setup have context projects to attach?
 *
 * A git-backed project can declare them in its manifest, which only the clone
 * can reveal — so the answer is "maybe" for anything with a repo, and the step
 * reports "none declared" when it turns out there were none. Shared by the row
 * planner and the runner so a row can never be planned without its step, or a
 * step run without its row.
 */
function hasContextWork(setup: SandboxSetup): boolean {
  return Boolean(setup.install || setup.contextProjects?.length || setup.gitOrigin);
}

/**
 * The rows for THIS launch, in the order they will run.
 *
 * Derived rather than declared: a launch is a sequence of computeNodeTools
 * calls, and which calls happen depends on what the user asked for. A fixed
 * list would show a "Cloning" row for a project with no repository, and every
 * new flow would hand-maintain its own copy.
 */
function plannedSteps(setup?: SandboxSetup): Step[] {
  const ids: StepId[] = ['launch', 'health'];
  if (setup) {
    // No repo to fetch → the box mounts the project empty instead.
    ids.push(...(setup.gitOrigin ? (['validate', 'clone'] as StepId[]) : (['init'] as StepId[])));
    ids.push('index');
    if (hasContextWork(setup)) ids.push('context');
    ids.push('default');
  }
  ids.push('open');
  return ids.map((id) => ({ id, label: STEP_LABELS[id], status: 'idle' }));
}

/** Id of the step-label element in the placeholder document (updated in place). */
const PREPARING_LINE_ID = 'step';

// Placeholder shown in the claimed tab while a desktop launches; replaced with the
// real URL only once every step succeeds. It's a standalone blank-tab document (no
// app stylesheet in scope), so the colors are inlined rather than theme tokens.
// Written ONCE — later steps only swap the line's text, so the dot animation runs
// continuously instead of restarting on every transition.
const PREPARING_DESKTOP_HTML =
  '<!doctype html><meta charset="utf-8"><title>Preparing desktop…</title>' +
  '<style>html,body{height:100%;margin:0;display:grid;place-items:center;' +
  'background:#0b0b0c;color:#e5e5e5;font:14px system-ui,sans-serif}' +
  '.w{display:flex;flex-direction:column;align-items:center;gap:14px}' +
  // Three-dot spinner: the "still working, next step coming" cue while a step runs.
  '.d{display:flex;gap:6px}.d i{width:6px;height:6px;border-radius:50%;background:#8b8b90;' +
  'animation:b 1.4s ease-in-out infinite}.d i:nth-child(2){animation-delay:.2s}' +
  '.d i:nth-child(3){animation-delay:.4s}' +
  '@keyframes b{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}' +
  '</style>' +
  `<div class="w"><div id="${PREPARING_LINE_ID}"></div><div class="d"><i></i><i></i><i></i></div></div>`;

/** Only the fields we read from ops/workspace-ready. */
interface WorkspaceReadyResult {
  healthy: boolean;
  logged_in: boolean;
  login_detail: string;
}

/**
 * Live per-desktop info from `ops/status` (one cheap get_info). `started_at` is
 * the current run's start (resets on resume); `end_at` is when the sandbox
 * auto-pauses/expires. Fields beyond `status` are E2B-only.
 */
export interface DesktopDetails {
  status: ExecutionEnvironmentStatus;
  started_at?: string | null;
  end_at?: string | null;
  cpu_count?: number;
  memory_mb?: number;
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
export function nextDesktopName(desktops: ComputeNode[]): string {
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

/**
 * The project a freshly launched desktop is set up with — usually the one the
 * user is working on.
 *
 * With a `gitOrigin` the hub clones it (authed when private, which is the only
 * way a private repo is reachable) and copies it into the box. Without one
 * there is nothing to fetch, so the box mounts it empty: a project that was
 * never cloned from anywhere still gets its directory and its identity.
 */
export interface SandboxSetup {
  /** Absent for a project with no repository behind it. */
  gitOrigin?: GitOrigin;
  /** Folder/display name for the set-up project. */
  name: string;
  /** Adopted by the box, so one project id spans hub and sandbox. */
  projectId?: string;
  /** Help desks / skills repos to clone and attach as context of this project.
   *  Defaults to whatever the cloned repo's own manifest declares. */
  contextProjects?: ContextProject[];
  /** Review-branch content installation, applied to the hub's checkout before
   *  the tree is copied in, then reconciled on the box. Git-backed only. */
  install?: ContentInstallSpec;
}

/** @deprecated Kept while call sites migrate: a sandbox project used to be
 *  git-only, so this was its name. */
export type GitSetup = SandboxSetup;

/** A repo that becomes its own project on the box AND a context folder of the
 *  main one — how a help desk's skills and assets come into scope. */
export interface ContextProject {
  gitOrigin: GitOrigin;
  name: string;
  scope: 'private' | 'shared';
}

/** What `clone-project` returns: the box's Project, where it landed, and what
 *  the repo declares it wants alongside it (read hub-side from the checkout). */
interface CloneResult extends InstallNavigationResult {
  path: string;
  manifest?: ManifestEntry[];
  message?: string;
}

/** One `content_projects` entry from the cloned repo's `.flowpad/bootstrap.json`. */
interface ManifestEntry {
  url: string;
  branch: string;
  scope: 'private' | 'shared';
}

/** What `validate-project-name` answers. */
interface NameCheck {
  available: boolean;
  suggested: string;
}

/** The repo's declared help desks / content projects, as context projects to
 *  clone and attach. A declaration that isn't a usable git URL is dropped
 *  rather than failing a setup that has otherwise finished — the manifest comes
 *  from a third-party repo and is a claim, never a capability. */
function manifestContextProjects(cloned: CloneResult): ContextProject[] {
  return (cloned.manifest ?? []).flatMap((entry) => {
    const gitOrigin = gitOriginFromUrl(entry.url, entry.branch ?? '');
    if (!gitOrigin) return [];
    return [{ gitOrigin, name: gitOrigin.name, scope: entry.scope ?? 'shared' }];
  });
}

/** Type of the step runner `launch` hands to the git provisioning helper. */
type RunStep = <T>(id: StepId, fn: () => Promise<T>) => Promise<T>;
type PatchStep = (id: StepId, next: Partial<Step>) => void;

/**
 * Set the sandbox up with its project and make that the project it opens on.
 *
 * Extracted from `launch` so the launch reads as its sequence of steps and the
 * result can be a return value rather than a mutated `let` every later step has
 * to non-null-assert.
 */
async function provisionSandboxProject(
  nodeId: string,
  setup: SandboxSetup,
  run: RunStep,
  patch: PatchStep,
): Promise<CloneResult> {
  const cloned = setup.gitOrigin
    ? await cloneSandboxProject(nodeId, setup, run, patch)
    : await run('init', async () => {
        // No repository behind this project — the box mounts it empty, which
        // is still what gives the directory its identity.
        const result = await opsCall<CloneResult>(nodeId, 'init-empty-project', {
          name: setup.name,
          project_id: setup.projectId ?? '',
        });
        if (!result?.project?.id) throw new Error('Setup did not return a project');
        return result;
      });

  const projectId = cloned.project!.id!;
  await run('index', () => opsCall(nodeId, 'index-project', { path: cloned.path, project_id: projectId }));

  if (hasContextWork(setup)) {
    await run('context', async () => {
      // A declarative install converges its own dependencies through the
      // manifest, so driving them from here too would attach each twice.
      if (setup.install) {
        // The box answers with the reconcile result itself, which is what names
        // the project (and journey) the install wants opened.
        const reconciled = await opsCall<CloneResult['install_result']>(nodeId, 'reconcile-manifest', {
          project_id: projectId,
        });
        if (reconciled) cloned.install_result = reconciled;
        patch('context', { detail: 'from the install manifest' });
        return reconciled;
      }
      // What the caller asked for, else what the repo itself declares.
      const contextProjects = setup.contextProjects ?? manifestContextProjects(cloned);
      const attached = await attachContextProjects(nodeId, projectId, contextProjects);
      patch('context', { detail: attached.length ? attached.join(', ') : 'none declared' });
      return attached;
    });
  }

  await run('default', () => opsCall(nodeId, 'set-default-project', { project_id: projectId }));
  return cloned;
}

/** Ask the box whether the name is free, then have the hub clone into it. */
async function cloneSandboxProject(
  nodeId: string,
  setup: SandboxSetup,
  run: RunStep,
  patch: PatchStep,
): Promise<CloneResult> {
  await run('validate', async () => {
    const check = await opsCall<NameCheck>(nodeId, 'validate-project-name', { name: setup.name });
    if (check && check.available === false) {
      throw new Error(`"${setup.name}" already exists — try "${check.suggested}".`);
    }
    return check;
  });

  return run('clone', async () => {
    patch('clone', { detail: `cloning ${setup.name}…` });
    const result = await opsCall<CloneResult>(nodeId, 'clone-project', {
      git_origin: setup.gitOrigin,
      name: setup.name,
      project_id: setup.projectId ?? '',
      ...(setup.install ? { install: setup.install } : {}),
    });
    if (!result?.project?.id) throw new Error('Clone did not return a project');
    return result;
  });
}

/**
 * Clone each context project and link it into `projectId`.
 *
 * Serial on purpose: the box's indexer is single-flight, and every attach is a
 * read-modify-write of the same parent project, so overlapping them would drop
 * context entries. One failure doesn't cost the others.
 */
async function attachContextProjects(
  nodeId: string,
  projectId: string,
  contextProjects: ContextProject[],
): Promise<string[]> {
  const attached: string[] = [];
  for (const ctx of contextProjects) {
    const ctxClone = await opsCall<CloneResult>(nodeId, 'clone-project', {
      git_origin: ctx.gitOrigin,
      name: ctx.name,
    });
    if (!ctxClone?.path) continue;
    await opsCall(nodeId, 'index-project', {
      path: ctxClone.path,
      project_id: ctxClone.project?.id ?? '',
    });
    await opsCall(nodeId, 'attach-context-project', {
      project_id: projectId,
      context_path: ctxClone.path,
      scope: ctx.scope,
    });
    attached.push(ctx.name);
  }
  return attached;
}

export function useDesktops() {
  const { user } = useAuth();

  const desktopsRequest = useMemo(
    () => new QueryRequest({ type: ComputeNode.type, query: null, scope: [], name: 'useDesktops-nodes' }),
    [],
  );

  const { data: nodes, isLoading, refetch } = useEntitiesQuery<ComputeNode>(desktopsRequest, { enabled: !!user });

  const desktops = useMemo(() => (nodes ?? []).filter(isDesktop), [nodes]);
  // `launch` only needs the list to pick the next auto-name. Reading it through
  // a ref keeps `launch` stable across every refetch — including the one it
  // triggers itself — so consumers holding it as a prop don't re-render.
  const desktopsRef = useRef(desktops);
  desktopsRef.current = desktops;

  // ---- live status (probed on load) ----
  const [details, setDetails] = useState<Record<string, DesktopDetails>>({});
  const detailsRef = useRef(details);
  detailsRef.current = details;

  const probeDetails = useCallback(async (nodeId: string): Promise<DesktopDetails> => {
    try {
      const res = await opsCall<DesktopDetails>(nodeId, 'status');
      return res ?? { status: ExecutionEnvironmentStatus.ERROR };
    } catch {
      return { status: ExecutionEnvironmentStatus.ERROR };
    }
  }, []);

  // Probe only desktops we haven't seen yet, and forget ones that vanished —
  // re-probing the whole list on every add/delete would be one call per desktop.
  useEffect(() => {
    const liveIds = new Set(desktops.map((d) => d.id));
    setDetails((prev) => {
      const kept = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
    const fresh = desktops.filter((d) => !(d.id in detailsRef.current));
    if (!fresh.length) return;
    void Promise.all(fresh.map(async (d) => [d.id, await probeDetails(d.id)] as const)).then((entries) =>
      setDetails((prev) => ({ ...prev, ...Object.fromEntries(entries) })),
    );
  }, [desktops, probeDetails]);

  // ---- launch ----
  const [steps, setSteps] = useState<Step[]>(() => plannedSteps());
  const [launching, setLaunching] = useState(false);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const launchingRef = useRef(false);

  const patch = useCallback((id: StepId, next: Partial<Step>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...next } : s)));
  }, []);

  const launch = useCallback(async (opts?: { name?: string; sandboxProject?: SandboxSetup }) => {
    if (launchingRef.current) return;
    const sandboxProject = opts?.sandboxProject;
    // Prefer the workspace scope (hub does workspace.add_child); fall back to
    // owner scope ([]) when hub mode exposes no workspace — the node is still
    // owned by the caller and listed by the role-scoped query.
    const scope = dataContext.workspaceTypeId ? [dataContext.workspaceTypeId] : [];
    launchingRef.current = true;
    setLaunching(true);
    setLaunchUrl(null);
    setSteps(plannedSteps(sandboxProject));

    // Claim the tab while we still hold the click gesture, but DON'T load the
    // desktop into it yet — show a "preparing" placeholder and only navigate to
    // the real URL once every launch step has succeeded (bug: the desktop must
    // open only when ready, not flash a blank/half-ready tab).
    const tab = window.open('', '_blank');
    if (tab) {
      tab.document.write(PREPARING_DESKTOP_HTML);
      tab.document.close();
    }
    // Swap only the label so the dot animation keeps running across steps.
    const paintTab = (line: string) => {
      const el = tab?.document.getElementById(PREPARING_LINE_ID);
      if (el) el.textContent = line;
    };
    paintTab('Preparing your desktop…');

    const run = async <T,>(id: StepId, fn: () => Promise<T>): Promise<T> => {
      patch(id, { status: 'loading', detail: undefined });
      paintTab(`${STEP_LABELS[id]}…`);
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
        const draft = new ComputeNode({
          name: opts?.name?.trim() || nextDesktopName(desktopsRef.current),
          node_config: { flavor: WORKSPACE_FLAVOR },
        });
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
        // Don't let a failed cloud sign-in pass silently: the desktop opened, but
        // couldn't reach the hub to sign in (e.g. hub down / WORKSPACE_HUB_URL unset).
        if (!result.logged_in) {
          notify.warning({
            id: 'desktop-no-signin',
            title: 'Desktop opened without cloud sign-in',
            message: "Couldn't reach the hub to sign this desktop in — it may be down or unreachable. You can sign in from inside the desktop.",
          });
        }
        return result;
      });

      // Set the git repo up by composing computeNodeTools, one command per step.
      // The HUB clones (its token is the only one that reaches a private repo)
      // and copies the tree in; the box places, indexes and links it. Runs after
      // the box is up so copy_folder has a target.
      const cloned = sandboxProject ? await provisionSandboxProject(node.id, sandboxProject, run, patch) : null;

      const url = await run('open', async () => {
        const host = await resolveHostUrl(node.id);
        if (!cloned) return host;
        // Land INSIDE the project that was just set up — for every git launch,
        // not only a content install. Without this the box opens on its own
        // front door and the project you asked for is merely one of the list.
        return installProjectLandingUrl(host, cloned) ?? host;
      });

      // The just-launched sandbox is up — seed its status so the list effect
      // doesn't re-probe it.
      setDetails((s) => ({ ...s, [node.id]: { status: ExecutionEnvironmentStatus.READY } }));
      setLaunchUrl(url);
      if (tab) tab.location.href = url;
      await refetch();
    } catch {
      tab?.close();
    } finally {
      launchingRef.current = false;
      setLaunching(false);
    }
  }, [patch, refetch]);

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
        const { status } = await probeDetails(node.id);
        if (status === ExecutionEnvironmentStatus.NOT_FOUND || status === ExecutionEnvironmentStatus.ERROR) {
          tab?.close();
          return;
        }
        if (status === ExecutionEnvironmentStatus.PAUSED) {
          await opsCall(node.id, 'resume');
          setDetails((s) => ({ ...s, [node.id]: { status: ExecutionEnvironmentStatus.READY } }));
        }
        const url = await resolveHostUrl(node.id);
        if (tab) tab.location.href = url;
      } catch {
        tab?.close();
      }
    },
    [probeDetails],
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
    details,
  };
}
