/**
 * The identity of a pooled app VIEW (docs/navigation/dock-loading.md, I6): which host shows it,
 * which app, at which route. The runtime preference (`?runtime=`) and the scope/passthrough
 * options are not part of it — they re-point the same view, they do not fork one. The host is:
 * two Vibe sessions showing the same app each get a view of their own, with their own epoch.
 */
export function appViewKey(hostProcessId: string | null | undefined, appTypeId: string, route?: string | null): string {
  return `app:${hostProcessId ?? ''}:${appTypeId}:${route ?? ''}`;
}
