import { runInAction } from 'mobx';
import { config } from '../config';
import { dataContext, isTypeId, TypeId } from '../FlowSync';
import { isHubOnly } from '../utils/hub-runtime';
import { cloudManager } from './cloud_login';
import { resolveLoginCallbackUrl } from './login_callback';
import { secretsService } from './secrets-service';
import { secretApprovalGate } from './secretApprovalGate';

export type BootstrapErrorType = 'config' | 'network' | 'server';

export interface BootstrapError {
  message: string;
  status: number;
  type: BootstrapErrorType;
}

/**
 * Hardcoded dock keyword - appears in URL as /dock/...
 * Not flexible by design for security, validation, and clarity
 */
export const DOCK_KEYWORD = 'dock' as const;

class Navigator {
  potentialTypeId(url: string) {
    // Skip micro-app URLs (they have their own routing)
    if (url.includes('/api/v1/graph/micro_app/')) {
      return null;
    }

    // Extract last type and id from URL, handling subpath prefix, DOCK_KEYWORD suffix, trailing slash, and any even number of intermediate path segments
    const match = url.match(
      new RegExp(`^${config.SUBPATH}/(?:[^/]+/[^/]+/)*([^/]+)/([^/]+)(?:/${DOCK_KEYWORD}/.*)?/?$`),
    );
    if (!match) {
      return null;
    }

    const potentialTypeId = `${match[1]}${TypeId.DELIMITER}${match[2]}`;

    if (!isTypeId(potentialTypeId)) {
      console.warn('Ignoring invalid url path', url);
      return null;
    }
    return new TypeId(potentialTypeId);
  }

  // Function to append multiple query parameters to a URL
  appendParams(baseUrl: string, params: Record<string, string | undefined>): string {
    const filteredParams = Object.entries(params).filter(([, value]) => value !== undefined);
    if (filteredParams.length === 0) {
      return baseUrl;
    }
    const queryString = filteredParams
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value!)}`)
      .join('&');
    return `${baseUrl}?${queryString}`;
  }

  getLoginWithCallbackUrl(loginCallbackUrl: string = window.location.href, connection?: string): string {
    const targetUrl = resolveLoginCallbackUrl(loginCallbackUrl);
    return this.appendParams(`${config.SERVER_URL}${config.API_PREFIXES.login}`, {
      target_path: targetUrl,
      connection,
    });
  }

  async navigateToLogin(_loginCallbackUrl: string = window.location.href, _connection?: string): Promise<void> {
    if (!isHubOnly() && !(await this.ensureSecretsEnabled())) return;
    void dataContext.setActiveEntityTypeId(null);
    // cloudManager handles env-mode vs system-browser-mode internally.
    // The connection param is ignored — the cloud's login form handles provider choice.
    try {
      await cloudManager.login();
    } catch (err) {
      console.warn('[navigateToLogin] login failed:', err);
    }
  }

  private async ensureSecretsEnabled(): Promise<boolean> {
    try {
      const initial = await secretsService.isEnabled();
      if (initial?.enabled) return true;
    } catch {
      // If the probe fails (offline, server down) fall through to provisioning;
      // request()'s own enable() call will surface the same error.
    }

    const approved = await secretApprovalGate.request();
    if (!approved) return false;

    // request() already provisioned secrets; re-verify before redirecting in
    // case the OS denied the keychain prompt despite the provisioning call.
    try {
      const verified = await secretsService.isEnabled();
      return Boolean(verified?.enabled);
    } catch {
      return false;
    }
  }

  navigateToLogout(_returnToUrl: string = window.location.origin) {
    void dataContext.setActiveEntityTypeId(null);
    void cloudManager.logout();
  }

  navigateToLanding(shouldReload: boolean = false) {
    const url = `${config.SUBPATH}/`;
    void dataContext.setActiveEntityTypeId(null);
    // Note: Components should use React Router's useNavigate() to update the URL
    // This method only updates dataContext. For URL updates, use navigate('/') in components.
    if (shouldReload) {
      document.location.replace(url);
    }
  }

  navigateBack() {
    history.back();
  }

  /**
   * Set a bootstrap error to be displayed by the UI
   * @param message - Error message to display
   * @param status - HTTP status code (0 for config errors)
   * @param type - Error type: 'config' | 'network' | 'server'
   */
  error(message: string, status: number = 0, type: BootstrapErrorType = 'server') {
    runInAction(() => {
      dataContext.bootstrapError = { message, status, type } as any;
      dataContext.isBootstrapping = false;
    });
  }

  private normalizeScope(scope?: TypeId | TypeId[]): TypeId[] {
    if (!scope) {
      return [];
    }
    const scopeList = Array.isArray(scope) ? scope : [scope];
    return scopeList.filter((scopeId): scopeId is TypeId => Boolean(scopeId));
  }

  /**
   * Get the URL path for a TypeId (for use with React Router navigation)
   * Returns path WITHOUT basename since React Router handles basename automatically
   */
  getUrlPath(typeId: TypeId | null, scope?: TypeId | TypeId[]): string {
    if (!typeId || !typeId.type || !typeId.id) {
      return '/';
    }
    const scopeSegments = this.normalizeScope(scope).map((scopeId) => scopeId.toUrlString());
    const allSegments = [...scopeSegments, typeId.toUrlString()];
    return `/${allSegments.join('/')}`;
  }

  async navigate(typeId: TypeId, scope?: TypeId | TypeId[]) {
    await dataContext.setActiveEntityTypeId(typeId);
    const urlPath = this.getUrlPath(typeId, scope);
    if (history.length > 1) {
      history.pushState({ url: urlPath }, '', urlPath);
    } else {
      history.replaceState({ url: urlPath }, '', urlPath);
    }
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  async popState(url: string) {
    await this.setActiveEntityByPath(url);
  }

  private async setActiveEntityByPath(urlPath: string): Promise<boolean> {
    const potentialTypeId = this.potentialTypeId(urlPath);
    if (potentialTypeId) {
      await dataContext.setActiveEntityTypeId(potentialTypeId);
      return true;
    } else {
      await dataContext.setActiveEntityTypeId(null);
      return false;
    }
  }

  checkAndRemoveQueryParam(queryParam: string) {
    const url = new URL(document.location.href);
    const searchParams = url.searchParams;
    const hasQueryParam = searchParams.has(queryParam);
    if (hasQueryParam) {
      this.removeQueryParam(window.location.href, queryParam);
    }
    return hasQueryParam;
  }

  removeQueryParam(urlPath: string, paramName: string = '') {
    const url = new URL(urlPath);

    if (paramName) {
      // Remove a specific query parameter
      url.searchParams.delete(paramName);
    } else {
      // Remove all query parameters
      for (const key of url.searchParams.keys()) {
        url.searchParams.delete(key);
      }
    }
    urlPath = url.href;
    // Use window.history.replaceState directly (React Router will sync automatically)
    window.history.replaceState(null, '', urlPath);
  }
}

export const navigator = new Navigator();

export default navigator;
