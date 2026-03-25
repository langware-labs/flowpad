import { FlowDataType } from './flow-data';

/**
 * XML parsing utilities for attribute extraction and data type determination
 */

/**
 * Parse XML attributes from a tag string
 */
export function parseAttributes(tagString: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  // Extract just the tag name without attributes for splitting
  const spaceIndex = tagString.indexOf(' ');
  if (spaceIndex === -1) {
    // No attributes found - default to string type
    attributes['data-type'] = 'string';
    return attributes;
  }

  const attributeString = tagString.substring(spaceIndex + 1);

  // Simple regex to match key="value" or key='value' patterns (including hyphens in attribute names)
  const attributeRegex = /([\w-]+)=["']([^"']*?)["']/g;
  let match;

  while ((match = attributeRegex.exec(attributeString)) !== null) {
    const [, key, value] = match;
    attributes[key] = value;
  }

  // If no data-type was parsed, default to string type
  if (!attributes['data-type']) {
    attributes['data-type'] = 'string';
  }

  return attributes;
}

/**
 * Determine the appropriate data type for the content
 */
export function determineDataType(content: string, eventType: string): FlowDataType | 'json' | 'text' | 'unknown' {
  // Try to detect JSON content
  if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
    try {
      JSON.parse(content);
      return FlowDataType.Object;
    } catch {
      // Not valid JSON, fall through to other checks
    }
  }

  // Entity types are typically result, env-var, checkpoint events with structured data
  if (['result', 'env-var', 'checkpoint'].includes(eventType)) {
    return FlowDataType.Entity;
  }

  // System events that should be treated specially
  if (['status', 'focus', 'mode'].includes(eventType)) {
    return 'unknown'; // Keeps this for debugging these specific types
  }

  // Most flow events default to string (content, chunk, test events, etc.)
  return FlowDataType.String;
}

/**
 * Check if all string chunks are present in queue_str in exact order
 * (but may have more characters in between chunks)
 */
export function waitForChunks(queueStr: string, chunks: string[]): boolean {
  let searchStart = 0;

  for (const chunk of chunks) {
    const index = queueStr.indexOf(chunk, searchStart);
    if (index === -1) {
      return false; // Chunk not found
    }
    searchStart = index + chunk.length; // Move search position after found chunk
  }

  return true; // All chunks found in order
}

/**
 * Decode XML entities in content
 * Handles HTML/XML entities like &gt;, &lt;, &amp;, &quot;, &apos;, &#123;, etc.
 */
export function decodeXMLEntities(text: string | null | undefined): string {
  if (!text) {
    return '';
  }
  if (typeof text !== 'string') {
    return text;
  }
  // Create a temporary element to use browser's built-in entity decoder
  const element = document.createElement('textarea');
  element.innerHTML = text;
  return element.value;
}

/**
 * Generate a unique key for event identification
 */
export class KeyGenerator {
  private keyCounter: number = 0;

  generateKey(): string {
    this.keyCounter += 1;
    return `k${this.keyCounter}`;
  }

  reset(): void {
    this.keyCounter = 0;
  }
}
