import { CredentialsSubview } from '@sdk';

/** The retired view types, in URL form, mapped to the tab that replaced them. */
const RETIRED_VIEWS: Record<string, CredentialsSubview> = {
  environment: CredentialsSubview.ENVIRONMENT,
  connections: CredentialsSubview.CONNECTIONS,
  'api-keys': CredentialsSubview.API_KEYS,
};

const RETIRED_PATH = new RegExp(`^(.*/(?:dock|dev|win))(/hub)?/(${Object.keys(RETIRED_VIEWS).join('|')})(?:/.*)?/?$`);

/**
 * Collapse the three retired credential view types into the one Credentials
 * grammar: `/dock[/hub]/credentials/<subview>`.
 *
 * `environment`, `connections`, and `api-keys` used to be sibling view types
 * rendering the same three components as this view's tabs — four doors onto one
 * room, each with its own active-state and framing rules. They survive only as
 * decodable URLs so old links, bookmarks, and saved tabs keep working, the same
 * way `atlas` survives for WorldView.
 *
 * Pure, and the root loader owns the redirect, so a mounted view only ever
 * observes canonical URL state. Any trailing segment is dropped: none of the
 * three ever carried a pointer, so there is nothing to preserve — but the query
 * string is, since it may hold unrelated dock options.
 */
export function canonicalCredentialsDockPath(pathname: string, search: string): string | null {
  const match = pathname.match(RETIRED_PATH);
  if (!match) return null;

  const [, prefix, hub = '', retired] = match;
  return `${prefix}${hub}/credentials/${RETIRED_VIEWS[retired]}${search}`;
}
