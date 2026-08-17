import type { FSEntry } from '@sdk';
import { File, Folder, Sparkles, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Scope enum for skill/activation path prefixes.
 * Moved here from SkillsViewer to break the dependency.
 */
export enum SkillsScope {
  User = 'user-skills',
  Project = 'project-skills',
  System = 'system-skills',
  UserActivations = 'user-activations',
  ProjectActivations = 'project-activations',
}

/**
 * Path checking utilities for skills and activations
 */

/**
 * Get the depth of an item within a specific path marker
 * Returns the number of path segments after the marker, or -1 if marker not found
 */
export function getPathDepthAfterMarker(path: string, marker: string): number {
  const markerIndex = path.indexOf(marker);
  if (markerIndex === -1) return -1;

  const pathAfterMarker = path.substring(markerIndex + marker.length + 1); // +1 for trailing slash
  const segments = pathAfterMarker.split('/').filter((s) => s.length > 0);
  return segments.length;
}

/**
 * Check if an item is inside an activation folder (skill_rules)
 */
export function isInActivationFolder(item: FSEntry): boolean {
  return item.vfs_abs_path.includes('skill_rules');
}

/**
 * Check if an item is a direct child of skill_rules (an activation rule folder)
 */
export function isActivationRuleFolder(item: FSEntry): boolean {
  if (!item.is_dir) return false;
  const depth = getPathDepthAfterMarker(item.vfs_abs_path, 'skill_rules');
  return depth === 1;
}

/**
 * Check if an item is a skill folder (direct child of .claude/skills)
 */
export function isUserOrProjectSkillFolder(item: FSEntry): boolean {
  if (!item.is_dir) return false;
  const depth = getPathDepthAfterMarker(item.vfs_abs_path, '.claude/skills');
  return depth === 1;
}

/**
 * Check if an item is a system skill folder (direct child of .flow/system_skills)
 */
export function isSystemSkillFolder(item: FSEntry): boolean {
  if (!item.is_dir) return false;
  const depth = getPathDepthAfterMarker(item.vfs_abs_path, '.flow/system_skills');
  return depth === 1;
}

/**
 * Check if an item is any type of skill folder
 */
export function isSkillFolder(item: FSEntry): boolean {
  return isUserOrProjectSkillFolder(item) || isSystemSkillFolder(item);
}

/**
 * Check if an item is a root activation folder (User Activations or Project Activations)
 */
export function isActivationRootFolder(item: FSEntry): boolean {
  return item.display_name === 'User Activations' || item.display_name === 'Project Activations';
}

/**
 * Render the appropriate icon for a skills/activations tree item
 */
export function renderSkillsItemIcon(item: FSEntry): ReactNode {
  if (item.is_dir) {
    // Activation rule folder (direct child of skill_rules) - lightning icon
    if (isActivationRuleFolder(item)) {
      return <Zap className="h-4 w-4 flex-shrink-0 text-yellow-500" />;
    }

    // Skill folder (direct child of .claude/skills or .flow/system_skills) - sparkles icon
    if (isSkillFolder(item)) {
      return <Sparkles className="h-4 w-4 flex-shrink-0 text-purple-500" />;
    }

    // Default folder icon
    return <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
  }

  // Default file icon
  return <File className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
}

/**
 * Check if a filename is allowed in activation folders
 */
export function isAllowedActivationFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower === 'rule.md' || lower === 'trigger.py' || lower.includes('eval') || lower.startsWith('test_');
}
