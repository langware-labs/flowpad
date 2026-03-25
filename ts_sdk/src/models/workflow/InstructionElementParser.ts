import { InstructionElement } from './InstructionElement';
import { isInstructionElementType } from './InstructionElementTypes';

/**
 * Parser error with position information
 */
export class ParseError extends Error {
  public readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.position = position;
    this.name = 'ParseError';
  }
}

/**
 * InstructionElementParser parses markdown files containing HTML-commented flow elements.
 *
 * Format:
 * - Self-closing: <!-- <flow-do id="1" /> --> content until next element
 * - Open tag: <!-- <flow-if test="$x > 0"> --> content <!-- </flow-if> -->
 * - Close tag: <!-- </flow-if> -->
 * - Function call: <!-- <flow-call href="path/to/file.md" /> --> optional description
 *
 * Features:
 * - Extracts markdown headers and assigns them as titles to following elements
 * - Creates implicit "do" elements for preamble text (markless=true)
 * - Splits content at paragraph breaks for self-closing elements
 *
 * Returns a tree of InstructionElement objects.
 */
export class InstructionElementParser {
  // Pattern to match HTML comments containing flow elements
  // Must handle attributes with > or < in values, e.g., test="$x > 0"
  // Matches: <!-- <flow-tag attr="value" /> --> or <!-- </flow-tag> -->
  private static readonly FLOW_PATTERN =
    /<!--\s*(<\/?flow-[a-z]+(?:\s+[a-zA-Z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?)>\s*-->/g;

  // Pattern to match HTML-commented block tags (opening/closing)
  // Matches: <!-- <tag-name> --> or <!-- </tag-name> -->
  private static readonly HTML_TAG_PATTERN = /<!--\s*(<\/?[a-zA-Z_][\w-]*)>\s*-->/g;

  // Pattern to match hash-prefixed tags (opening/closing)
  // Matches: <!-- #tag-name --> or <!-- /tag-name -->
  private static readonly HASH_TAG_PATTERN = /<!--\s*(#|\/)?([a-zA-Z_][\w-]*)\s*-->/g;

  // Pattern to match simple HTML-commented tags
  // Matches: <!-- tag-name --> or <!-- tag-name: value -->
  private static readonly TAG_PATTERN = /<!--\s*([a-zA-Z_][\w-]*)(?:\s*:\s*([^>]*?))?\s*-->/g;

  // Pattern for parsing attributes
  private static readonly ATTR_PATTERN = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g;

  // Pattern for markdown headers
  private static readonly HEADER_PATTERN = /^\s*#{1,6}\s+(.+?)(?:\n|$)/;

  /**
   * Parse markdown instruction text into an InstructionElement tree
   * @param text The markdown file content
   * @returns Array of InstructionElement objects at the root level
   */
  parse(text: string): InstructionElement[] {
    const root: InstructionElement[] = [];
    const stack: { element: InstructionElement; tagName: string }[] = [];
    let pendingTitle: string | null = null;
    let lastIndex = 0;

    // Collect all matches from all patterns
    const allMatches: Array<{ type: 'flow' | 'html-tag' | 'hash-tag' | 'tag'; match: RegExpExecArray }> = [];

    // Reset the regex lastIndex
    InstructionElementParser.FLOW_PATTERN.lastIndex = 0;
    InstructionElementParser.HTML_TAG_PATTERN.lastIndex = 0;
    InstructionElementParser.HASH_TAG_PATTERN.lastIndex = 0;
    InstructionElementParser.TAG_PATTERN.lastIndex = 0;

    // Collect flow pattern matches
    let match: RegExpExecArray | null;
    while ((match = InstructionElementParser.FLOW_PATTERN.exec(text)) !== null) {
      allMatches.push({ type: 'flow', match });
    }

    // Collect HTML-commented block tag matches
    while ((match = InstructionElementParser.HTML_TAG_PATTERN.exec(text)) !== null) {
      // Check if this is actually a flow element (skip if it is)
      // Note: tagContent includes the leading < or </, so check for '<flow-' not 'flow-'
      const tagContent = match[1];
      if (!tagContent.startsWith('<flow-') && !tagContent.startsWith('</flow-')) {
        allMatches.push({ type: 'html-tag', match });
      }
    }

    // Collect hash-prefixed tag matches
    while ((match = InstructionElementParser.HASH_TAG_PATTERN.exec(text)) !== null) {
      const prefix = match[1]; // '#' or '/' or undefined
      const tagName = match[2];

      // Only process if it has a prefix (# or /)
      // Skip if it's actually a flow element or looks like a simple tag with colon
      if (prefix && !tagName.startsWith('flow-') && tagName !== 'flow') {
        // Make sure this isn't a simple tag with value (contains colon)
        const fullMatch = match[0];
        if (!fullMatch.includes(':')) {
          allMatches.push({ type: 'hash-tag', match });
        }
      }
    }

    // Collect simple tag pattern matches
    while ((match = InstructionElementParser.TAG_PATTERN.exec(text)) !== null) {
      // Check if this is actually a flow element or HTML tag (skip if it is)
      const tagName = match[1];
      if (!tagName.startsWith('flow-') && tagName !== 'flow') {
        // Check if this matches the HTML tag pattern (skip simple tags that look like HTML tags)
        const htmlTagMatch = text.substring(match.index, match.index + match[0].length).match(/<!--\s*<[^>]+>\s*-->/);
        // Check if this matches the hash tag pattern (skip simple tags that look like hash tags)
        const hashTagMatch = text
          .substring(match.index, match.index + match[0].length)
          .match(/<!--\s*(#|\/)[a-zA-Z_][\w-]*\s*-->/);
        if (!htmlTagMatch && !hashTagMatch) {
          allMatches.push({ type: 'tag', match });
        }
      }
    }

    // Sort matches by position
    allMatches.sort((a, b) => a.match.index - b.match.index);

    // Process all matches in order
    for (const { type, match } of allMatches) {
      // Process text before this element
      const textBefore = text.slice(lastIndex, match.index);
      pendingTitle = this.processText(textBefore, root, stack, pendingTitle);

      if (type === 'flow') {
        // Parse the flow tag
        const tagContent = match[1];
        const isSelfClosing = tagContent.trim().endsWith('/') || match[0].trim().endsWith('/>');

        if (tagContent.startsWith('</')) {
          // Closing tag
          this.handleCloseTag(tagContent, stack, match.index);
        } else {
          // Opening or self-closing tag
          const element = this.parseOpenTag(tagContent, isSelfClosing, pendingTitle, match.index);
          if (element) {
            this.addElement(element, root, stack);
            if (!isSelfClosing) {
              const tagName = this.extractTagName(tagContent);
              if (tagName) {
                stack.push({ element, tagName });
              }
            }
            pendingTitle = null;
          }
        }
      } else if (type === 'html-tag') {
        // Parse HTML-commented block tag
        const tagContent = match[1];
        if (tagContent.startsWith('</')) {
          // Closing tag
          this.handleHtmlTagClose(tagContent, stack, match.index);
        } else {
          // Opening tag
          const element = this.parseHtmlTag(tagContent, pendingTitle, match.index);
          if (element) {
            this.addElement(element, root, stack);
            const tagName = this.extractHtmlTagName(tagContent);
            if (tagName) {
              stack.push({ element, tagName });
            }
            pendingTitle = null;
          }
        }
      } else if (type === 'hash-tag') {
        // Parse hash-prefixed tag
        const prefix = match[1]; // '#' or '/'
        const tagName = match[2];

        if (prefix === '/') {
          // Closing tag
          this.handleHashTagClose(tagName, stack, match.index);
        } else if (prefix === '#') {
          // Opening tag
          const element = this.parseHashTag(tagName, pendingTitle, match.index);
          if (element) {
            this.addElement(element, root, stack);
            stack.push({ element, tagName });
            pendingTitle = null;
          }
        }
      } else {
        // Parse the simple tag
        const element = this.parseTag(match, pendingTitle);
        if (element) {
          this.addElement(element, root, stack);
          pendingTitle = null;
        }
      }

      lastIndex = match.index + match[0].length;
    }

    // Process remaining text after last element
    this.processText(text.slice(lastIndex), root, stack, pendingTitle);

    // Strip content whitespace on block elements
    for (const el of root) {
      this.stripBlockContent(el);
    }

    // Check for unclosed tags
    if (stack.length > 0) {
      const unclosed = stack.map((s) => `flow-${s.tagName}`).join(', ');
      throw new ParseError(`Unclosed tags: ${unclosed}`, text.length);
    }

    return root;
  }

  /**
   * Process text between flow elements.
   * Returns updated pendingTitle (extracted from markdown headers).
   */
  private processText(
    text: string,
    root: InstructionElement[],
    stack: { element: InstructionElement; tagName: string }[],
    pendingTitle: string | null,
  ): string | null {
    if (!text.trim()) {
      return pendingTitle;
    }

    // Extract markdown header if present
    const headerMatch = text.match(InstructionElementParser.HEADER_PATTERN);
    if (headerMatch) {
      pendingTitle = headerMatch[1].trim();
      text = text.slice(headerMatch[0].length);
    }

    const textStripped = text.trim();
    if (!textStripped) {
      return pendingTitle;
    }

    if (stack.length > 0) {
      // Inside a block - check if last child is self-closing
      const parent = stack[stack.length - 1].element;
      if (parent.children.length > 0 && parent.children[parent.children.length - 1].isSelfClosing) {
        // Split at paragraph break: first part to child, rest to parent
        const parts = textStripped.split(/\n\s*\n/);
        parent.children[parent.children.length - 1].content = parts[0].trim();
        if (parts.length > 1 && parts.slice(1).join('\n\n').trim()) {
          parent.content += '\n\n' + parts.slice(1).join('\n\n').trim();
        }
      } else {
        // Add to parent's content
        parent.content += textStripped;
      }
    } else {
      // At root level - check if last element is self-closing
      if (root.length > 0 && root[root.length - 1].isSelfClosing && !root[root.length - 1].content) {
        // Split at paragraph break
        const parts = textStripped.split(/\n\s*\n/);
        root[root.length - 1].content = parts[0].trim();
        if (parts.length > 1 && parts.slice(1).join('\n\n').trim()) {
          // Create markless element for remaining text
          const preamble = new InstructionElement(
            'do',
            {},
            parts.slice(1).join('\n\n').trim(),
            false,
            0,
            null,
            true, // markless
          );
          root.push(preamble);
        }
      } else {
        // Create markless element for preamble text
        const preamble = new InstructionElement(
          'do',
          {},
          textStripped,
          false,
          0,
          pendingTitle,
          true, // markless
        );
        root.push(preamble);
        pendingTitle = null;
      }
    }

    return pendingTitle;
  }

  /**
   * Parse an opening or self-closing tag into an element
   */
  private parseOpenTag(
    tagContent: string,
    isSelfClosing: boolean,
    pendingTitle: string | null,
    position: number,
  ): InstructionElement | null {
    const tagName = this.extractTagName(tagContent);
    if (!tagName || !isInstructionElementType(tagName)) {
      return null;
    }

    const attributes = this.parseAttributes(tagContent);

    return new InstructionElement(
      tagName,
      attributes,
      '', // Content will be set from text processing
      isSelfClosing,
      position,
      pendingTitle,
      false, // Not markless - this is an explicit flow element
    );
  }

  /**
   * Parse a simple HTML-commented tag into an element
   * Matches: <!-- tag-name --> or <!-- tag-name: value -->
   */
  private parseTag(match: RegExpExecArray, pendingTitle: string | null): InstructionElement | null {
    const tagName = match[1]; // tag name
    const tagValue = match[2] ? match[2].trim() : ''; // optional value after colon

    const attributes: Record<string, string> = {
      name: tagName,
    };

    if (tagValue) {
      attributes.value = tagValue;
    }

    return new InstructionElement(
      'tag',
      attributes,
      '', // No content for simple tags
      true, // Always self-closing
      match.index,
      pendingTitle,
      false, // Not markless - this is an explicit tag element
    );
  }

  /**
   * Parse an HTML-commented block tag into an element
   * Matches: <!-- <tag-name> -->
   */
  private parseHtmlTag(tagContent: string, pendingTitle: string | null, position: number): InstructionElement | null {
    const tagName = this.extractHtmlTagName(tagContent);
    if (!tagName) {
      return null;
    }

    const attributes: Record<string, string> = {
      name: tagName,
      'block-style': 'true', // Mark this as a block-style tag
    };

    return new InstructionElement(
      'tag',
      attributes,
      '', // Content will be set from text processing
      false, // Not self-closing
      position,
      pendingTitle,
      false, // Not markless - this is an explicit tag element
    );
  }

  /**
   * Extract tag name from HTML-commented block tag content
   * Matches: <tag-name> -> tag-name
   */
  private extractHtmlTagName(tagContent: string): string | null {
    const match = tagContent.match(/^<([a-zA-Z_][\w-]*)/);
    return match ? match[1] : null;
  }

  /**
   * Handle a closing HTML-commented block tag
   */
  private handleHtmlTagClose(
    tagContent: string,
    stack: { element: InstructionElement; tagName: string }[],
    position: number,
  ): void {
    const closeMatch = tagContent.match(/<\/([a-zA-Z_][\w-]*)/);
    if (!closeMatch) {
      return;
    }

    const tagName = closeMatch[1];

    if (stack.length === 0) {
      throw new ParseError(`Unexpected closing tag </${tagName}>`, position);
    }

    const top = stack[stack.length - 1];
    if (top.tagName !== tagName) {
      throw new ParseError(`Mismatched closing tag: expected </${top.tagName}>, got </${tagName}>`, position);
    }

    stack.pop();
  }

  /**
   * Parse a hash-prefixed tag into an element
   * Matches: <!-- #tag-name -->
   */
  private parseHashTag(tagName: string, pendingTitle: string | null, position: number): InstructionElement | null {
    if (!tagName) {
      return null;
    }

    const attributes: Record<string, string> = {
      name: tagName,
      'hash-style': 'true', // Mark this as a hash-style tag
    };

    return new InstructionElement(
      'tag',
      attributes,
      '', // Content will be set from text processing
      false, // Not self-closing
      position,
      pendingTitle,
      false, // Not markless - this is an explicit tag element
    );
  }

  /**
   * Handle a closing hash-prefixed tag
   * Matches: <!-- /tag-name -->
   */
  private handleHashTagClose(
    tagName: string,
    stack: { element: InstructionElement; tagName: string }[],
    position: number,
  ): void {
    if (stack.length === 0) {
      throw new ParseError(`Unexpected closing tag /${tagName}`, position);
    }

    const top = stack[stack.length - 1];
    if (top.tagName !== tagName) {
      throw new ParseError(`Mismatched closing tag: expected /${top.tagName}, got /${tagName}`, position);
    }

    stack.pop();
  }

  /**
   * Handle a closing tag
   */
  private handleCloseTag(
    tagContent: string,
    stack: { element: InstructionElement; tagName: string }[],
    position: number,
  ): void {
    const closeMatch = tagContent.match(/<\/flow-([a-z]+)/);
    if (!closeMatch) {
      return;
    }

    const tagName = closeMatch[1];
    if (!isInstructionElementType(tagName)) {
      return;
    }

    if (stack.length === 0) {
      throw new ParseError(`Unexpected closing tag </flow-${tagName}>`, position);
    }

    const top = stack[stack.length - 1];
    if (top.tagName !== tagName) {
      throw new ParseError(`Mismatched closing tag: expected </flow-${top.tagName}>, got </flow-${tagName}>`, position);
    }

    stack.pop();
  }

  /**
   * Add element to parent or root
   */
  private addElement(
    element: InstructionElement,
    root: InstructionElement[],
    stack: { element: InstructionElement; tagName: string }[],
  ): void {
    if (stack.length > 0) {
      stack[stack.length - 1].element.addChild(element);
    } else {
      root.push(element);
    }
  }

  /**
   * Extract tag name from tag content
   */
  private extractTagName(tagContent: string): string | null {
    const match = tagContent.match(/<\/?flow-([a-z]+)/);
    return match ? match[1] : null;
  }

  /**
   * Parse attributes from tag content
   */
  private parseAttributes(tagContent: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    // Reset the regex lastIndex
    InstructionElementParser.ATTR_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = InstructionElementParser.ATTR_PATTERN.exec(tagContent)) !== null) {
      attributes[match[1]] = match[2];
    }

    return attributes;
  }

  /**
   * Recursively strip whitespace from block element content
   */
  private stripBlockContent(element: InstructionElement): void {
    element.content = element.content.trim();
    for (const child of element.children) {
      this.stripBlockContent(child);
    }
  }
}

/**
 * Convenience function to parse markdown instruction content
 */
export function parseMarkdownInstructions(content: string): InstructionElement[] {
  return new InstructionElementParser().parse(content);
}

/**
 * @deprecated Use parseMarkdownInstructions instead
 */
export const parseMdo = parseMarkdownInstructions;
