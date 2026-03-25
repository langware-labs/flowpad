/**
 * Instruction element types for flow control in MDO files.
 * These elements are embedded in HTML comments: <!-- <flow-do .../> -->
 */

export const InstructionElementTypes = {
  DO: 'do',
  IF: 'if',
  EACH: 'each',
  SET: 'set',
  CALL: 'call',
  HEADER: 'header',
  UI: 'ui',
  BLOCK: 'block',
  TEXT: 'text',
  TAG: 'tag',
} as const;

export type InstructionElementType = (typeof InstructionElementTypes)[keyof typeof InstructionElementTypes];

/**
 * Check if a string is a valid InstructionElementType
 */
export function isInstructionElementType(value: string): value is InstructionElementType {
  return Object.values(InstructionElementTypes).includes(value as InstructionElementType);
}

/**
 * Normalize element type by stripping 'flow-' prefix if present
 */
export function normalizeInstructionElementType(value: string): string {
  const TAG_PREFIX = 'flow-';
  return value.startsWith(TAG_PREFIX) ? value.substring(TAG_PREFIX.length) : value;
}
