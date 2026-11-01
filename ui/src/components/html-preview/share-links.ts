import { OPEN_EXTERNAL_MESSAGE } from '@sdk/apps/host';
import { openExternal } from '@src/lib/open-external';

/**
 * Where a previewed page may ask the host to send someone: a page's own "share" menu
 * (send on WhatsApp, a Gmail or Outlook draft, the computer's mail app). Nothing else.
 *
 * The preview frame stays sandboxed, and a window it opens inherits the sandbox — which
 * WhatsApp and Gmail refuse to load in (`ERR_BLOCKED_BY_RESPONSE`); a sandboxed frame may
 * not hand a `mailto:` to the mail app either. Escaping the sandbox for every popup
 * (`allow-popups-to-escape-sandbox`) would hand an agent-written page an unsandboxed window
 * on any site; this closed list is the whole of what the host opens on a page's behalf instead.
 */
const SHARE_HOSTS = new Set([
  'wa.me',
  'api.whatsapp.com',
  'web.whatsapp.com',
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
]);

/** The share link a previewed page asks the host to open (`{type: 'flowpad:open-external', url}`), or null. */
export function previewShareUrl(data: unknown): string | null {
  const message = data as { type?: unknown; url?: unknown } | null;
  if (message?.type !== OPEN_EXTERNAL_MESSAGE || typeof message.url !== 'string') return null;
  try {
    const url = new URL(message.url);
    if (url.protocol === 'mailto:') return url.href;
    return url.protocol === 'https:' && SHARE_HOSTS.has(url.hostname) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Open a share link: a site in the person's browser, a `mailto:` in their mail app. */
export function openShareLink(url: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desktop = (window as any).electronAPI;
  if (url.startsWith('mailto:') && !desktop?.openExternal) {
    // A top-level window hands a mailto: to the mail app without leaving the page.
    window.location.href = url;
    return;
  }
  openExternal(url);
}
