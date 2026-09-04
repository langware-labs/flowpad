import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Microsoft's four squares.
 *
 *  Registered because nothing resolved the name at all: the provider publishes
 *  `icon: "Microsoft"`, lucide has no such glyph, and the catalogue fell through
 *  to the generic key — a provider tile that says "no icon found" rather than
 *  which provider it is. The four colours are the brand's own and the geometry
 *  is the whole logo, so there is nothing to approximate.
 */
export const MicrosoftIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <path fill="#F25022" d="M1.5 1.5h9.6v9.6H1.5z" />
    <path fill="#7FBA00" d="M12.9 1.5h9.6v9.6h-9.6z" />
    <path fill="#00A4EF" d="M1.5 12.9h9.6v9.6H1.5z" />
    <path fill="#FFB900" d="M12.9 12.9h9.6v9.6h-9.6z" />
  </svg>
)) as unknown as LucideIcon;
