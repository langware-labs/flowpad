import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Gmail's envelope-with-M mark. Distinct on purpose: three providers ship a
 *  mailbox (`gmail`, `agentmail`, `cloud_email`) and one generic `Mail` glyph
 *  for all three told a person nothing about which row was which. */
export const GmailIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M3.5 5h17A1.5 1.5 0 0 1 22 6.5v11a1.5 1.5 0 0 1-1.5 1.5H19V9.4l-7 5.1-7-5.1V19H3.5A1.5 1.5 0 0 1 2 17.5v-11A1.5 1.5 0 0 1 3.5 5z" opacity=".55" />
    <path d="M4.2 5.2 12 10.9l7.8-5.7A1.5 1.5 0 0 0 18.9 5H5.1a1.5 1.5 0 0 0-.9.2z" />
    <path d="M5 19V9.9l7 5.1 7-5.1V19h-3v-5.2l-4 2.9-4-2.9V19H5z" opacity=".8" />
  </svg>
)) as unknown as LucideIcon;
