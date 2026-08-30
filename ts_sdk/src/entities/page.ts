import type { EntityMerge } from '../IEntity';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { TypeId } from '../FlowSync';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models';
import type { InstructionSection, PageData } from '../types/pageData';
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
  private _page_data?: PageData;

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
    await this.post<APIEntity<any>>('analyze', { context });
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

  public get_page_data(): PageData {
    if (!this._page_data) {
      this._page_data = {
        section_labels: [],
        instruction_sections: [],
        page_labels: [],
      };
    }
    return this._page_data;
  }

  public set_page_data(data: PageData): void {
    this._page_data = data;
  }

  /**
   * Get an instruction section by node key
   */
  public getInstructionSection(nodeKey: string): InstructionSection | undefined {
    const pageData = this.get_page_data();
    return pageData.instruction_sections.find((section) => section.node_key === nodeKey);
  }

  /**
   * Add or update an instruction section
   */
  public setInstructionSection(section: InstructionSection): void {
    const pageData = this.get_page_data();
    const existingIndex = pageData.instruction_sections.findIndex((s) => s.node_key === section.node_key);

    if (existingIndex >= 0) {
      pageData.instruction_sections[existingIndex] = section;
    } else {
      pageData.instruction_sections.push(section);
    }

    this.set_page_data(pageData);
  }

  /**
   * Remove an instruction section by node key
   */
  public removeInstructionSection(nodeKey: string): void {
    const pageData = this.get_page_data();
    pageData.instruction_sections = pageData.instruction_sections.filter((s) => s.node_key !== nodeKey);
    this.set_page_data(pageData);
  }

  /**
   * Get all instruction sections sorted by order
   */
  public getInstructionSections(): InstructionSection[] {
    const pageData = this.get_page_data();
    return [...pageData.instruction_sections].sort((a, b) => a.order - b.order);
  }

  /**
   * Get page-level labels (independent from section labels)
   */
  public getPageLabels(): import('./label').Label[] {
    const pageData = this.get_page_data();
    return pageData.page_labels || [];
  }

  /**
   * Set page-level labels (independent from section labels)
   */
  public setPageLabels(labels: import('./label').Label[]): void {
    const pageData = this.get_page_data();
    pageData.page_labels = labels;
    this.set_page_data(pageData);
  }

  /**
   * Add a label to page-level labels
   */
  public addPageLabel(label: import('./label').Label): void {
    const pageData = this.get_page_data();
    if (!pageData.page_labels) {
      pageData.page_labels = [];
    }
    // Avoid duplicates
    const exists = pageData.page_labels.some((l) => l.label === label.label);
    if (!exists) {
      pageData.page_labels.push(label);
      this.set_page_data(pageData);
    }
  }

  /**
   * Remove a label from page-level labels
   */
  public removePageLabel(labelPath: string): void {
    const pageData = this.get_page_data();
    if (pageData.page_labels) {
      pageData.page_labels = pageData.page_labels.filter((l) => l.label !== labelPath);
      this.set_page_data(pageData);
    }
  }
}
