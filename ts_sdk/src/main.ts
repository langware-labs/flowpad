import axios from 'axios';
import { dataManager } from './APIEntity';
import apiClient, { getErrorMessages } from './client';
import config from './config';
import { sdkConfig } from './config/index';
import { Agent, ComputeNode, Project, User, Visitor, Workspace } from './entities';
import { AgentHook } from './entities/agent-hook';
import { authManager, dataContext, isTypeId, TypeId } from './FlowSync';
import { snifferManager } from './services/snifferManager';
import { ActionInfo } from './models';
import { navigator } from './services/navigationService';
// import { authService } from './services/authService';
import * as Sentry from '@sentry/browser';
import { ContextEntitiesEnum } from './FlowSync/context';
import { getContextEntityFromLocalStorage, setContextEntityToLocalStorage } from './FlowSync/context-local-storage';
import { cloudManager } from './services/cloud_login';
import { ConnectionManager } from './websocket';

declare global {
  interface Window {
    appReady: boolean;
  }
}

let initPromise: Promise<void> | null = null;

export async function initSdk(params?: { agentId?: string; setupWorkspace?: boolean }): Promise<void> {
  if (initPromise) {
    return initPromise;
  }
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
      // Store bootstrap info in dataContext for UI access (e.g., desktop_info)
      dataContext.bootstrapInfo = bootstrapInfo;

      // Seed cloudManager from bootstrap; it owns isLoggedIn / currentUser / cloudUrl
      // and listens to oauth WS events for the lifetime of the app.
      void cloudManager.bootstrap(bootstrapInfo.desktop_info);

      // Load schemas (pass empty array if null to prevent re-fetching)
      await dataManager.loadSchemas(bootstrapInfo.schemas || []);

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
        const computeNode = new ComputeNode(bootstrapInfo.default_compute_node as any);
        computeNode.markAsExpanded();
        const persistedTypeId = getContextEntityFromLocalStorage(ContextEntitiesEnum.CurrentComputeNodeTypeId);
        if (persistedTypeId && !persistedTypeId.equals(computeNode.typeId)) {
          setContextEntityToLocalStorage(ContextEntitiesEnum.CurrentComputeNodeTypeId, null);
        }
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentComputeNodeTypeId, computeNode.typeId);
      }

      // Register the bootstrap project in cache, but only set it as current
      // if the user doesn't already have a project selected in localStorage.
      const userPersistedProject = getContextEntityFromLocalStorage(ContextEntitiesEnum.CurrentProjectTypeId);
      if (bootstrapInfo.default_project) {
        const project = new Project(bootstrapInfo.default_project);
        project.markAsExpanded();
        if (!userPersistedProject) {
          await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
          dataContext.setWorkdir(project.fs_storage_mount_path ?? null);
        }
      }

      // Set agent in context from params or default agent from bootstrap
      if (params?.agentId) {
        // Params agent ID takes precedence
        console.log('[initSdk] Using agentId from params:', params.agentId);
        await dataContext.setContextEntityTypeId(
          ContextEntitiesEnum.CurrentAgentTypeId,
          new TypeId(Agent.type, params.agentId),
        );
      }

      // Create User instance from bootstrap data FIRST (before workspace)
      // This ensures user is set when refreshWorkspace() is called
      let user: User | null = null;
      if (bootstrapInfo.user) {
        user = new User(bootstrapInfo.user);
        user.markAsExpanded();
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentUserTypeId, user.typeId);
        trackUserToSentry(user);
        void ConnectionManager.getInstance().connect();
      }

      // Set default workspace in context if present (after user is set)
      if (bootstrapInfo.default_workspace) {
        const workspace = new Workspace(bootstrapInfo.default_workspace);
        workspace.markAsExpanded();
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId, workspace.typeId);
      }
      // Register sniffer hook in cache so flow-data messages find it by UUID
      if (bootstrapInfo.sniffer_hook) {
        const snifferHook = new AgentHook(bootstrapInfo.sniffer_hook);
        snifferHook.markAsExpanded();
        await snifferManager.attach(snifferHook);
      }
      dataContext.setSnifferEnabled(!!bootstrapInfo.sniffer_hook);

      await authManager.init(user);
      await dataContext.initContext({ setupWorkspace: params?.setupWorkspace, setupProject: true });
      //await acceptInvitation(url); // TODO Handle this
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
    }
  })();

  return initPromise;
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

export function trackUserToSentry(logged_in: User) {
  //Associate user with Sentry
  Sentry.setUser({
    id: logged_in.id,
  });

  //Add custom tags (for filtering in Sentry UI)
  if (logged_in.id) {
    Sentry.setTag('user.id', logged_in.id);
  }

  //Add breadcrumb for audit trail
  Sentry.addBreadcrumb({
    category: 'auth',
    message: `User logged in: ${logged_in.name}`,
    level: 'info',
    data: {
      id: logged_in.id,
    },
  });
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
