import type { EntityMerge } from '../IEntity';
import { APIEntity, type AnyEntity } from '../APIEntity';
import { LabelInfo } from '../models/LabelInfo';

export interface ILabel extends LabelInfo {
  id?: string;
  created_at?: string;
  updated_at?: string;
}

// `implements ILabel` only checks the class; it contributes no members, so every
// field declared solely on ILabel read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Label extends EntityMerge<ILabel> {}

export class Label extends APIEntity<Label> implements ILabel {
  public label!: string;
  public description?: string;
  public parent?: string;
  public color?: string;
  public created_at?: string;
  public updated_at?: string;

  constructor(data?: Partial<ILabel>) {
    super();
    if (data) {
      Object.assign(this, data);
    }
  }

  /**
   * Get display name (last segment of label path)
   */
  get display(): string {
    return this.label.split('.').pop() || this.label;
  }

  static getEntityName(): string {
    return 'label';
  }

  static get type(): string {
    return 'label';
  }

  static isType<U extends APIEntity<U>>(this: { new (): U; type: string }, entity: AnyEntity | null): entity is U {
    return entity !== null && entity.constructor === this;
  }

  /**
   * Get the keyword (last segment) of the label
   */
  getKeyword(): string {
    return this.label.split('.').pop() || this.label;
  }

  /**
   * Get the full path of the label
   */
  getFullPath(): string {
    return this.label;
  }

  /**
   * Check if this label is a child of another label
   */
  isChildOf(parentLabel: string): boolean {
    return this.label.startsWith(parentLabel + '.');
  }

  /**
   * Get the immediate parent label path
   */
  getParentPath(): string | null {
    const parts = this.label.split('.');
    if (parts.length <= 1) return null;
    return parts.slice(0, -1).join('.');
  }
}
