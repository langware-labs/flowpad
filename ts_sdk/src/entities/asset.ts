/**
 * Asset entity removed. ASSET_TYPE and ASSET_SCOPE constants kept for backward compatibility.
 */

export const ASSET_SCOPE = {
  USER: 'user',
  PROJECT: 'project',
  SESSION: 'session',
  SYSTEM: 'system',
  FOLDER: 'folder',
} as const;

export type AssetScope = (typeof ASSET_SCOPE)[keyof typeof ASSET_SCOPE];

export const ASSET_TYPE = {
  DOC: 'doc',
  FOLDER: 'folder',
  WORKFLOW: 'workflow',
  SKILL: 'skill',
  AGENT: 'agent',
  MEMORY: 'memory',
  TEMPLATE: 'template',
} as const;

export type AssetType = (typeof ASSET_TYPE)[keyof typeof ASSET_TYPE];
