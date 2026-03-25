/**
 * Scope — mirrors Python `resource_management.api.scope.Scope`.
 * Determines where a filesystem record is stored.
 */
export enum Scope {
  MANAGED = 'managed',
  USER = 'user',
  GLOBAL = 'global',
  PROJECT = 'project',
  LOCAL = 'local',
  LEGACY = 'legacy',
}
