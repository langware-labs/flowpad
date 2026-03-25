import { SkillMetadata, createDefaultSkillMetadata } from './SkillMetadata';

/**
 * Result of parsing a SKILL.md file
 */
export interface SkillParseResult {
  metadata: SkillMetadata;
  content: string;
}

/**
 * Error thrown when skill parsing fails
 */
export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillParseError';
  }
}

/**
 * Parser for SKILL.md files with YAML frontmatter
 */
export class SkillParser {
  private static readonly FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

  /**
   * Parse SKILL.md content into metadata and body
   */
  static parse(rawContent: string): SkillParseResult {
    const match = rawContent.match(this.FRONTMATTER_REGEX);

    if (!match) {
      throw new SkillParseError('Invalid SKILL.md format: missing or malformed frontmatter');
    }

    const frontmatterYaml = match[1];
    const content = match[2].trim();

    const metadata = this.parseFrontmatter(frontmatterYaml);

    return { metadata, content };
  }

  /**
   * Parse YAML frontmatter string into SkillMetadata
   */
  private static parseFrontmatter(yaml: string): SkillMetadata {
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
      throw new SkillParseError("Missing 'name' in frontmatter");
    }

    const descRaw = data['description'];
    const description = typeof descRaw === 'string' ? descRaw : '';

    // Parse allowed-tools (can be comma-separated string or array)
    let allowedTools: string[] = [];
    const allowedToolsRaw = data['allowed-tools'];
    if (typeof allowedToolsRaw === 'string') {
      allowedTools = allowedToolsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (Array.isArray(allowedToolsRaw)) {
      allowedTools = allowedToolsRaw.map((t) => String(t).trim()).filter(Boolean);
    }

    // Parse tags (can be comma-separated string or array)
    let tags: string[] = [];
    const tagsRaw = data['tags'];
    if (typeof tagsRaw === 'string') {
      tags = tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (Array.isArray(tagsRaw)) {
      tags = tagsRaw.map((t) => String(t).trim()).filter(Boolean);
    }

    // Collect extra fields
    const knownKeys = ['name', 'description', 'allowed-tools', 'tags'];
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!knownKeys.includes(key)) {
        extra[key] = value;
      }
    }

    return {
      name,
      description,
      allowedTools,
      tags,
      extra,
    };
  }

  /**
   * Serialize metadata and content back to SKILL.md format
   */
  static serialize(metadata: SkillMetadata, content: string): string {
    const lines: string[] = ['---'];

    // Required fields
    lines.push(`name: ${metadata.name}`);

    if (metadata.description) {
      lines.push(`description: ${metadata.description}`);
    }

    // Tags as array
    if (metadata.tags.length > 0) {
      lines.push('tags:');
      for (const tag of metadata.tags) {
        lines.push(`  - ${tag}`);
      }
    }

    // Allowed tools as comma-separated
    if (metadata.allowedTools.length > 0) {
      lines.push(`allowed-tools: ${metadata.allowedTools.join(', ')}`);
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
   * Create a new skill template
   */
  static createTemplate(name: string): string {
    const metadata = createDefaultSkillMetadata(name);
    metadata.description = 'Brief description of what this skill does';
    metadata.tags = ['example'];
    metadata.allowedTools = ['Read', 'Write', 'Edit', 'Bash'];

    const content = `# ${name}

## Instructions

Add your skill instructions here...
`;

    return this.serialize(metadata, content);
  }
}
