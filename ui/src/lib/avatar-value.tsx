import type { ReactNode } from 'react';

import { isIconPath } from '@sdk';
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
  // `isIconPath` is in the gate because a stored value can be a FILE now; without
  // it a path-shaped icon fails both tests and silently renders the fallback,
  // even though `renderIconValue` knows how to draw it.
  if (value && (isLucideName(value) || isIconPath(value) || EMOJI_PATTERN.test(value))) {
    return renderIconValue(value, { className });
  }
  return fallback;
}
