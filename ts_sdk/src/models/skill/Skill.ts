import { SkillMetadata } from './SkillMetadata';

/**
 * A complete Claude Code skill
 */
export interface Skill {
  /** Path to skill folder (relative to .claude/skills/) */
  path: string;
  /** Folder name */
  folderName: string;
  /** Parsed YAML frontmatter */
  metadata: SkillMetadata;
  /** SKILL.md body (instructions after frontmatter) */
  content: string;
  /** Full raw SKILL.md content */
  rawContent: string;
}

/**
 * Skill list item (lightweight, for sidebar display)
 */
export interface SkillListItem {
  /** Folder name */
  name: string;
  /** Full path relative to entity root */
  path: string;
}
