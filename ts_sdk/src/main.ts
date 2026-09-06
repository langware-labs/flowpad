import { prefetchStartupAssets } from './lazy/startup';
import { lazyAssets, LazyAsset } from './lazy';
import axios from 'axios';
import { dataManager } from './APIEntity';
import apiClient, { getErrorMessages } from './client';
import config from './config';
import { sdkConfig } from './config/index';
import { SubAgent, ComputeNode, Project, User, Visitor, Workspace } from './entities';
import { loadIconPacks } from './icons/registry';
import type { IconPackSpec } from './icons/types';
import { authManager, dataContext, isTypeId, TypeId } from './FlowSync';
import { snifferManager } from './services/snifferManager';
import { markHubModeReady, setSupportedPagesForHubMode } from './utils/hub-runtime';
import { RuntimeKind } from './utils/runtime';
import { ActionInfo } from './models';
import { navigator } from './services/navigationService';
// import { authService } from './services/authService';
import { ContextEntitiesEnum } from './FlowSync/context';
import { getContextEntityFromLocalStorage, setContextEntityToLocalStorage } from './FlowSync/context-local-storage';
import { capabilityManager } from './capabilities';
import { cloudManager } from './services/cloud_login';
import { privacyManager } from './services/privacy_mode';
import { ConnectionManager } from './websocket';
import type { BootstrapInfo } from './models/BootstrapInfo';

declare global {
  interface Window {
    appReady: boolean;
    /** Introspection hooks for manual_regression specs; see initSdk. */
    context?: typeof dataContext;
    sniffer?: typeof snifferManager.entity;
  }
}

let initPromise: Promise<void> | null = null;
let asyncInitPromise: Promise<void> | null = null;
let initialized: BootstrapInfo | undefined;
let setupWorkspace = false;

export async function initSdk(params?: { agentId?: string; setupWorkspace?: boolean }): Promise<void> {
  if (initPromise) {
    return initPromise;
  }
  setupWorkspace = params?.setupWorkspace === true;
  performance.mark?.('sdk:init:start');
  initPromise = (async () => {
    try {
      // Check if API port is properly configured
      if (!sdkConfig.api_port || isNaN(sdkConfig.api_port)) {
        navigator.error('Config error: Missing service port', 0, 'config');
        return;
      }

      const domain = window.location.hostname;
      const session = !(window as any).allow_persistent_visitor; // session=true if no GDPR consent
      const bootstrapInfo = await dataManager.bootstrap(domain, session);
      // Dev override: `VITE_FORCE_HUB=true` forces hub mode when testing the OSS
      // UI against a hub backend that doesn't yet declare its runtime. Set it ON
      // bootstrapInfo so EVERY consumer agrees — the leaf `isHubOnly()` signal,
      // `dataContext.runtimeKind`, and main-loader's page-redirect (which reads
      // `bootstrapInfo.supported_pages` directly). No effect in normal builds.
      if (import.meta.env.VITE_FORCE_HUB === 'true') {
        (bootstrapInfo as { supported_pages?: string[] }).supported_pages = ['hub'];
        bootstrapInfo.runtime = { ...bootstrapInfo.runtime, kind: RuntimeKind.HUB };
      }
      // Store bootstrap info in dataContext for UI access (e.g., desktop_info)
      dataContext.bootstrapInfo = bootstrapInfo;
      // Seed the leaf hub-mode signal (so `isHubOnly()` works without importing
      // dataContext into entities — see utils/hub-runtime.ts).
      setSupportedPagesForHubMode((bootstrapInfo as { supported_pages?: string[] })?.supported_pages);

      // Known identity and privacy are required for the first render. No probes
      // or subscriptions run here; asyncSdkInit owns those after UI paint.
      await cloudManager.seedBootstrap(bootstrapInfo);
      privacyManager.seedBootstrap(bootstrapInfo.privacy_mode);


      // Load the type registry (TypeInfo + schema) into the SchemaRegistry
      // (pass empty array if null to prevent re-fetching)
      await dataManager.loadTypes(bootstrapInfo.types || []);

      // The icon vocabulary rides the same payload as the types that reference
      // it: a `TypeInfo.icon` name is only renderable if the pack it lives in
      // is loaded too, so the two are seeded together or not at all.
      loadIconPacks((bootstrapInfo as { icon_packs?: IconPackSpec[] }).icon_packs);

      // Set domain in context if present
      if (bootstrapInfo.domain) {
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentDomainTypeId, bootstrapInfo.domain.typeId);
      }

      // Set visitor in context if present (visitor object is returned, cookie already set by backend)
      if (bootstrapInfo.visitor) {
        const visitor = new Visitor(bootstrapInfo.visitor);
        visitor.markAsExpanded();
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentVisitorTypeId, visitor.typeId);
      }

      // Set default compute node from bootstrap before project — so refreshProject() skips the fetch.
      // Compute_node ids are minted per-process by get_or_create_local_compute_node and rotate
      // every time the dev DB is recreated (/tmp/flowpad_dev.db). Evict any persisted
      // CurrentComputeNodeTypeId that doesn't match the bootstrap-issued id BEFORE the new id
      // is applied, so callers that read localStorage directly don't issue requests against
      // a dead UUID.
      if (bootstrapInfo.default_compute_node) {
        const persistedTypeId = getContextEntityFromLocalStorage(ContextEntitiesEnum.CurrentComputeNodeTypeId);
        // Constructors register in cache. Evict old aliases BEFORE adopting the seed.
        dataManager.removeEntityFromCache(new TypeId('compute_node', '@local'));
        if (persistedTypeId) dataManager.removeEntityFromCache(persistedTypeId);
        const computeNode = new ComputeNode(bootstrapInfo.default_compute_node as any);
        computeNode.markAsExpanded();
        if (persistedTypeId && !persistedTypeId.equals(computeNode.typeId)) {
          setContextEntityToLocalStorage(ContextEntitiesEnum.CurrentComputeNodeTypeId, null);
        }
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentComputeNodeTypeId, computeNode.typeId);
      }

      // Route loaders own active-project selection; retain the full default in
      // cache so a URL or remembered/default fallback needs no extra request.
      if (bootstrapInfo.default_project) {
        const project = new Project(bootstrapInfo.default_project);
        project.markAsExpanded();
      }

      // Set agent in context from params or default agent from bootstrap
      if (params?.agentId) {
        // Params agent ID takes precedence
        console.log('[initSdk] Using agentId from params:', params.agentId);
        await dataContext.setContextEntityTypeId(
          ContextEntitiesEnum.CurrentAgentTypeId,
          new TypeId(SubAgent.type, params.agentId),
        );
      }

      // Create User instance from bootstrap data FIRST (before workspace)
      // This ensures user is set when refreshWorkspace() is called
      let user: User | null = null;
      if (bootstrapInfo.user) {
        user = new User(bootstrapInfo.user);
        user.markAsExpanded();
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.LocalUserTypeId, user.typeId);
      }

      // Set default workspace in context if present (after user is set)
      if (bootstrapInfo.default_workspace) {
        const workspace = new Workspace(bootstrapInfo.default_workspace);
        workspace.markAsExpanded();
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId, workspace.typeId);
      }
      await authManager.init(user);
      capabilityManager.setSummary(bootstrapInfo.capabilities_summary);
      await dataContext.initContext();
      //await acceptInvitation(url); // TODO Handle this
      // Expose introspection hooks for manual_regression specs (and for
      // hands-on debugging). ``window.context`` mirrors the dataContext
      // singleton so specs can read ``window.context.snifferHook``,
      // ``window.context.snifferEnabled``, ``window.context.bootstrapInfo``,
      // etc.; ``window.sniffer`` is shorthand for the SnifferManager's
      // attached entity, exposing its flowDataStream for event-count
      // assertions.
      try {
        window.context = dataContext;
        window.sniffer = snifferManager.entity;
      } catch {
        // ignore — non-browser env
      }
      initialized = bootstrapInfo;
      performance.mark?.('sdk:init:ready');
      window['appReady'] = true;
    } catch (error: any) {
      console.error('initSdk error:', error);

      // Extract error details for display
      const status = error?.response?.status || error?.status || 500;
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.detail ||
        error?.message ||
        'Failed to connect to backend server';

      // Determine error type
      const isNetworkError =
        status === 503 || error?.code === 'ERR_NETWORK' || error?.code === 'ERR_CONNECTION_REFUSED';
      const errorType = isNetworkError ? 'network' : 'server';

      // Set bootstrap error for UI to display
      navigator.error(`Bootstrap failed: ${message}`, status, errorType);
      // Don't throw - let the UI handle this gracefully
      // Reset initPromise to allow retry
      initPromise = null;
      return;
    } finally {
      // Unblock any early desktop-only probe awaiting the hub-mode signal, even
      // if bootstrap failed / early-returned before seeding it (keeps the desk
      // fallback so desk probes still run).
      markHubModeReady();
    }
  })();

  // ONE init flow. The optional half used to be the caller's job, and a caller
  // that did not know to run it got no live channel at all: `watchQuery`
  // registers a watch, nothing ever opens the socket that pushes to it, and the
  // page looks healthy while never updating. That is what happened to every
  // served micro-app -- `initSdk()` is the entry point its template documents,
  // and there is no paint phase or router there to own a second step.
  //
  // Scheduled, never awaited: awaiting it here would serialise the optional half
  // into the critical path and destroy the boot win this split exists for. A
  // consumer that wants it sooner (the UI, after paint) still calls
  // `asyncSdkInit()` itself -- `asyncInitPromise ??=` makes that the SAME single
  // invocation, not a second one.
  void initPromise.then(scheduleAsyncSdkInit);

  return initPromise;
}

/**
 * Run `asyncSdkInit` once the caller is idle.
 *
 * `requestIdleCallback` yields to rendering by design, so the optional half
 * lands after first paint without picking an arbitrary delay. `setTimeout` is
 * the fallback (Safari) rather than `requestAnimationFrame`, which never fires
 * in a background tab -- a micro-app opened in a hidden tab would otherwise
 * never initialise.
 */
function scheduleAsyncSdkInit(): void {
  const run = () => {
    void asyncSdkInit();
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (typeof idle === 'function') idle(run);
  else setTimeout(run, 0);
}

/** Optional services. The mounted UI calls this after paint; never await it in a loader. */
export function asyncSdkInit(): Promise<void> {
  return asyncInitPromise ??= (async () => {
    await initSdk();
    if (!initialized) {
      asyncInitPromise = null;
      return;
    }
    performance.mark?.('sdk:async:start');
    const run = async (name: string, job: () => Promise<unknown>) => {
      performance.mark?.(`sdk:async:${name}:start`);
      try {
        await job();
      } catch (error) {
        console.warn(`[asyncSdkInit] ${name} unavailable`, error);
      } finally {
        performance.mark?.(`sdk:async:${name}:settled`);
      }
    };
    await Promise.all([
      run('info', () => lazyAssets.load(LazyAsset.RuntimeInfo)),
      run('cloud-status', () => lazyAssets.load(LazyAsset.CloudStatus)),
      run('assets', prefetchStartupAssets),
      run('index-activity', async () => {
        const { systemTools } = await import('./services/system-tools-service');
        await systemTools.refreshActivityStatus(false);
      }),
      run('live', async () => {
        await Promise.all([
          run('cloud-listeners', () => cloudManager.startSubscriptions()),
          run('privacy-listeners', () => privacyManager.startSubscriptions()),
        ]);
        if (dataContext.user) await ConnectionManager.getInstance().connect();
      }),
      ...(setupWorkspace ? [run('workspace', () => dataContext.setupWorkspace())] : []),
    ]);
    performance.mark?.('sdk:async:settled');
  })();
}

// @ts-ignore - Intentionally unused, reserved for future use
async function _acceptInvitation(url: URL): Promise<TypeId | undefined> {
  try {
    const invitationId = url.searchParams.get('invitation-id');
    if (invitationId) {
      const queryParams = { 'invitation-id': invitationId };
      const invited_target_typeid: TypeId | undefined = await accept(queryParams);
      if (!invited_target_typeid) {
        throw new Error('Invalid response from accept');
      }
      if (isTypeId(invited_target_typeid)) {
        const invited_target_typeid_to_redirect: TypeId = new TypeId(invited_target_typeid);
        await dataContext.setActiveEntityTypeId(invited_target_typeid_to_redirect);
        return invited_target_typeid;
      } else {
        throw new Error('Invalid type id: ' + invited_target_typeid.toString());
      }
    }
  } catch (error: any) {
    const msg = error.message ?? 'Invitation could not be accepted';
    console.error(msg);
  }
}
async function accept(queryParams: any): Promise<TypeId | undefined> {
  try {
    const actionInfo = new ActionInfo('members/accept', '', undefined, 'GET');
    actionInfo.queryParameters = queryParams;
    return await dataManager.callAction<any, TypeId>(actionInfo);
  } catch (error) {
    console.error('Failed to accept', error);
    return undefined;
  }
}

export interface SignupInfo {
  name: string;
  email: string;
  password: string;
}

export async function signup(signup: SignupInfo): Promise<User> {
  const entity_json: any = await apiClient.post(`${config.API_PREFIXES.signup}`, signup);
  if (!entity_json) {
    throw new Error('Failed to signup');
  }
  return new User(entity_json);
}

export async function getErrorMessagesFromAxios(error: any): Promise<string> {
  if (axios.isAxiosError(error)) {
    return getErrorMessages(error);
  }
  return error.message || '';
}

if (window && window.console) {
  (window as any).signup = signup;
  (window as any).config = config;
  (window as any).apiClient = apiClient;
  (window as any).dataManager = dataManager;
}

export function simpleTextLexicalJson(text: string): any {
  return {
    root: {
      children: [
        {
          children: [{ text: text, type: 'text', version: 1 }],
          format: '',
          type: 'paragraph',
          version: 1,
          textStyle: '',
        },
      ],
      type: 'root',
      version: 1,
    },
  };
}
