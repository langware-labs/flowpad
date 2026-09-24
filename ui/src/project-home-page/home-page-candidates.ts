import type { AssetDescriptor } from '@sdk';

/** Windows paths compare case-insensitively; a drive-lettered or UNC root is one. */
function comparable(path: string): string {
  const posix = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^(?:[A-Za-z]:\/|\/\/)/.test(posix) ? posix.toLowerCase() : posix;
}

/**
 * Whether the picker may offer `descriptor` as `roots`' project home page.
 *
 * The same boundary the backend enforces (`Project.open_home_page` →
 * `assets_under_roots(direct_context_roots)`), and `roots` is its API mirror
 * (`Project.context_roots`): the project folder or one of its direct context
 * folders. Offering anything else would let the user pick an asset that Home
 * then silently ignores. A row with no TypeId (an unindexed file) has nothing
 * the home-page file could hold, so it is not offered either.
 */
export function isHomePageCandidate(descriptor: AssetDescriptor, roots: readonly string[]): boolean {
  if (!descriptor.typeid || !descriptor.posix_path) return false;
  const path = comparable(descriptor.posix_path);
  return roots.some((root) => {
    const dir = comparable(root);
    return !!dir && path.startsWith(`${dir}/`);
  });
}
