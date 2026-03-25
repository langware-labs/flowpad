import { FileItem } from './types';

export enum FilterName {
  HIDDEN = 'hidden',
  SKILLS_PATH = 'skills_path',
  MARKDOWN_ONLY = 'markdown_only',
}

export interface FilterDefinition {
  name: FilterName;
  label: string;
  filterFn: (item: FileItem) => boolean;
}

/**
 * Skills folder path constant
 */
const SKILLS_FOLDER_PATH = '.claude/skills';

/**
 * Built-in filter definitions
 */
export const FILTER_DEFINITIONS: Record<FilterName, FilterDefinition> = {
  [FilterName.HIDDEN]: {
    name: FilterName.HIDDEN,
    label: 'Hidden files',
    filterFn: (item) => !item.name.startsWith('.'),
  },
  [FilterName.SKILLS_PATH]: {
    name: FilterName.SKILLS_PATH,
    label: 'Skills folder only',
    filterFn: (item) => item.path.startsWith(SKILLS_FOLDER_PATH),
  },
  [FilterName.MARKDOWN_ONLY]: {
    name: FilterName.MARKDOWN_ONLY,
    label: 'Markdown files',
    filterFn: (item) => !item.name.startsWith('.') && (item.type === 'folder' || item.path.endsWith('.md')),
  },
};

/**
 * Get all available filter definitions as an array
 */
export function getAllFilterDefinitions(): FilterDefinition[] {
  return Object.values(FILTER_DEFINITIONS);
}

/**
 * Get specific filter definitions by their names
 */
export function getFilterDefinitions(names: FilterName[]): FilterDefinition[] {
  return names.map((name) => FILTER_DEFINITIONS[name]);
}
