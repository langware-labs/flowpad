/** HTTP page addresses share the web-app viewer, with one identity per URL. */
export function webUrlFromPointer(pointer: string | null | undefined): string | null {
  if (!pointer?.startsWith('url/')) return null;
  try {
    const encoded = pointer.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    const url = new URL(decodeURIComponent(atob(encoded)));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function pointerForWebUrl(url: string): string {
  // Base64url survives the dock's URL and persisted-JSON decode paths unchanged.
  const encoded = btoa(encodeURIComponent(new URL(url).href)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const pointer = `url/${encoded}`;
  if (!webUrlFromPointer(pointer)) throw new Error('Unsupported web URL');
  return pointer;
}
