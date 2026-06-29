import { dataManager, TypeId, type FeedEntry } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Bell, type LucideIcon } from 'lucide-react';
import { getFeedEntryTypeId } from './feed-utils';

export class FeedData {
  readonly targetTypeId: TypeId | null;

  constructor(targetTypeId: TypeId | null = null) {
    this.targetTypeId = targetTypeId;
  }

  static fromEntry(entry: FeedEntry): FeedData {
    const targetTypeId = getFeedEntryTypeId(entry);
    return targetTypeId ? new EntityFeedData(targetTypeId) : new FeedData();
  }

  get icon(): LucideIcon {
    return Bell;
  }

  get iconTooltip(): string {
    return 'Feed entry';
  }
}

export class EntityFeedData extends FeedData {
  constructor(targetTypeId: TypeId) {
    super(targetTypeId);
  }

  override get icon(): LucideIcon {
    return this.targetTypeId ? iconForType(this.targetTypeId.type) : super.icon;
  }

  override get iconTooltip(): string {
    if (!this.targetTypeId) return super.iconTooltip;
    return dataManager?.getTypeInfo?.(this.targetTypeId.type)?.type_name ?? this.targetTypeId.type;
  }
}
