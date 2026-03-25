import { genInstructionId, InstructionElement, InstructionElementType } from '@sdk';
import { isContainerType } from '../types';

/**
 * Create a new InstructionElement with appropriate defaults for the given type
 */
export function createInstructionElement(
  type: InstructionElementType,
  attributes: Record<string, string> = {},
  content: string = '',
): InstructionElement {
  const isSelfClosing = !isContainerType(type);
  const isMarkless = type === 'text';

  // Add default id for 'do' blocks
  const defaultAttrs: Record<string, string> = type === 'do' ? { id: genInstructionId() } : {};

  return new InstructionElement(type, { ...defaultAttrs, ...attributes }, content, isSelfClosing, 0, null, isMarkless);
}

/**
 * Create a simple do block with content
 */
export function createDoBlock(content: string, id?: string): InstructionElement {
  return createInstructionElement('do', id ? { id } : { id: genInstructionId() }, content);
}

/**
 * Create an if block with a test expression
 */
export function createIfBlock(test: string, children: InstructionElement[] = []): InstructionElement {
  const el = createInstructionElement('if', { test }, '');
  children.forEach((child) => el.addChild(child));
  return el;
}

/**
 * Create an each block with items and iterator variable
 */
export function createEachBlock(items: string, as: string, children: InstructionElement[] = []): InstructionElement {
  const el = createInstructionElement('each', { items, as }, '');
  children.forEach((child) => el.addChild(child));
  return el;
}

/**
 * Create a set block to store a variable
 */
export function createSetBlock(name: string, value: string): InstructionElement {
  return createInstructionElement('set', { name, value }, '');
}

/**
 * Create a UI block
 */
export function createUiBlock(uri: string, page?: string, params?: string): InstructionElement {
  const attrs: Record<string, string> = { uri };
  if (page) attrs.page = page;
  if (params) attrs.params = params;
  return createInstructionElement('ui', attrs, '');
}

/**
 * Create a block container
 */
export function createBlockBlock(
  children: InstructionElement[] = [],
  agentic: boolean = true,
  id?: string,
): InstructionElement {
  const attrs: Record<string, string> = {};
  if (id) attrs.id = id;
  if (!agentic) attrs.agentic = 'false';
  const el = createInstructionElement('block', attrs, '');
  children.forEach((child) => el.addChild(child));
  return el;
}

/**
 * Create a call block to reference another file
 */
export function createCallBlock(href: string, description?: string): InstructionElement {
  return createInstructionElement('call', { href }, description || '');
}
