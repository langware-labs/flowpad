import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Notion's mark: the N in its rounded frame, monochrome.
 *
 *  Genuinely a monochrome brand — Notion's own logo is black on white — so this
 *  takes `currentColor` and inverts with the theme, the same treatment GitHub's
 *  octocat gets. Registered because the hub publishes `public/notion-icon.svg`,
 *  a path relative to ITS static root: the desktop cannot resolve it, so the
 *  catalogue drew a generic key where the brand should be.
 */
export const NotionIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
    <rect x="2.5" y="2.5" width="19" height="19" rx="3" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M8.4 16.4V8.1l.02-.01 6.4 7.9V7.6"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)) as unknown as LucideIcon;
