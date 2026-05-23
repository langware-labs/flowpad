import { useEffect, useState } from 'react';
import { iconForType, initIconRegistry } from '../icons/iconRegistry';

type Props = {
  type: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function EntityIcon({ type, size = 16, color, strokeWidth = 2 }: Props) {
  const [, force] = useState(0);
  useEffect(() => {
    void initIconRegistry().then(() => force((n) => n + 1));
  }, []);
  const Icon = iconForType(type);
  return <Icon size={size} color={color} strokeWidth={strokeWidth} />;
}
