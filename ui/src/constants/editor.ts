/**
 * Extension for compiled markdown output files
 */
export const COMPILED_MARKDOWN_EXTENSION = 'mdo';

/**
 * Custom view types supported in the editor and result cards
 */
export const CUSTOM_VIEW = {
  markdown: 'markdown',
  html: 'html',
} as const;

export type CustomViewType = (typeof CUSTOM_VIEW)[keyof typeof CUSTOM_VIEW];

/**
 * Check if a language has a custom view available
 */
export const isCustomViewAvailable = (language: string): boolean => {
  return language in CUSTOM_VIEW;
};
