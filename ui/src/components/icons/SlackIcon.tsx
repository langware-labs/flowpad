import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Slack's four-colour mark. Lucide ships a monochrome `Slack`, but on an inbox
 *  row the colour IS the attribution — it is what a person recognises before
 *  reading a label. Colours are the brand's own, baked in: a per-vendor colour
 *  map at a call site is exactly what the icon registry exists to avoid. */
export const SlackIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <path fill="#E01E5A" d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.31a2.52 2.52 0 0 1-5.04 0v-6.31z" />
    <path fill="#36C5F0" d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 0 1 0-5.04h6.31z" />
    <path fill="#2EB67D" d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 0 1 5.04 0v6.31z" />
    <path fill="#ECB22E" d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 0 1 0 5.04h-6.31z" />
  </svg>
)) as unknown as LucideIcon;
