import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Telegram's paper plane on its blue disc — the detail that tells it apart from
 *  lucide's generic `Send`, which every "it sends" provider could claim. */
export const TelegramIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="11" fill="#26A5E4" />
    <path
      fill="#fff"
      d="M17.6 7.2a.6.6 0 0 0-.63-.1L6.4 11.3a.6.6 0 0 0 .04 1.12l2.55.87.96 3.02a.6.6 0 0 0 1 .25l1.4-1.32 2.58 1.9a.6.6 0 0 0 .94-.36l1.98-9.12a.6.6 0 0 0-.25-.46zM10.3 13.7l-.43 2.04-.66-2.08 5.34-3.64-4.25 3.68z"
    />
  </svg>
)) as unknown as LucideIcon;
