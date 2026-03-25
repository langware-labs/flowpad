import { ActivationMetadata, createDefaultActivationMetadata } from './ActivationMetadata';

/**
 * Result of parsing a rule.md file
 */
export interface ActivationParseResult {
  metadata: ActivationMetadata;
  content: string;
}

/**
 * Error thrown when activation rule parsing fails
 */
export class ActivationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivationParseError';
  }
}

/**
 * Parser for rule.md files with YAML frontmatter
 */
export class ActivationParser {
  private static readonly FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

  /**
   * Parse rule.md content into metadata and body
   */
  static parse(rawContent: string): ActivationParseResult {
    const match = rawContent.match(this.FRONTMATTER_REGEX);

    if (!match) {
      throw new ActivationParseError('Invalid rule.md format: missing or malformed frontmatter');
    }

    const frontmatterYaml = match[1];
    const content = match[2].trim();

    const metadata = this.parseFrontmatter(frontmatterYaml);

    return { metadata, content };
  }

  /**
   * Parse YAML frontmatter string into ActivationMetadata
   */
  private static parseFrontmatter(yaml: string): ActivationMetadata {
    const lines = yaml.split('\n');
    const data: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentArrayItems: string[] = [];
    let inArray = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) continue;

      // Check for array item
      if (trimmed.startsWith('- ')) {
        if (currentKey && inArray) {
          currentArrayItems.push(trimmed.slice(2).trim());
        }
        continue;
      }

      // Save previous array if we're starting a new key
      if (inArray && currentKey) {
        data[currentKey] = currentArrayItems;
        currentArrayItems = [];
        inArray = false;
      }

      // Parse key: value
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 0) {
        const key = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();

        currentKey = key;

        if (value === '') {
          // Could be start of array or multi-line
          inArray = true;
          currentArrayItems = [];
        } else {
          data[key] = value;
          inArray = false;
        }
      }
    }

    // Save final array if any
    if (inArray && currentKey) {
      data[currentKey] = currentArrayItems;
    }

    // Extract required fields
    const nameRaw = data['name'];
    const name = typeof nameRaw === 'string' ? nameRaw : '';
    if (!name) {
      throw new ActivationParseError("Missing 'name' in frontmatter");
    }

    const descRaw = data['description'];
    const description = typeof descRaw === 'string' ? descRaw : '';

    // Collect extra fields
    const knownKeys = ['name', 'description'];
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!knownKeys.includes(key)) {
        extra[key] = value;
      }
    }

    return {
      name,
      description,
      extra,
    };
  }

  /**
   * Serialize metadata and content back to rule.md format
   */
  static serialize(metadata: ActivationMetadata, content: string): string {
    const lines: string[] = ['---'];

    // Required fields
    lines.push(`name: ${metadata.name}`);

    if (metadata.description) {
      lines.push(`description: ${metadata.description}`);
    }

    // Extra fields
    for (const [key, value] of Object.entries(metadata.extra)) {
      if (Array.isArray(value)) {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      } else {
        lines.push(`${key}: ${String(value)}`);
      }
    }

    lines.push('---');
    lines.push('');
    lines.push(content);

    return lines.join('\n');
  }

  /**
   * Create a new activation rule template
   */
  static createRuleTemplate(name: string): string {
    const metadata = createDefaultActivationMetadata(name);
    metadata.description = 'Brief description of when this rule activates';

    const content = `# ${name}

## Activation Conditions

Describe when this rule should activate...

## Instructions

Add the instructions that will be injected when this rule activates...
`;

    return this.serialize(metadata, content);
  }

  /**
   * Create a new trigger.py template
   */
  static createTriggerTemplate(): string {
    return `"""
Activation trigger for this rule.
The evaluate() function is called to determine if this rule should activate.
"""

def evaluate(hooks_data: dict, transcript: list) -> str | None:
    """
    Evaluate whether this activation rule should trigger.

    Args:
        hooks_data: Dictionary containing hook context data
        transcript: List of conversation messages

    Returns:
        None if the rule should not activate,
        or a string message to inject if it should activate.
    """
    # Example: Check if the last message mentions a specific topic
    # if transcript and "deployment" in transcript[-1].get("content", "").lower():
    #     return "Include deployment guidelines..."

    return None
`;
  }
}
