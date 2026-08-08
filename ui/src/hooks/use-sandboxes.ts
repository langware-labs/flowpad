import {
  ActionInfo,
  ComputeNode,
  ComputeProviderType,
  dataContext,
  dataManager,
  ExecutionEnvironmentStatus,
  type GitOrigin,
  gitOriginFromUrl,
  type NodeStatus,
  QueryRequest,
  TypeId,
  WORKSPACE_FLAVOR,
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
 * Sandboxes = cloud FlowPad instances running in E2B — a ComputeNode whose
 * `node_config.flavor === 'workspace'`. This hook lists them and drives the
 * hub's EXISTING ComputeNode API to create/terminate them.
 *
 * Creating and opening are SEPARATE operations:
 *   createSandbox: save (workspace-scoped) → ops/setup → ops/workspace-ready → project setup
 *   openSandbox:   navigate to open-service/workspace
 *
 * They used to be one call that ended in `window.open`, which forced the whole
 * pipeline to run inside a single click gesture with a placeholder tab claimed
 * up front so a popup blocker wouldn't eat it. Splitting them means the open is
 * its own gesture, so the tab is claimed with its real URL and the placeholder
 * document, its progress painting, and the close-on-error path are all gone.
 *
 * Only meaningful against a hub backend: the `workspace` flavor + `workspace-ready`
 * op live in the hub, not the local desktop backend.
 */

/** The hub's name for the workspace app. The client names a SERVICE and never a
 *  port — the hub resolves it. This is now the only way anything here opens a
 *  box; `get-host` is a hub-internal detail the UI no longer touches.
 *  Wire contract — pinned hub-side by `unit/test_open_service_route_contract.py`. */
export const WORKSPACE_SERVICE = 'workspace';
// `WORKSPACE_FLAVOR` is imported from the SDK: this hook WRITES the marker at
// create time and `ComputeNode.isSandbox` READS it, so a local copy would let the
// writer and the reader drift apart silently.

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
  launch: 'Creating the sandbox',
  health: 'Starting FlowPad and signing in',
  validate: 'Checking the project name',
  clone: 'Cloning the repository',
  init: 'Setting up the project',
  index: 'Indexing the project',
  context: 'Attaching context projects',
  default: 'Choosing the project to open',
  open: 'Finishing up',
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
  // A manifest (and the install that reconciles one) can only come from a repo.
  return Boolean(setup.gitOrigin || setup.contextProjects?.length);
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
    // No repo to fetch → the box mounts the project empty instead, and an empty
    // directory has nothing to index.
    ids.push(...(setup.gitOrigin ? (['validate', 'clone', 'index'] as StepId[]) : (['init'] as StepId[])));
    if (hasContextWork(setup)) ids.push('context');
    ids.push('default');
  }
  ids.push('open');
  return ids.map((id) => ({ id, label: STEP_LABELS[id], status: 'idle' }));
}

/**
 * Live per-sandbox info from `ops/status`.
 *
 * An alias, not a second definition: the shape is normalized server-side and
 * declared once in the SDK as `NodeStatus`. It used to be re-typed here, which
 * is how it drifted into being one provider's field set unioned with another's.
 */
export type SandboxDetails = NodeStatus;

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

/**
 * The absolute URL that opens a sandbox's workspace app.
 *
 * The hub owns readiness and authorization: it resumes a paused box, waits for
 * the workspace to answer, and only then redirects. The client names the
 * SERVICE and never a port.
 *
 * Exported so the wire-contract test asserts against the URL production
 * actually navigates to, rather than re-deriving one from copied literals.
 */
export function workspaceServiceUrl(nodeId: string): string {
  const info = new ActionInfo('open-service', ComputeNode.type, nodeId, 'GET');
  info.subpath = WORKSPACE_SERVICE;
  return info.fullActionUrl;
}

/**
 * A ComputeNode is a "sandbox" iff it's an E2B node created from the workspace
 * flavor. Named `isSandbox`, not `isDesktop`: `dataContext.isDesktop` already
 * means "running in Electron", and the two answered different questions under
 * one name.
 *
 * The rule itself lives on the entity (`ComputeNode.isSandbox`) rather than here:
 * it used to read the provider AND a magic string out of the untyped
 * `node_config` blob inline, which meant every surface wanting the question had
 * to know that blob's shape. This wrapper stays because callers and tests import
 * it by name.
 */
export function isSandbox(node: ComputeNode): boolean {
  return node.isSandbox;
}

/**
 * Next auto-name: one past the highest existing box number, so it reads as latest.
 *
 * Matches the legacy "Desktop N" spelling as well as the current one. Boxes
 * created before the rename are still called "Desktop 3", and a regex that only
 * saw "Sandbox N" would restart the count at 1 and hand the user a "Sandbox 1"
 * sitting under a "Desktop 3" they made yesterday. Existing names are left
 * alone — this reads them, it does not rewrite them.
 */
export function nextSandboxName(sandboxes: ComputeNode[]): string {
  let max = 0;
  for (const d of sandboxes) {
    const m = /^(?:Desktop|Sandbox) (\d+)$/.exec(d.name ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Sandbox ${max + 1}`;
}

/**
 * The project a freshly created sandbox is set up with — usually the one the
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
  node: ComputeNode,
  setup: SandboxSetup,
  run: RunStep,
  patch: PatchStep,
): Promise<CloneResult> {
  const cloned = setup.gitOrigin
    ? await cloneSandboxProject(node, setup, run)
    : await run('init', async () => {
        // No repository behind this project — the box mounts it empty, which
        // is still what gives the directory its identity.
        const result = (await node.initEmptyProject(setup.name, setup.projectId ?? '')) as CloneResult;
        if (!result?.project?.id) throw new Error('Setup did not return a project');
        return result;
      });

  const projectId = cloned.project!.id!;
  if (setup.gitOrigin) {
    await run('index', () => node.indexProject(cloned.path, projectId));
  }

  if (hasContextWork(setup)) {
    await run('context', async () => {
      // A declarative install converges its own dependencies through the
      // manifest, so driving them from here too would attach each twice.
      if (setup.install) {
        // The box answers with the reconcile result itself, which is what names
        // the project (and journey) the install wants opened.
        const reconciled = (await node.reconcileManifest(projectId)) as CloneResult['install_result'];
        if (reconciled) cloned.install_result = reconciled;
        patch('context', { detail: 'from the install manifest' });
        return reconciled;
      }
      // What the caller asked for, else what the repo itself declares.
      const contextProjects = setup.contextProjects ?? manifestContextProjects(cloned);
      const attached = await attachContextProjects(node, projectId, contextProjects);
      patch('context', { detail: attached.length ? attached.join(', ') : 'none declared' });
      return attached;
    });
  }

  await run('default', () => node.setDefaultProject(projectId));
  return cloned;
}

/** Ask the box whether the name is free, then have the hub clone into it. */
async function cloneSandboxProject(node: ComputeNode, setup: SandboxSetup, run: RunStep): Promise<CloneResult> {
  await run('validate', async () => {
    const check = (await node.validateProjectName(setup.name)) as NameCheck;
    if (check && check.available === false) {
      throw new Error(`"${setup.name}" already exists — try "${check.suggested}".`);
    }
    return check;
  });

  return run('clone', async () => {
    const result = (await node.cloneProject({
      git_origin: setup.gitOrigin,
      name: setup.name,
      project_id: setup.projectId ?? '',
      ...(setup.install ? { install: setup.install } : {}),
    })) as CloneResult;
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
  node: ComputeNode,
  projectId: string,
  contextProjects: ContextProject[],
): Promise<string[]> {
  const attached: string[] = [];
  for (const ctx of contextProjects) {
    const ctxClone = (await node.cloneProject({
      git_origin: ctx.gitOrigin,
      name: ctx.name,
    })) as CloneResult;
    if (!ctxClone?.path) continue;
    await node.indexProject(ctxClone.path, ctxClone.project?.id ?? '');
    await node.attachContextProject(projectId, ctxClone.path, ctx.scope);
    attached.push(ctx.name);
  }
  return attached;
}

export function useSandboxes() {
  const { user } = useAuth();

  const sandboxesRequest = useMemo(
    () => new QueryRequest({ type: ComputeNode.type, query: null, scope: [], name: 'useSandboxes-nodes' }),
    [],
  );

  const { data: nodes, isLoading, refetch } = useEntitiesQuery<ComputeNode>(sandboxesRequest, { enabled: !!user });

  const sandboxes = useMemo(() => (nodes ?? []).filter(isSandbox), [nodes]);
  // `createSandbox` only needs the list to pick the next auto-name. Reading it
  // through a ref keeps the callback stable across every refetch — including the
  // one it triggers itself — so consumers holding it as a prop don't re-render.
  const sandboxesRef = useRef(sandboxes);
  sandboxesRef.current = sandboxes;

  // ---- live status (probed on load) ----
  const [details, setDetails] = useState<Record<string, SandboxDetails>>({});
  const detailsRef = useRef(details);
  detailsRef.current = details;

  const probeDetails = useCallback(async (node: ComputeNode): Promise<SandboxDetails> => {
    try {
      const res = await node.status();
      return res ?? { status: ExecutionEnvironmentStatus.ERROR };
    } catch {
      return { status: ExecutionEnvironmentStatus.ERROR };
    }
  }, []);

  // Probe only sandboxes we haven't seen yet, and forget ones that vanished —
  // re-probing the whole list on every add/delete would be one call per sandbox.
  useEffect(() => {
    const liveIds = new Set(sandboxes.map((d) => d.id));
    setDetails((prev) => {
      const kept = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
    const fresh = sandboxes.filter((d) => !(d.id in detailsRef.current));
    if (!fresh.length) return;
    void Promise.all(fresh.map(async (d) => [d.id, await probeDetails(d)] as const)).then((entries) =>
      setDetails((prev) => ({ ...prev, ...Object.fromEntries(entries) })),
    );
  }, [sandboxes, probeDetails]);

  // ---- create ----
  const [steps, setSteps] = useState<Step[]>(() => plannedSteps());
  const [creating, setCreating] = useState(false);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const patch = useCallback((id: StepId, next: Partial<Step>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...next } : s)));
  }, []);

  /**
   * Provision a sandbox and set its project up. Does NOT open anything.
   *
   * Separating this from the open is what lets the dialog stay on screen and
   * report what happened: the caller awaits a node, and decides afterwards
   * whether to open it. It also removes the popup-blocker workaround wholesale —
   * nothing here needs to run inside a click gesture any more.
   *
   * Rejects on failure rather than swallowing, so a caller can leave the dialog
   * open with the error visible. The step rows carry the detail.
   */
  const createSandbox = useCallback(
    async (opts?: { name?: string; sandboxProject?: SandboxSetup }): Promise<ComputeNode | null> => {
      // One create at a time per hook instance: a double-clicked button must not
      // provision two boxes the user then has to find and delete.
      if (creatingRef.current) return null;
      const sandboxProject = opts?.sandboxProject;
      // Prefer the workspace scope (hub does workspace.add_child); fall back to
      // owner scope ([]) when hub mode exposes no workspace — the node is still
      // owned by the caller and listed by the role-scoped query.
      const scope = dataContext.workspaceTypeId ? [dataContext.workspaceTypeId] : [];
      creatingRef.current = true;
      setCreating(true);
      setSteps(plannedSteps(sandboxProject));

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
          const draft = new ComputeNode({
            name: opts?.name?.trim() || nextSandboxName(sandboxesRef.current),
            node_config: { flavor: WORKSPACE_FLAVOR },
          });
          await dataManager.save(draft.typeId, scope, hubEntityJson(draft) as never);
          // A bare workspace needs no LM-proxy key, and minting one costs round-trips.
          const providerId = await draft.setup({ skip_lm_proxy: true });
          if (!providerId) throw new Error('setup returned no provider id (provider was dropped)');
          return draft;
        });

        await run('health', async () => {
          const result = await node.workspaceReady();
          if (!result?.healthy) throw new Error('FlowPad did not come up in the sandbox');
          patch('health', {
            detail: result.logged_in ? `signed in as ${result.login_detail}` : 'opened without cloud sign-in',
          });
          // Don't let a failed cloud sign-in pass silently: the sandbox came up, but
          // couldn't reach the hub to sign in (e.g. hub down / WORKSPACE_HUB_URL unset).
          if (!result.logged_in) {
            notify.warning({
              id: 'sandbox-no-signin',
              title: 'Sandbox started without cloud sign-in',
              message:
                "Couldn't reach the hub to sign this sandbox in — it may be down or unreachable. You can sign in from inside the sandbox.",
            });
          }
          return result;
        });

        // Set the git repo up by composing computeNodeTools, one command per step.
        // The HUB clones (its token is the only one that reaches a private repo)
        // and copies the tree in; the box places, indexes and links it. Runs after
        // the box is up so copy_folder has a target.
        if (sandboxProject) await provisionSandboxProject(node, sandboxProject, run, patch);

        await run('open', async () => {
          // Nothing to resolve any more: the link is derived from the node id, and
          // the hub works out host, port, readiness and gate at click time. The row
          // stays so the checklist still ends on a completed line.
          return workspaceServiceUrl(node.id);
        });

        // The just-created sandbox is up — seed its status so the list effect
        // doesn't re-probe it.
        setDetails((s) => ({ ...s, [node.id]: { status: ExecutionEnvironmentStatus.READY } }));
        // Best-effort, and deliberately AFTER the box is usable. The refetch only
        // refreshes the list on the page behind; letting it reject here would
        // report a perfectly good sandbox as a failed create, and — since the
        // caller opens the box with what this returns — would refuse to open a
        // machine that is already running and already paid for.
        try {
          await refetch();
        } catch {
          // The list is stale until the next refresh. The box is not.
        }
        return node;
      } finally {
        creatingRef.current = false;
        setCreating(false);
      }
    },
    [patch, refetch],
  );

  // ---- rename ----
  const renameSandbox = useCallback(
    async (node: ComputeNode, name: string) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === node.name) return;
      await dataManager.save(node.typeId, [], hubEntityJson(node, { name: trimmed }) as never);
      await refetch();
    },
    [refetch],
  );

  // ---- open a sandbox ----
  /**
   * THE way anything here opens a box — a freshly created one and one from the
   * list take the identical path.
   *
   * One navigation to the hub, which owns readiness and authorization: it
   * resumes a paused box and waits for the workspace to answer before
   * redirecting. A client-side probe/resume/navigate sequence cannot — `resume`
   * returning means the VM is back, not that the app is listening.
   *
   * Opened with its final URL inside the click gesture: no blank tab to claim,
   * and no async gap for a popup blocker to catch.
   */
  const openSandbox = useCallback((node: ComputeNode) => {
    window.open(workspaceServiceUrl(node.id), '_blank');
  }, []);

  // ---- delete / terminate ----
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const deleteSandbox = useCallback(
    async (node: ComputeNode) => {
      setDeletingId(node.id);
      try {
        // Shutdown BEFORE delete: it kills the sandbox and revokes the auto-login
        // key (needs the user session). DELETE alone would orphan a live sandbox.
        try {
          await node.shutdown();
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

  /**
   * Create and open in one call, for the callers that genuinely mean "just get
   * me into a box": the /launch and /install landings and `use-ensure-project`.
   *
   * The hub-home dialog deliberately does NOT use this — it wants the two halves
   * apart so it can show the result and let the user choose.
   */
  const launch = useCallback(
    async (opts?: { name?: string; sandboxProject?: SandboxSetup }) => {
      setLaunchUrl(null);
      // Swallows, unlike `createSandbox`. Every caller of this one is
      // fire-and-forget (`void launch(...)`), so a rejection here would surface
      // as an unhandled promise rejection rather than as anything a user sees.
      // The failure is already on screen: the step row carries it. The dialog
      // uses `createSandbox` directly precisely because it CAN await and report.
      let node: ComputeNode | null = null;
      try {
        node = await createSandbox(opts);
      } catch {
        return null;
      }
      if (!node) return null;
      // Published for the landing pages, which render it as a fallback link when
      // the popup was blocked — the one case where the user needs the URL as
      // something to click rather than something we navigated to.
      setLaunchUrl(workspaceServiceUrl(node.id));
      openSandbox(node);
      return node;
    },
    [createSandbox, openSandbox],
  );

  return {
    sandboxes,
    isLoading,
    refetch,
    createSandbox,
    creating,
    launch,
    launchUrl,
    steps,
    openSandbox,
    renameSandbox,
    deleteSandbox,
    deletingId,
    details,
  };
}
