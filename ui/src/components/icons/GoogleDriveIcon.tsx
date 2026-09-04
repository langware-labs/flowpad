import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Drive's triangle-and-fold mark, in Drive's own three colours.
 *
 *  The geometry is unchanged; only the fills are. It was drawn in one colour at
 *  three opacities, which reads as a grey wedge next to Slack's four-colour mark
 *  — and Drive is one of the providers a person picks BETWEEN in the connection
 *  catalogue, which is the one place the colour is doing work. */
export const GoogleDriveIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <path fill="#FFC107" d="M8.53 2.5h6.94l6.94 12.02-3.47 6.01-6.94-12.02L8.53 2.5z" />
    <path fill="#1976D2" d="M1.59 14.52 8.53 2.5l3.47 6.01-6.94 12.02-3.47-6.01z" />
    <path fill="#4CAF50" d="M5.06 20.53h13.88l-3.47-6.01H8.53l-3.47 6.01z" />
  </svg>
)) as unknown as LucideIcon;
