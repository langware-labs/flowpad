import { dataManager } from '../..';

const OAUTH_URL_REGEX = /https:\/\/(console\.anthropic\.com|claude\.ai)\/oauth\/authorize\?[^\s]+/;
const openedUrls = new Set<string>();

function handlePtyOutput(event: { shellId: string; data: string }): void {
  const match = event.data.match(OAUTH_URL_REGEX);
  if (!match) return;
  const oauthUrl = match[0];
  if (openedUrls.has(oauthUrl)) return;
  openedUrls.add(oauthUrl);
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.openExternal) {
    electronAPI.openExternal(oauthUrl);
  } else {
    window.open(oauthUrl, '_blank');
  }
}

export function initClaudeOAuthHandler(): void {
  dataManager.on('on_pty_decoded', (shellId: string, data: string) => {
    handlePtyOutput({ shellId, data });
  });
  console.debug('[ClaudeOAuthHandler] Initialized');
}
