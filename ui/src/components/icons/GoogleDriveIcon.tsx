import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Drive's triangle-and-fold mark, monochrome so it inverts with the theme like
 *  every lucide glyph — the house rule the Atlassian and Linear marks follow. */
export const GoogleDriveIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M8.53 2.5h6.94l6.94 12.02-3.47 6.01-6.94-12.02L8.53 2.5z" opacity=".55" />
    <path d="M1.59 14.52 8.53 2.5l3.47 6.01-6.94 12.02-3.47-6.01z" opacity=".8" />
    <path d="M5.06 20.53h13.88l-3.47-6.01H8.53l-3.47 6.01z" />
  </svg>
)) as unknown as LucideIcon;
