import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Linear's mark, in its own indigo (#5E6AD2) — see `AtlassianIcon` for why a
 *  brand that HAS a colour wears it. */
export const LinearIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="#5E6AD2" aria-hidden="true" {...props}>
    <path d="M2.06 13.6a10 10 0 0 0 8.34 8.34L2.06 13.6zm-.06-2.9 11.3 11.3a10 10 0 0 0 2.3-.6L2.6 8.4a10 10 0 0 0-.6 2.3zm1.4-4.4 14.3 14.3a10 10 0 0 0 1.6-1.2L4.6 4.7a10 10 0 0 0-1.2 1.6zm2.5-3L20.7 18.1A10 10 0 1 0 5.9 3.3z" />
  </svg>
)) as unknown as LucideIcon;
