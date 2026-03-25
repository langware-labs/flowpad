import {
  InstructionElementType,
  isInstructionElementType,
  normalizeInstructionElementType,
} from './InstructionElementTypes';

/**
 * Base62 character set for ID generation (alphanumeric)
 */
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generate a unique instruction ID using 8 alphanumeric characters (base62).
 * Short enough to be readable, long enough to be practically collision-free.
 *
 * @returns 8-character alphanumeric ID
 */
export function genInstructionId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += BASE62_CHARS.charAt(Math.floor(Math.random() * BASE62_CHARS.length));
  }
  return id;
}

/**
 * InstructionElement represents a flow control element in MDO files.
 * Elements are embedded in HTML comments: <!-- <flow-do .../> --> or <!-- <flow-if test="..."> -->
 *
 * Supports:
 * - flow-do: Single instruction (content is text until next element if self-closing)
 * - flow-if: Conditional execution (test attribute contains expression)
 * - flow-each: Loop over items (items and as attributes)
 * - flow-set: Store a value (name attribute, value from attribute or content)
 * - flow-call: Function-like call to another instruction file (href attribute contains path)
 * - flow-header: Compilation metadata (version, source attributes)
 */
export class InstructionElement {
  public readonly elementType: InstructionElementType;
  public readonly attributes: Record<string, string>;
  public content: string;
  public children: InstructionElement[];
  public readonly isSelfClosing: boolean;
  public readonly sourcePosition: number;
  /** Optional title from markdown header */
  public title: string | null;
  /** True if element came from unmarked text (no flow comment) */
  public readonly markless: boolean;

  constructor(
    elementType: string,
    attributes: Record<string, string> = {},
    content: string = '',
    isSelfClosing: boolean = false,
    sourcePosition: number = 0,
    title: string | null = null,
    markless: boolean = false,
  ) {
    const normalized = normalizeInstructionElementType(elementType);

    if (!isInstructionElementType(normalized)) {
      throw new Error(
        `Invalid instruction element type: "${elementType}". Expected: do, if, each, set, call, header, ui, block, text, tag`,
      );
    }

    this.elementType = normalized;
    this.attributes = attributes;
    this.content = content;
    this.children = [];
    this.isSelfClosing = isSelfClosing;
    this.sourcePosition = sourcePosition;
    this.title = title;
    this.markless = markless;
  }

  /**
   * Get the 'id' attribute if present
   */
  get id(): string | null {
    return this.attributes['id'] || null;
  }

  /**
   * Get the 'test' attribute for flow-if elements
   */
  get test(): string | null {
    return this.attributes['test'] || null;
  }

  /**
   * Get the 'items' attribute for flow-each elements
   */
  get items(): string | null {
    return this.attributes['items'] || null;
  }

  /**
   * Get the 'as' attribute for flow-each elements (iterator variable name)
   */
  get as(): string | null {
    return this.attributes['as'] || null;
  }

  /**
   * Get the 'name' attribute for flow-set elements
   */
  get name(): string | null {
    return this.attributes['name'] || null;
  }

  /**
   * Get the 'value' attribute for flow-set elements
   */
  get value(): string | null {
    return this.attributes['value'] || null;
  }

  /**
   * Get the 'href' attribute for flow-call elements (path to called instruction file)
   */
  get href(): string | null {
    return this.attributes['href'] || null;
  }

  /**
   * Get the 'on-error' attribute (skip or stop)
   */
  get onError(): 'skip' | 'stop' | null {
    const val = this.attributes['on-error'];
    if (val === 'skip' || val === 'stop') {
      return val;
    }
    return null;
  }

  /**
   * Get the 'version' attribute for flow-header elements
   */
  get version(): string | null {
    return this.attributes['version'] || null;
  }

  /**
   * Get the 'source' attribute for flow-header elements
   */
  get source(): string | null {
    return this.attributes['source'] || null;
  }

  /**
   * Get the 'compiled-at' attribute for flow-header elements (ISO timestamp)
   */
  get compiledAt(): string | null {
    return this.attributes['compiled-at'] || null;
  }

  /**
   * Get the 'uri' attribute for flow-ui elements (MCP UI component URI)
   */
  get uri(): string | null {
    return this.attributes['uri'] || null;
  }

  /**
   * Get the 'page' attribute for flow-ui elements (page/view within the component)
   */
  get page(): string | null {
    return this.attributes['page'] || null;
  }

  /**
   * Get the 'params' attribute for flow-ui elements (JSON params sent to component)
   */
  get params(): string | null {
    return this.attributes['params'] || null;
  }

  /**
   * Is this block agentic? Default True. Non-agentic blocks skip LLM calls.
   */
  get agentic(): boolean {
    const val = this.attributes['agentic'];
    return val !== 'false' && val !== '0' && val !== 'no';
  }

  /**
   * Get the tag name for tag elements (same as 'name' attribute)
   */
  get tagName(): string | null {
    return this.attributes['name'] || null;
  }

  /**
   * Get the tag value for tag elements (optional value after colon)
   */
  get tagValue(): string | null {
    return this.attributes['value'] || null;
  }

  /**
   * Add a child element
   */
  addChild(child: InstructionElement): void {
    this.children.push(child);
  }

  /**
   * Check if this element has children
   */
  hasChildren(): boolean {
    return this.children.length > 0;
  }

  // ============ Serialization ============

  /**
   * Serialize this element back to AMD format.
   *
   * For markless elements, outputs just the content (with optional title header).
   * For tag elements, outputs simple HTML comments: <!-- tag-name --> or <!-- tag-name: value -->
   * For flow elements, outputs the HTML comment wrapper with attributes.
   * For block elements, includes children recursively.
   *
   * @returns String representation in AMD format
   */
  toAmdString(): string {
    const parts: string[] = [];

    // Add title as markdown header if present
    if (this.title) {
      parts.push(`# ${this.title}`);
      parts.push('');
    }

    if (this.markless) {
      // Markless element - just output content
      if (this.content) {
        parts.push(this.content);
      }
    } else if (this.elementType === 'tag') {
      // Tag element
      const isBlockStyle = this.attributes['block-style'] === 'true';
      const isHashStyle = this.attributes['hash-style'] === 'true';
      const tagName = this.tagName || 'unknown';
      const tagValue = this.tagValue;

      if (isHashStyle) {
        // Hash-style tag: <!-- #tag-name -->content<!-- /tag-name -->
        parts.push(`<!-- #${tagName} -->`);
        if (this.content) {
          parts.push(this.content);
        }
        if (this.children.length > 0) {
          parts.push('');
          for (const child of this.children) {
            parts.push(child.toAmdString());
          }
        }
        parts.push(`<!-- /${tagName} -->`);
      } else if (isBlockStyle) {
        // Block-style tag: <!-- <tag-name> -->content<!-- </tag-name> -->
        parts.push(`<!-- <${tagName}> -->`);
        if (this.content) {
          parts.push(this.content);
        }
        if (this.children.length > 0) {
          parts.push('');
          for (const child of this.children) {
            parts.push(child.toAmdString());
          }
        }
        parts.push(`<!-- </${tagName}> -->`);
      } else {
        // Simple tag: <!-- tag-name --> or <!-- tag-name: value -->
        if (tagValue) {
          parts.push(`<!-- ${tagName}: ${tagValue} -->`);
        } else {
          parts.push(`<!-- ${tagName} -->`);
        }
      }
    } else if (this.isSelfClosing) {
      // Self-closing element: <!-- <flow-xxx attr="val" /> -->
      parts.push(this.formatOpenTag(true));
      if (this.content) {
        parts.push(this.content);
      }
    } else {
      // Block element: open tag, content, children, close tag
      parts.push(this.formatOpenTag(false));
      if (this.content) {
        parts.push(this.content);
      }
      if (this.children.length > 0) {
        parts.push('');
        for (const child of this.children) {
          parts.push(child.toAmdString());
        }
      }
      parts.push(this.formatCloseTag());
    }

    return parts.join('\n');
  }

  /**
   * Format the opening tag as HTML comment
   */
  private formatOpenTag(selfClosing: boolean): string {
    const attrs = this.formatAttributes();
    const closing = selfClosing ? ' />' : '>';
    return `<!-- <flow-${this.elementType}${attrs}${closing} -->`;
  }

  /**
   * Format the closing tag as HTML comment
   */
  private formatCloseTag(): string {
    return `<!-- </flow-${this.elementType}> -->`;
  }

  /**
   * Format attributes as a string for the tag
   */
  private formatAttributes(): string {
    const entries = Object.entries(this.attributes);
    if (entries.length === 0) {
      return '';
    }
    const attrs = entries.map(([k, v]) => `${k}="${v}"`).join(' ');
    return ` ${attrs}`;
  }

  // ============ String Representation ============

  /**
   * String representation for debugging
   */
  toString(): string {
    const attrs = Object.entries(this.attributes)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const attrStr = attrs ? ` ${attrs}` : '';
    const childCount = this.children.length > 0 ? ` [${this.children.length} children]` : '';
    const contentPreview = this.content.length > 30 ? this.content.slice(0, 30) + '...' : this.content;
    return `<flow-${this.elementType}${attrStr}>${contentPreview}${childCount}`;
  }
}
