/**
 * Skill metadata from YAML frontmatter in SKILL.md
 */
export interface SkillMetadata {
  /** Skill identifier (lowercase, hyphens) */
  name: string;
  /** What the skill does and when to use it */
  description: string;
  /** Optional list of permitted tools */
  allowedTools: string[];
  /** Optional list of tags for categorization */
  tags: string[];
  /** Additional frontmatter fields */
  extra: Record<string, unknown>;
}

/**
 * Create a default skill metadata object
 */
export function createDefaultSkillMetadata(name: string): SkillMetadata {
  return {
    name,
    description: '',
    allowedTools: [],
    tags: [],
    extra: {},
  };
}
