import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** Gmail's envelope-with-M mark, in Google's colours. Distinct on purpose: three
 *  providers ship a mailbox (`gmail`, `agentmail`, `cloud_email`) and one generic
 *  `Mail` glyph for all three told a person nothing about which row was which;
 *  the colour is what an inbox row is recognised by before its label is read. */
export const GmailIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <path fill="#4285F4" d="M2 8.2v9.3A1.5 1.5 0 0 0 3.5 19H6V10.9L2 8.2z" />
    <path fill="#34A853" d="M18 10.9V19h2.5a1.5 1.5 0 0 0 1.5-1.5V8.2l-4 2.7z" />
    <path fill="#EA4335" d="M6 10.9 12 15l6-4.1V7L12 11 6 7v3.9z" />
    <path fill="#FBBC04" d="M2 8.2 6 10.9V7L4.3 5.8A1.5 1.5 0 0 0 2 7v1.2z" />
    <path fill="#C5221F" d="M22 8.2V7a1.5 1.5 0 0 0-2.3-1.2L18 7v3.9l4-2.7z" />
  </svg>
)) as unknown as LucideIcon;
