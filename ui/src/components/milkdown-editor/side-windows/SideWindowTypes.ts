import type { LucideIcon } from 'lucide-react';
import { Link2, MessageSquare } from 'lucide-react';

export const MdSideTabId = {
  Chat:      'chat',
  Backlinks: 'backlinks',
} as const;
export type MdSideTabId = (typeof MdSideTabId)[keyof typeof MdSideTabId];

export interface MdSideTabDescriptor {
  id: MdSideTabId;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const MD_SIDE_TABS: Record<MdSideTabId, MdSideTabDescriptor> = {
  chat:      { id: 'chat',      label: 'Chat',      icon: MessageSquare, description: 'Chat about this document' },
  backlinks: { id: 'backlinks', label: 'Backlinks', icon: Link2,         description: 'Documents that link here' },
};

export const MD_SIDE_TABS_ORDER: MdSideTabId[] = ['chat', 'backlinks'];
export const MD_SIDE_TABS_DEFAULT: MdSideTabId = 'chat';
