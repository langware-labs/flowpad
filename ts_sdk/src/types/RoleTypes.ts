/**
 * User roles in the FlowPad system
 * Defines permission levels for entity access
 */
export enum Role {
  OWNER = 'owner',
  ADMIN = 'admin',
  EDITOR = 'editor',
  READER = 'reader',
  GUEST = 'guest',
  ANONYMOUS_VIEWER = 'anonymous_viewer',
}

/**
 * Type guard to check if a string is a valid Role
 */
export function isRole(value: string): value is Role {
  return Object.values(Role).includes(value as Role);
}

/**
 * Get role display name for UI
 */
export function getRoleDisplayName(role: Role): string {
  switch (role) {
    case Role.OWNER:
      return 'Owner';
    case Role.ADMIN:
      return 'Admin';
    case Role.EDITOR:
      return 'Editor';
    case Role.READER:
      return 'Reader';
    case Role.GUEST:
      return 'Guest';
    case Role.ANONYMOUS_VIEWER:
      return 'Anonymous Viewer';
    default:
      return role;
  }
}
