import type { ReactNode } from 'react';

import { isLucideName, renderIconValue } from '@src/lib/icon-value';

export interface AvatarValueProps {
  value?: string | null;
  imageUrl?: string | null;
  fallback?: ReactNode;
  className?: string;
  alt: string;
}

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

/** Render a caller-resolved image, a stored icon/emoji, or a safe fallback. */
export function AvatarValue({ value, imageUrl, fallback = null, className, alt }: AvatarValueProps): ReactNode {
  if (imageUrl) {
    return <img src={imageUrl} alt={alt} className={className} />;
  }
  if (value && (isLucideName(value) || EMOJI_PATTERN.test(value))) {
    return renderIconValue(value, { className });
  }
  return fallback;
}
