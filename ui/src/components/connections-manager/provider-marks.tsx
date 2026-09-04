import { Github } from 'lucide-react';
import * as React from 'react';

import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { GoogleDriveIcon } from '@src/components/icons/GoogleDriveIcon';
import { NotionIcon } from '@src/components/icons/NotionIcon';
import { cn } from '@src/lib/utils';

/**
 * Bespoke provider marks — the connection surfaces' own override.
 *
 * Everything else resolves through the existing seam: the backend publishes an
 * icon NAME (`provider_registry.icon`) and `lucideByName` maps it, either to a
 * lucide export (`Github`) or to a registered bespoke glyph in its
 * `CUSTOM_ICONS` table. A mark here WINS over that, which is what makes this
 * the place to fix a provider whose published asset renders badly.
 *
 * **Colour belongs in the glyph, not at the call site.** That is `SlackIcon`'s
 * rule and it is why most brands need no entry here at all: Atlassian, Linear,
 * Drive, GitLab and Microsoft each carry their own colour in `CUSTOM_ICONS`, so
 * every surface that renders a provider gets it for free. Only two cases land
 * here:
 *
 *  - **A brand that is genuinely monochrome** (GitHub). Its published asset is a
 *    black octocat, which disappears against a dark background; mapping it to a
 *    `currentColor` lucide glyph makes it invert with the theme.
 *  - **A provider whose published asset does not resolve** (Google Drive). The
 *    hub publishes a path relative to ITS OWN static root, so the name fails
 *    `isLucideName` and the catalogue drew a generic key — a tile that says "no
 *    icon found" on the one screen whose job is telling providers apart. The
 *    mark wins over the path, which is what this table is for.
 *  - **A glyph shared with another meaning** (Anthropic). `ClaudeIcon` is also
 *    the Claude *harness* glyph, which the terminal strip tints per vendor —
 *    so the brand colour cannot be baked into the component without overriding
 *    a tint that means something else. Applying it here scopes Anthropic's own
 *    clay to the connection surfaces and leaves the strip alone.
 */

export type ProviderMark = React.FC<{ className?: string }>;

/** GitHub's mark is monochrome — take the theme's foreground colour. */
const GithubMark: ProviderMark = ({ className }) => <Github className={className} aria-hidden="true" />;

/** Anthropic's own clay, on the shared Claude glyph. */
const AnthropicMark: ProviderMark = ({ className }) => (
  <ClaudeIcon className={cn('text-[#D97757]', className)} aria-label="Anthropic" />
);

const DriveMark: ProviderMark = ({ className }) => <GoogleDriveIcon className={className} aria-hidden="true" />;

/** Notion, for the same reason as Drive: the hub publishes a path, not a name. */
const NotionMark: ProviderMark = ({ className }) => <NotionIcon className={className} aria-hidden="true" />;

const MARKS: Record<string, ProviderMark> = {
  github: GithubMark,
  anthropic: AnthropicMark,
  // Both spellings: `google` is the local provider (one grant covering Drive and
  // Cloud Storage), `googledrive` the hub's plugin for the same brand.
  google: DriveMark,
  googledrive: DriveMark,
  notion: NotionMark,
};

/** The bespoke mark for a provider, or `null` — callers then fall back to the
 *  backend's published icon name. */
export function providerMark(providerName: string | undefined): ProviderMark | null {
  const name = (providerName || '').trim().toLowerCase();
  // A credential definition names the same brand with a suffix
  // (`anthropic-key`), and the catalogue shows both tiles side by side — one
  // clay, one white, for one company. The suffix says which KIND of credential
  // it is, never which brand, so it is not part of the lookup.
  return MARKS[name] ?? MARKS[name.replace(/[-_]key$/, '')] ?? null;
}
