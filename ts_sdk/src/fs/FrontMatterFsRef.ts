/**
 * FrontMatterFsRef — markdown file with YAML frontmatter, backed by FSRef.
 *
 * Extends FSRef so it carries its own TypeId and uses inherited read/write.
 * Holds name, description, and markdown body as mutable fields.
 * Call load() to populate from disk, save() to write back.
 *
 * Usage:
 *   const doc = agent.doc          // FrontMatterFsRef pointing to agent .md file
 *   await doc.load()
 *   doc.description = 'Does X'
 *   await doc.save()
 */

import { TypeId } from '../models/TypeId';
import { FSRef } from './FSRef';
import { parseFrontmatterDoc } from './frontmatter-parse';

// ── Parse/serialize helpers ────────────────────────────────────────────────

export function parseFrontmatter(raw: string): Record<string, string> {
  return parseFrontmatterDoc(raw).fields;
}

export function extractBody(raw: string): string {
  return parseFrontmatterDoc(raw).body;
}

export function serializeDoc(fm: Record<string, string>, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    // Quote values that contain special characters
    const needsQuote = /[:#\[\]{},|>&*!%@`]/.test(v) || v.startsWith(' ') || v.endsWith(' ');
    lines.push(needsQuote ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`);
  }
  lines.push('---', '');
  if (body) lines.push(body);
  return lines.join('\n');
}

// ── FrontMatterFsRef ───────────────────────────────────────────────────────

export class FrontMatterFsRef extends FSRef {
  /** Frontmatter field: the name of this document */
  name: string = '';
  /** Frontmatter field: short description */
  description: string = '';
  /** The markdown body (everything after the closing --- delimiter) */
  markdown: string = '';

  constructor(path: string, typeId: TypeId, readOnly = false) {
    super(path, typeId, 'file', readOnly);
  }

  /** Create a FrontMatterFsRef from an existing FSRef (same path/typeId). */
  static fromFSRef(ref: FSRef): FrontMatterFsRef {
    const json = ref.toJSON();
    return new FrontMatterFsRef(json.path, new TypeId(json.type_id), json.read_only);
  }

  /** Read the file from disk and populate name, description, markdown. */
  async load(): Promise<void> {
    const raw = await this.read();
    const fm = parseFrontmatter(raw);
    this.name = fm['name'] ?? '';
    this.description = fm['description'] ?? '';
    this.markdown = extractBody(raw);
  }

  /** Serialize name, description, and markdown back to the file on disk. */
  async save(): Promise<void> {
    const fm: Record<string, string> = {};
    if (this.name) fm['name'] = this.name;
    if (this.description !== undefined) fm['description'] = this.description;
    const content = serializeDoc(fm, this.markdown);
    await this.write(content);
  }
}
