import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** An envelope under a cloud — a mailbox the HUB allocates and holds the credential
 *  for, as opposed to one you bring. Bespoke because three providers ship a mailbox
 *  and lucide's single `Mail` made them one indistinguishable envelope in the picker,
 *  which is the one place a person is choosing between them. Wears the product's
 *  indigo: on an inbox row the colour is what a person recognises first. */
export const CloudMailboxIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <path d="M17.5 8.2a5 5 0 0 0-9.6-1.6A3.6 3.6 0 0 0 7.4 13" fill="none" stroke="#7C7CF0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="3" y="12.5" width="18" height="8" rx="1.6" fill="#7C7CF0" />
    <path d="m3.6 13.3 7.5 4.3a1.8 1.8 0 0 0 1.8 0l7.5-4.3" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)) as unknown as LucideIcon;
