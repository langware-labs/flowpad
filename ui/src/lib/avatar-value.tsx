import type { ReactNode } from 'react';

import { FlowIcon } from '@sdk/react/FlowIcon';

export interface AvatarValueProps {
  value?: string | null;
  imageUrl?: string | null;
  fallback?: ReactNode;
  className?: string;
  alt: string;
}

/**
 * Render a caller-resolved image, a stored icon value, or a safe fallback.
 *
 * The stored value may be a name, a served path or an emoji — the icon picker
 * writes all three into one field. That used to need a three-way gate here
 * (`isLucideName || isIconPath || EMOJI_PATTERN`); resolution answers it now, so
 * the only thing left is the choice between a URL the caller already resolved
 * and everything else.
 */
export function AvatarValue({ value, imageUrl, fallback = null, className, alt }: AvatarValueProps): ReactNode {
  if (imageUrl) {
    return <img src={imageUrl} alt={alt} className={className} />;
  }
  if (!value) return fallback;
  return <FlowIcon icon={value} className={className} fallback={fallback} />;
}
