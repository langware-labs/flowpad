import { FSItem } from '../../entities/fs_item';
import { VFSPath } from '../../utils/vfs-path';
import { Instruction } from './Instruction';
import { InstructionElement, genInstructionId } from './InstructionElement';
import { InstructionElementParser } from './InstructionElementParser';
import { InstructionsBlock } from './InstructionsBlock';
import { InstructionStatus } from './InstructionStatus';
import { SkillParser, SkillParseError } from '../skill/SkillParser';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * Represents a UI component within a skill/instruction page.
 */
export interface SkillWebpageComponent {
  name: string;
}

/**
 * Represents a page with its UI components in a skill/instruction file.
 */
export interface SkillWebpage {
  name: string;
  components: SkillWebpageComponent[];
}

/**
 * YAML structure for pages in frontmatter.
 */
interface PageYamlItem {
  name?: string;
  components?: string[];
}

/**
 * InstructionFile parses and manages instruction files (.md).
 *
 * Supports multiple parsing strategies:
 * 1. Flow elements (<!-- <flow-do .../> -->) - new structured format
 * 2. Legacy markers (<!-- !mark[instruction]:N -->) - explicit markers
 * 3. Fallback paragraph parsing - simple markdown
 *
 * Features:
 * - YAML frontmatter extraction to metadata property
 * - Markdown headers become element titles
 * - Round-trip serialization via toAmdString()
 * - Iterable over instruction elements
 */
export class InstructionFile implements Iterable<InstructionElement> {
  private readonly _content: string;
  private readonly _item: FSItem | null;
  private readonly _vfsPath: VFSPath | null;
  private readonly _sourceVfsPath: VFSPath | null;
  private readonly _elements: InstructionElement[];
  private readonly _instructionsBlock: InstructionsBlock;
  private readonly _metadata: Record<string, unknown>;
  private _contentWithoutFrontmatter: string;

  /**
   * Private constructor - use static factory methods
   */
  private constructor(
    content: string,
    item: FSItem | null = null,
    vfsPath: VFSPath | null = null,
    sourceVfsPath: VFSPath | null = null,
  ) {
    this._content = content;
    this._item = item;
    this._vfsPath = vfsPath;
    this._sourceVfsPath = sourceVfsPath;
    this._elements = [];
    this._instructionsBlock = new InstructionsBlock();
    this._metadata = {};
    this._contentWithoutFrontmatter = content;

    this.parse();
  }

  // ============ Static Factory Methods ============

  /**
   * Create InstructionFile from content string.
   * Item and vfsPath will be null.
   */
  static fromContent(content: string): InstructionFile {
    return new InstructionFile(content, null, null, null);
  }

  /**
   * Create InstructionFile from FSItem.
   * Downloads content and extracts vfsPath from item.
   */
  static async fromItem(item: FSItem): Promise<InstructionFile> {
    const content = await item.download();
    if (typeof content !== 'string') {
      throw new Error('FSItem content must be a string');
    }
    return new InstructionFile(content, item, item.vfsPath, null);
  }

  /**
   * Create InstructionFile from VFSPath.
   * Requires fsManager to fetch content.
   */
  static async fromVFS(vfsPath: VFSPath, content: string): Promise<InstructionFile> {
    return new InstructionFile(content, null, vfsPath, null);
  }

  // ============ Properties ============

  /** The raw file content */
  get content(): string {
    return this._content;
  }

  /** The FSItem if created from fromItem, null otherwise */
  get item(): FSItem | null {
    return this._item;
  }

  /** The VFSPath for this file */
  get vfsPath(): VFSPath | null {
    return this._vfsPath;
  }

  /** The source VFSPath if this is a compiled file */
  get sourceVfsPath(): VFSPath | null {
    return this._sourceVfsPath;
  }

  /** Parsed InstructionElements (flow elements) */
  get elements(): InstructionElement[] {
    return this._elements;
  }

  /** YAML frontmatter metadata */
  get metadata(): Record<string, unknown> {
    return this._metadata;
  }

  /**
   * Whether this file is compiled (has flow-header element)
   */
  get compiled(): boolean {
    return this.hasFlowHeader();
  }

  /**
   * Get the flow-header element if present.
   * Note: Header elements are not stored in _elements, so this parses the raw content.
   */
  get header(): InstructionElement | null {
    // Headers are not stored in _elements, check raw content instead
    if (!this.hasFlowHeader()) {
      return null;
    }
    // Parse header from content if needed
    try {
      const parser = new InstructionElementParser();
      const elements = parser.parse(this._contentWithoutFrontmatter);
      return elements.find((el) => el.elementType === 'header') || null;
    } catch {
      return null;
    }
  }

  /**
   * Get elements excluding the header (actual instructions).
   * Note: Since headers are not stored in _elements, this is equivalent to elements.
   */
  get instructionElements(): InstructionElement[] {
    return this._elements;
  }

  /**
   * Number of instruction elements (excluding header)
   */
  get length(): number {
    return this.instructionElements.length;
  }

  /**
   * Get the pages structure from YAML frontmatter.
   *
   * Pages define UI components available in this instruction file.
   * Format in YAML:
   *     pages:
   *       - name: index
   *         components:
   *           - main
   *           - sidebar
   *       - name: settings
   *         components:
   *           - form
   *
   * @returns List of InstructionPage objects with their components.
   * Access pattern: instructionFile.pages[0].components[1]
   */
  get pages(): SkillWebpage[] {
    const pagesData = this._metadata.pages as (PageYamlItem | string)[] | undefined;
    if (!pagesData || !Array.isArray(pagesData)) {
      return [];
    }

    return pagesData.map((pageItem): SkillWebpage => {
      if (typeof pageItem === 'object' && pageItem !== null) {
        const pageName = pageItem.name || 'index';
        const componentsData = pageItem.components || [];
        const components: SkillWebpageComponent[] = componentsData
          .filter((c): c is string => !!c)
          .map((c) => ({ name: String(c) }));
        return { name: pageName, components };
      } else if (typeof pageItem === 'string') {
        // Simple format: just page name, default component "main"
        return { name: pageItem, components: [{ name: 'main' }] };
      }
      return { name: 'index', components: [{ name: 'main' }] };
    });
  }

  /**
   * Get a page by name.
   *
   * @param name - Page name (default: "index")
   * @returns InstructionPage object or undefined if not found
   */
  getPage(name: string = 'index'): SkillWebpage | undefined {
    return this.pages.find((page) => page.name === name);
  }

  /**
   * Get a component by page and component name.
   *
   * @param pageName - Page name (default: "index")
   * @param componentName - Component name (default: "main")
   * @returns InstructionPageComponent object or undefined if not found
   */
  getComponent(pageName: string = 'index', componentName: string = 'main'): SkillWebpageComponent | undefined {
    const page = this.getPage(pageName);
    if (page) {
      return page.components.find((comp) => comp.name === componentName);
    }
    return undefined;
  }

  // ============ Iteration ============

  /**
   * Iterate over instruction elements (excluding header).
   * Since headers are not stored in _elements, this simply iterates over all elements.
   */
  *[Symbol.iterator](): IterableIterator<InstructionElement> {
    yield* this._elements;
  }

  // ============ Legacy API ============

  /** @deprecated Use vfsPath.absVfsPath instead */
  getFilePath(): string {
    return this._vfsPath?.absVfsPath || '';
  }

  /** Legacy instructions block for backward compatibility */
  getInstructions(): InstructionsBlock {
    return this._instructionsBlock;
  }

  // ============ Compile ============

  /**
   * Compile this file into a new InstructionFile with flow-header.
   * The compiled file has sourceVfsPath set to this file's vfsPath.
   */
  compile(): InstructionFile {
    if (this.compiled) {
      // Already compiled - return a copy
      return new InstructionFile(this._content, this._item, this._vfsPath, this._sourceVfsPath);
    }

    // Generate compiled content with flow-header (includes compile timestamp)
    const timestamp = new Date().toISOString();
    const sourceAttr = this._vfsPath ? ` source="${this._vfsPath.absVfsPath}"` : '';
    const header = `<!-- <flow-header version="1.0" compiled-at="${timestamp}"${sourceAttr} /> -->`;
    const compiledContent = `${header}\n${this._content}`;

    return new InstructionFile(compiledContent, null, null, this._vfsPath);
  }

  // ============ Serialization ============

  /**
   * Serialize this file back to AMD format.
   *
   * Includes YAML frontmatter (if present) and all elements.
   *
   * @returns String representation in AMD format
   */
  toAmdString(): string {
    const parts: string[] = [];

    // Add YAML frontmatter if present
    if (Object.keys(this._metadata).length > 0) {
      parts.push('---');
      // Use YAML stringify for readable output
      const yamlContent = stringifyYaml(this._metadata, { indent: 2 }).trim();
      parts.push(yamlContent);
      parts.push('---');
      parts.push('');
    }

    // Add all elements
    for (let i = 0; i < this._elements.length; i++) {
      if (i > 0) {
        parts.push('');
      }
      parts.push(this._elements[i].toAmdString());
    }

    return parts.join('\n');
  }

  // ============ Private Methods ============

  private parse(): void {
    // Extract YAML frontmatter first
    this.extractMetadata();

    // First try: Parse flow elements
    if (this.parseFlowElements()) {
      return;
    }

    // Second try: Legacy explicit instruction markers
    if (this.parseExplicitMarkers()) {
      return;
    }

    // Fallback: Paragraph parsing
    this.parseFallback();
  }

  /**
   * Extract YAML frontmatter into this._metadata
   */
  private extractMetadata(): void {
    const frontmatterMatch = this._content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (frontmatterMatch) {
      try {
        const parsed = parseYaml(frontmatterMatch[1]);
        if (parsed && typeof parsed === 'object') {
          Object.assign(this._metadata, parsed);
        }
        this._contentWithoutFrontmatter = this._content.slice(frontmatterMatch[0].length);
      } catch {
        // YAML parsing failed, keep content as-is
        this._contentWithoutFrontmatter = this._content;
      }
    } else {
      this._contentWithoutFrontmatter = this._content;
    }
  }

  /**
   * Parse using flow element syntax (<!-- <flow-xxx .../> -->).
   * Returns true if any flow elements were found.
   */
  private parseFlowElements(): boolean {
    // Check if there are any actual flow elements in the content
    const flowElementPattern = /<!--\s*<\/?flow-[a-z]+/;
    if (!flowElementPattern.test(this._contentWithoutFrontmatter)) {
      return false;
    }

    try {
      const parser = new InstructionElementParser();
      const elements = parser.parse(this._contentWithoutFrontmatter);

      if (elements.length === 0) {
        return false;
      }

      // Filter out flow-header from elements (it's metadata, not an instruction)
      const instructionElements = elements.filter((el) => el.elementType !== 'header');
      this._elements.push(...instructionElements);

      // Also populate legacy instructionsBlock for backward compatibility
      this.populateInstructionsFromElements(instructionElements);

      return true;
    } catch {
      // Flow element parsing failed, try other methods
      return false;
    }
  }

  /**
   * Check if content has a flow-header element
   */
  private hasFlowHeader(): boolean {
    const headerPattern = /<!--\s*<flow-header\s+[^>]*\/?\s*>\s*-->/;
    return headerPattern.test(this._content);
  }

  /**
   * Populate legacy InstructionsBlock from InstructionElements
   */
  private populateInstructionsFromElements(elements: InstructionElement[], parentIndex: number = 0): number {
    let index = parentIndex;
    for (const element of elements) {
      index++;
      const instruction = new Instruction(
        index,
        element.content,
        InstructionStatus.PENDING,
        element.id || `instruction-${index}`,
      );
      this._instructionsBlock.add(instruction);

      if (element.hasChildren()) {
        index = this.populateInstructionsFromElements(element.children, index);
      }
    }
    return index;
  }

  /**
   * Parse using explicit instruction markers.
   * Returns true if markers were found and parsed.
   */
  private parseExplicitMarkers(): boolean {
    const commentPattern = /<!--\s*!mark\[instruction\]:(\d+)\s*-->/g;
    const matches: Array<{ index: number; instructionNum: number; endIndex: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = commentPattern.exec(this._contentWithoutFrontmatter)) !== null) {
      matches.push({
        index: match.index,
        instructionNum: parseInt(match[1], 10),
        endIndex: commentPattern.lastIndex,
      });
    }

    if (matches.length === 0) {
      return false;
    }

    for (let i = 0; i < matches.length; i++) {
      const currentMatch = matches[i];
      const nextMatch = matches[i + 1];

      const startIndex = currentMatch.endIndex;
      const endIndex = nextMatch ? nextMatch.index : this._contentWithoutFrontmatter.length;
      const instructionContent = this._contentWithoutFrontmatter.substring(startIndex, endIndex).trim();

      if (instructionContent.length > 0) {
        const instructionId = genInstructionId();
        const instruction = new Instruction(
          currentMatch.instructionNum,
          instructionContent,
          InstructionStatus.PENDING,
          instructionId,
        );
        this._instructionsBlock.add(instruction);

        // Also create InstructionElement for new API
        const element = new InstructionElement(
          'do',
          { id: instructionId },
          instructionContent,
          false,
          currentMatch.index,
          null,
          false,
        );
        this._elements.push(element);
      }
    }

    this._instructionsBlock.sortByLineNumber();
    return true;
  }

  /**
   * Fallback parsing: strip YAML frontmatter and split by paragraphs.
   * Markdown headers become titles for the following element.
   */
  private parseFallback(): void {
    let processedContent = this._contentWithoutFrontmatter;

    // Use SkillParser to strip YAML frontmatter (additional check)
    try {
      const parsed = SkillParser.parse(this._content);
      processedContent = parsed.content;
    } catch (e) {
      // If SkillParser fails (no frontmatter), use content without frontmatter
      if (!(e instanceof SkillParseError)) {
        throw e;
      }
    }

    // Split by single newlines (one instruction per line)
    const paragraphs = processedContent
      .split(/\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    let pendingTitle: string | null = null;
    let instructionNum = 0;

    for (const paragraph of paragraphs) {
      // Check if this paragraph is a markdown header
      const headerMatch = paragraph.match(/^#{1,6}\s+(.+)$/m);
      if (headerMatch) {
        // Store as pending title for next element
        pendingTitle = headerMatch[1].trim();
        continue;
      }

      instructionNum++;
      const instructionId = genInstructionId();
      const instruction = new Instruction(instructionNum, paragraph, InstructionStatus.PENDING, instructionId);
      this._instructionsBlock.add(instruction);

      // Also create InstructionElement for new API
      const element = new InstructionElement(
        'do',
        { id: instructionId },
        paragraph,
        false,
        0,
        pendingTitle,
        true, // markless
      );
      this._elements.push(element);
      pendingTitle = null;
    }
  }
}
