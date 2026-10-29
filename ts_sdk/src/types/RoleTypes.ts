import { Role, ROLE_ORDER } from '../models/roles';
export { Role } from '../models/roles';
export function isRole(value: string): value is Role {
  return (ROLE_ORDER as readonly string[]).includes(value);
}
export function getRoleDisplayName(role: Role): string {
  return role === 'owner_by_api' ? 'Owner by API' : role.charAt(0).toUpperCase() + role.slice(1);
}
