import { APIEntity, registerEntity, type AnyEntity } from '../APIEntity';
import { TypeId } from '../FlowSync';
import { IEntity, EntityMerge } from '../IEntity';
import { Workspace } from './workspace';

export const PAGE_TYPE = {
  LANDING: 'landing',
  PROFILE: 'profile',
  PERSONA: 'persona',
  TEMPLATE: 'template',
  KNOWLEDGE_HUB: 'knowledge_hub',
  DOCUMENTATION: 'documentation',
  INSTRUCTIONS: 'instructions',
};

export interface IPage extends IEntity {
  title: string;
  raw_content?: string;
  template_id?: string;
  tags?: string[];
  readonly is_private?: boolean;
}

// `implements IPage` only checks the class; it contributes no members, so every
// field declared solely on IPage read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Page extends EntityMerge<IPage> {}

@registerEntity
export class Page extends APIEntity<Page> implements IPage {
  static type: string = 'page';
  title: string;
  raw_content?: string;
  template_id?: string;
  tags?: string[];

  constructor(entity: Partial<IPage> = {}) {
    super(entity);
    this.title = entity.title || '';
    this.raw_content = entity.raw_content;
    this.template_id = entity.template_id;
    //TODO: Handle chatTypeId changes.
    this.template_id = entity.template_id;
    this.tags = entity.tags || [];
  }

  get isEmpty(): boolean {
    return this.title === '' && !this.raw_content;
  }

  async analyze(context: TypeId[] = []): Promise<void> {
    if (!this.saved) return undefined;
    await this.post<AnyEntity>('analyze', { context });
  }

  addFunc(funcTitle: string, funcContent?: any): void {
    const content = this.raw_content
      ? JSON.parse(this.raw_content)
      : { root: { children: [], type: 'root', version: 1 } };
    content.root.children.push({
      children: [{ info: funcTitle, content: funcContent, type: 'fence', version: 1 }],
      format: '',
      type: 'paragraph',
      version: 1,
      textStyle: '',
    });
    this.raw_content = JSON.stringify(content);
  }

  public async get_related_workspace(): Promise<Workspace | undefined> {
    if (this.tags?.includes('profile')) return undefined;
    return super.get_related_workspace();
  }
}
