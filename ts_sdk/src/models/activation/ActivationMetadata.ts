/**
 * Activation rule metadata from YAML frontmatter in rule.md
 */
export interface ActivationMetadata {
  /** Rule identifier (lowercase, hyphens) */
  name: string;
  /** What the rule does and when it triggers */
  description: string;
  /** Additional frontmatter fields */
  extra: Record<string, unknown>;
}

/**
 * Create a default activation metadata object
 */
export function createDefaultActivationMetadata(name: string): ActivationMetadata {
  return {
    name,
    description: '',
    extra: {},
  };
}
