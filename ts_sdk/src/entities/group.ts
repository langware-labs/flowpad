import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { ExpressionNode, QueryFilter, QueryRequest } from '../FlowSync/query';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';

/**
 * Group — generic folder-like container entity (docs/entities-groups.md).
 *
 * The SDK is the frontend's only door to folder mechanics: creation, rename,
 * appearance, cycle-checked move, move-children-up delete, and the children/
 * roots listings (composed from the generic entity query — no bespoke
 * listing endpoints). Mutations round-trip; state reflects back via the
 * ordinary entity-update path (no optimistic local writes).
 */
export interface IGroup extends IEntity {
  name: string;
  /** Tree identity (e.g. 'prompt-library'). Immutable after creation. */
  group_namespace?: string;
  /** Lucide export name or emoji char — `renderIconValue` resolves either. */
  icon?: string | null;
  /** Hex from the curated contrast-tested palette. */
  color?: string | null;
  project_id?: string | null;
}

/** One folder level: subgroups + member entities of the requested leaf types. */
export interface GroupChildren {
  groups: Group[];
  members: IEntity[];
}

const byName = (a: { name?: string }, b: { name?: string }) =>
  (a.name ?? '').localeCompare(b.name ?? '');

/** IS_NULL leaf for the virtual-root queries (two-operand shape required). */
const groupIdIsNull = () => new ExpressionNode({ operands: ['group_id', null], op: '$IS_NULL' });

async function queryEntities<T extends IEntity>(type: string, match: ExpressionNode): Promise<T[]> {
  return dataManager.query<any>(new QueryRequest({ type, query: new QueryFilter({ type, match }) }));
}

@registerEntity
export class Group extends APIEntity<Group> implements IGroup {
  static type: string = 'group';

  name: string = '';
  group_namespace: string = '';
  icon?: string | null;
  color?: string | null;
  project_id?: string | null;

  constructor(entity: Partial<IGroup> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.group_namespace = entity.group_namespace ?? '';
    this.icon = entity.icon ?? null;
    this.color = entity.color ?? null;
    this.project_id = entity.project_id ?? null;
  }

  /** Create a folder. `groupId` parents it (same-namespace, cycle-checked server-side on later moves). */
  static async create(opts: {
    name: string;
    namespace: string;
    groupId?: string | null;
    icon?: string | null;
    color?: string | null;
    projectId?: string | null;
  }): Promise<Group> {
    const group = new Group({
      name: opts.name,
      group_namespace: opts.namespace,
      icon: opts.icon ?? null,
      color: opts.color ?? null,
      project_id: opts.projectId ?? null,
    });
    group.group_id = opts.groupId ?? null;
    return group.save();
  }

  /**
   * Virtual-root listing of a namespace: groups with no parent, plus
   * ungrouped member entities of the requested leaf types.
   */
  static async listRoot(
    namespace: string,
    opts: { types?: string[]; projectId?: string | null } = {},
  ): Promise<GroupChildren> {
    const projectLeaf = opts.projectId ? [new ExpressionNode({ project_id: opts.projectId })] : [];
    const groups = (await queryEntities<IGroup>(
      Group.type,
      new ExpressionNode({
        op: '$AND',
        operands: [new ExpressionNode({ group_namespace: namespace }), groupIdIsNull(), ...projectLeaf],
      }),
    )) as Group[];
    const members = await Group._members(opts.types ?? [], (extra) =>
      new ExpressionNode({ op: '$AND', operands: [groupIdIsNull(), ...extra, ...projectLeaf] }),
    );
    return { groups: groups.sort(byName), members };
  }

  /** Children of this folder: subgroups + members of the requested leaf types. */
  async listChildren(opts: { types?: string[] } = {}): Promise<GroupChildren> {
    const groups = (await queryEntities<IGroup>(
      Group.type,
      new ExpressionNode({ group_id: this.id }),
    )) as Group[];
    const members = await Group._members(opts.types ?? [], () => new ExpressionNode({ group_id: this.id }));
    return { groups: groups.sort(byName), members };
  }

  private static async _members(
    types: string[],
    matchFor: (extra: ExpressionNode[]) => ExpressionNode,
  ): Promise<IEntity[]> {
    const perType = await Promise.all(types.map((t) => queryEntities<IEntity>(t, matchFor([]))));
    return perType.flat().sort(byName as any);
  }

  async rename(name: string): Promise<Group> {
    this.name = name;
    return this.save();
  }

  async setAppearance(opts: { icon?: string | null; color?: string | null }): Promise<Group> {
    if (opts.icon !== undefined) this.icon = opts.icon;
    if (opts.color !== undefined) this.color = opts.color;
    return this.save();
  }

  /** Cycle-checked re-parent (null = move to the namespace root). */
  async move(parentGroupId: string | null): Promise<void> {
    const info = new ActionInfo('move', Group.type, this.id, 'POST');
    info.bodyParameters = { group_id: parentGroupId };
    await dataManager.callAction(info);
  }

  /** Delete this folder; its children move up to this folder's parent. */
  async deleteGroup(): Promise<void> {
    const info = new ActionInfo('delete-group', Group.type, this.id, 'POST');
    await dataManager.callAction(info);
  }
}
