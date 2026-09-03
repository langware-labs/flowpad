import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Atlassian's mark, monochrome so it inverts with the theme like every lucide glyph. */
export const AtlassianIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M7.12 10.86a.68.68 0 0 0-1.16.12L.07 22.76a.7.7 0 0 0 .63 1.02h8.2a.68.68 0 0 0 .63-.39c1.77-3.66.7-9.22-2.41-12.53z" />
    <path d="M11.43.36a15.53 15.53 0 0 0-.9 15.33l3.95 7.7a.7.7 0 0 0 .63.39h8.2a.7.7 0 0 0 .63-1.02L12.63.38a.67.67 0 0 0-1.2-.02z" />
  </svg>
)) as unknown as LucideIcon;
