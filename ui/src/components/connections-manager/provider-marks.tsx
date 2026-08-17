import { Github } from 'lucide-react';
import * as React from 'react';

/**
 * Bespoke provider marks.
 *
 * Everything else resolves through the existing seam: the backend publishes an
 * icon NAME (`provider_registry.icon`) and `lucideByName` maps it, either to a
 * lucide export (`Github`) or to a registered bespoke glyph in its
 * `CUSTOM_ICONS` table (`ClaudeCode` → the repo's own `ClaudeIcon`). Anthropic
 * showed a generic sparkle because the backend said `"Sparkles"`, not because a
 * mark was missing.
 *
 * Two kinds live here, and the difference is THEME:
 *
 *  - **Multicolour brands** (Slack) must ship their own colours; a
 *    `currentColor` glyph would be wrong at any theme.
 *  - **Monochrome brands** (GitHub) must NOT ship colours: the asset the hub
 *    publishes is a black octocat, which disappears against a dark background.
 *    They map to a `currentColor` lucide glyph so they invert with the theme
 *    like every other icon in the table.
 *
 * A mark here also wins over the hub's published icon path, which is what makes
 * this the place to fix a provider whose asset renders badly.
 */

export type ProviderMark = React.FC<{ className?: string }>;

/** Slack's four-colour mark. */
const SlackMark: ProviderMark = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="#36C5F0"
      d="M9 2.4a2.4 2.4 0 1 0 0 4.8h2.4V4.8A2.4 2.4 0 0 0 9 2.4Zm0 6.4H2.6a2.4 2.4 0 1 0 0 4.8H9a2.4 2.4 0 0 0 0-4.8Z"
    />
    <path
      fill="#2EB67D"
      d="M21.6 11.2a2.4 2.4 0 1 0-4.8 0v2.4h2.4a2.4 2.4 0 0 0 2.4-2.4Zm-6.4 0V4.8a2.4 2.4 0 1 0-4.8 0v6.4a2.4 2.4 0 0 0 4.8 0Z"
    />
    <path
      fill="#ECB22E"
      d="M15 21.6a2.4 2.4 0 1 0 0-4.8h-2.4v2.4A2.4 2.4 0 0 0 15 21.6Zm0-6.4h6.4a2.4 2.4 0 1 0 0-4.8H15a2.4 2.4 0 0 0 0 4.8Z"
    />
    <path
      fill="#E01E5A"
      d="M2.4 12.8a2.4 2.4 0 1 0 4.8 0v-2.4H4.8a2.4 2.4 0 0 0-2.4 2.4Zm6.4 0v6.4a2.4 2.4 0 1 0 4.8 0v-6.4a2.4 2.4 0 0 0-4.8 0Z"
    />
  </svg>
);

/** GitHub's mark is monochrome — take the theme's foreground colour. */
const GithubMark: ProviderMark = ({ className }) => <Github className={className} aria-hidden="true" />;

const MARKS: Record<string, ProviderMark> = { slack: SlackMark, github: GithubMark };

/** The bespoke mark for a provider, or `null` — callers then fall back to the
 *  backend's published icon name. */
export function providerMark(providerName: string | undefined): ProviderMark | null {
  return MARKS[(providerName || '').trim().toLowerCase()] ?? null;
}
