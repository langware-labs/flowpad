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
 * The exact alphabet the backend's content escaper emits.
 *
 * `_escape_xml_content` is `html.escape(content, quote=False)` — three
 * entities, and quotes are deliberately left alone so a serialized JSON
 * document keeps its structural `"` characters.
 */
const XML_CONTENT_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
};

/**
 * Decode the XML entities the backend escapes into flow-element CONTENT.
 *
 * Deliberately mirrors `_escape_xml_content` and nothing wider. The previous
 * implementation round-tripped the text through a `<textarea>`, which invokes
 * the browser's full HTML parser and therefore resolved the entire named
 * entity set plus numeric and semicolon-less references — `&quot;`, `&quot`,
 * `&#34;`, `&#x22;` all became `"`, and `&copy;` became `©`. No encoder ever
 * produces those, so every one of them was an unpaired decode.
 *
 * That mattered because this runs on both escaped and unescaped producers:
 * the XML stream is escaped, but `get-history` and the JSONL reader ship
 * transcript text verbatim. An agent that writes the six characters `&quot;`
 * into a file left them in the transcript, and decoding them to a bare `"`
 * closed the surrounding JSON string early — `JSON.parse` then threw, the
 * throw escaped FlowData's constructor, and the whole replay was dropped
 * (FLOWPAD-2038). Restricting the alphabet makes those spellings inert while
 * still reversing everything the encoder can actually emit.
 *
 * Single pass, so `&amp;lt;` decodes to `&lt;` and never to `<`. Pure string
 * work — no DOM, so this is usable outside a browser.
 */
export function decodeXMLEntities(text: string | null | undefined): string {
  if (!text) {
    return '';
  }
  if (typeof text !== 'string') {
    return text;
  }
  return text.replace(/&(?:amp|lt|gt);/g, (entity) => XML_CONTENT_ENTITIES[entity]);
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
