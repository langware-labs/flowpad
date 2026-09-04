import { Gitlab } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

/** GitLab's tanuki in GitLab's orange.
 *
 *  Lucide already draws the shape correctly, so this wraps it rather than
 *  re-deriving the geometry — the only thing missing was the colour, and #FC6D26
 *  is the brand's. Baked in for the reason `SlackIcon` gives: the alternative is
 *  a per-vendor colour map at every call site.
 */
export const GitlabIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <Gitlab {...props} className={`text-[#FC6D26] ${props.className ?? ''}`} />
)) as unknown as LucideIcon;
