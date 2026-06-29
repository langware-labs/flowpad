import { DockPointer } from '@src/navigation/DockPointer';

// Anchored to structural positions in the URL — the substring `/dock/` can
// legitimately appear inside paths like `/docs/dock-faq.html` and must NOT
// be treated as a dock route. Recognized shapes:
//   /dock/...                                      (root dock)
//   /dev/...                                       (root dev)
//   /agent/<id>/dock/...                           (agent-scoped)
//   /agent/<id>/dev/...
//   /agent/<id>/flow/<id>/dock/...                 (flow-scoped)
//   /agent/<id>/flow/<id>/dev/...
const INTERNAL_DOCK_RE =
  /^\/(dock|dev)(\/|$)|^\/agent\/[^/]+(\/flow\/[^/]+)?\/(dock|dev)(\/|$)/;

/** True if the URL is a Flowpad-internal dock route (handled in-app, not via window.open). */
export function isInternalDockUrl(url: string): boolean {
  try {
    const u = url.startsWith('/') ? new URL(url, window.location.origin) : new URL(url);
    if (u.origin !== window.location.origin) return false;
    return INTERNAL_DOCK_RE.test(u.pathname);
  } catch {
    return false;
  }
}

/** Convert a /dock/... URL into a DockPointer the host can navigate to. */
export function parseDockUrlToPointer(url: string): DockPointer | null {
  let parsedUrl: URL;
  try {
    parsedUrl = url.startsWith('/') ? new URL(url, window.location.origin) : new URL(url);
  } catch {
    return null;
  }
  try {
    return DockPointer.fromUrl(`${parsedUrl.pathname}${parsedUrl.search}`);
  } catch {
    return null;
  }
}
