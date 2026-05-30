import { iconForType } from '../icons/iconRegistry';

type Props = {
  type: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function EntityIcon({ type, size = 16, color, strokeWidth = 2 }: Props) {
  const Icon = iconForType(type);
  return <Icon size={size} color={color} strokeWidth={strokeWidth} />;
}
