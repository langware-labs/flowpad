/** The domain the hub relays apps on (`<audience>--<uuid>.<env>.flowpad.app`), label by label. */
const APP_DOMAIN = ['flowpad', 'app'];

/**
 * Whether `url` is an app the HUB relays from its machine (a GCP VM's apps: the box publishes no
 * door, so the hub serves it on its own audience host under the app domain).
 *
 * Such an app cannot run inside the display's frame: its host signs the visitor in with a
 * SameSite=Lax cookie on the app domain, another site than the page framing it, and a browser
 * keeps no Lax cookie in a cross-site frame — every load went back to the hub's `open` until the
 * frame gave up ("redirected you too many times"). It opens in a tab of its own instead. A box's
 * own door (an E2B sandbox) signs in with a partitioned SameSite=None cookie and frames as before.
 */
export function isHubRelayed(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const labels = hostname.split('.').reverse();
  return [...APP_DOMAIN].reverse().every((label, i) => labels[i] === label);
}
