import type { FSItem } from '@sdk';
import { ExternalLink, FilePlus, FolderPlus, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * Action name type - allows any string for custom actions
 */
export type FSActionName = string;

/**
 * File system action button configuration
 */
export interface FSActionButton {
  /** Unique action name */
  name: FSActionName;
  /** Icon component to display */
  icon: ComponentType<{ className?: string }>;
  /** Tooltip text */
  tooltip: string;
  /** Determines if action should be visible for given item */
  onHover: (item: FSItem) => boolean;
  /** Handler called when action is clicked */
  onClick: (item: FSItem, event: React.MouseEvent) => void | Promise<void>;
}

/**
 * Factory: Create file action
 * Shows on folders only
 */
export function createFileAction(onClick: (item: FSItem, e: React.MouseEvent) => void | Promise<void>): FSActionButton {
  return {
    name: 'create-file',
    icon: FilePlus,
    tooltip: 'New file',
    onHover: (item) => item.is_dir ?? false,
    onClick,
  };
}

/**
 * Factory: Create folder action
 * Shows on folders only
 */
export function createFolderAction(
  onClick: (item: FSItem, e: React.MouseEvent) => void | Promise<void>,
): FSActionButton {
  return {
    name: 'create-folder',
    icon: FolderPlus,
    tooltip: 'New folder',
    onHover: (item) => item.is_dir ?? false,
    onClick,
  };
}

/**
 * Factory: Delete action
 * Shows on all items
 */
export function deleteAction(onClick: (item: FSItem, e: React.MouseEvent) => void | Promise<void>): FSActionButton {
  return {
    name: 'delete',
    icon: Trash2,
    tooltip: 'Delete',
    onHover: () => true,
    onClick,
  };
}

/**
 * Factory: Refresh action
 * Shows on folders only
 */
export function refreshAction(onClick: (item: FSItem, e: React.MouseEvent) => void | Promise<void>): FSActionButton {
  return {
    name: 'refresh',
    icon: RefreshCw,
    tooltip: 'Refresh',
    onHover: (item) => item.is_dir ?? false,
    onClick,
  };
}

/**
 * Factory: Open action
 * Shows on folders only
 */
export function openAction(onClick: (item: FSItem, e: React.MouseEvent) => void | Promise<void>): FSActionButton {
  return {
    name: 'open',
    icon: ExternalLink,
    tooltip: 'Open',
    onHover: (item) => item.is_dir ?? false,
    onClick,
  };
}

/**
 * Factory: Run skill action
 * Shows on skill.md or main.md files only
 */
export function runSkillAction(onClick: (item: FSItem, e: React.MouseEvent) => void | Promise<void>): FSActionButton {
  return {
    name: 'run-skill',
    icon: Play,
    tooltip: 'Run skill',
    onHover: (item) => {
      // Show only for skill.md or main.md files
      if (item.is_dir) return false;
      const fileName = item.name.toLowerCase();
      return fileName === 'skill.md' || fileName === 'main.md';
    },
    onClick,
  };
}
