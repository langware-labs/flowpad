import { ActivationMetadata } from './ActivationMetadata';

/**
 * A complete activation rule
 */
export interface ActivationRule {
  /** Path to activation rule folder (relative to .flow/skill_rules/) */
  path: string;
  /** Folder name */
  folderName: string;
  /** Parsed YAML frontmatter from rule.md */
  metadata: ActivationMetadata;
  /** rule.md body (content after frontmatter) */
  ruleContent: string;
  /** Full raw rule.md content */
  rawRuleContent: string;
  /** trigger.py content */
  triggerContent: string;
  /** True if the rule was newly created or had empty files (template content was used) */
  isNewOrEmpty?: boolean;
}

/**
 * Activation list item (lightweight, for sidebar display)
 */
export interface ActivationListItem {
  /** Folder name */
  name: string;
  /** Full path relative to entity root */
  path: string;
}
