/**
 * UTM parameters from the current URL.
 *
 * Its own module, not part of `FlowSync/auth`: the store needs it, and the store
 * loads inside `APIEntity`'s own import subtree, so pulling `auth` in for it put
 * `APIEntity` in a cycle with itself (`ui/tests/unit/sdk-module-layering.test.ts`).
 */
export function getUtmParams(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key.startsWith('utm_')) {
      utm[key] = value;
    }
  });
  return utm;
}
