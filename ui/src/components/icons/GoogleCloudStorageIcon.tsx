import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** A bucket under the Cloud lockup — GCS's own shape, not the generic cloud a
 *  dozen other providers would also answer to. Monochrome, per the house rule. */
export const GoogleCloudStorageIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M17.5 9.5a5.5 5.5 0 0 0-10.6-2A4 4 0 0 0 7 15.5" />
    <path d="M4.5 12.5h15l-1.4 7.2a1 1 0 0 1-1 .8H6.9a1 1 0 0 1-1-.8L4.5 12.5z" fill="currentColor" fillOpacity=".12" />
    <path d="M9 16h6" />
  </svg>
)) as unknown as LucideIcon;
