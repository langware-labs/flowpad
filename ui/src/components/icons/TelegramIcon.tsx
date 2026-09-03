import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Telegram's paper plane with its folded wing — the detail that tells it apart
 *  from lucide's generic `Send`, which every "it sends" provider could claim. */
export const TelegramIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M21.7 3.3a1 1 0 0 0-1.05-.16L2.9 10.4a1 1 0 0 0 .06 1.86l4.24 1.45 1.6 5.04a1 1 0 0 0 1.66.42l2.35-2.2 4.3 3.16a1 1 0 0 0 1.57-.6l3.3-15.2a1 1 0 0 0-.28-1.03zM9.6 14.1l-.72 3.4-1.1-3.47 8.9-6.06L9.6 14.1z" />
  </svg>
)) as unknown as LucideIcon;
