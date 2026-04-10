/**
 * FrontMatterFsRef — in-memory document model for a markdown file with YAML frontmatter.
 *
 * Holds name, description, and markdown body as mutable fields.
 * Call load() to populate from disk, save() to write back.
 * The compute node TypeId is resolved from dataContext.computeNodeTypeId at call time —
 * throws Error('Compute node not available') if not set (i.e. before bootstrap).
 *
 * Usage:
 *   const doc = agent.doc          // FrontMatterFsRef pointing to agent .md file
 *   await doc.load()
 *   doc.description = 'Does X'
 *   await doc.save()
 */

import { dataContext } from '../FlowSync/context';
import { TypeId } from '../models/TypeId';

// ── Parse/serialize helpers ────────────────────────────────────────────────

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = val;
  }
  return result;
}

function extractBody(raw: string): string {
  const match = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  return match ? match[1] : raw;
}

function serializeDoc(fm: Record<string, string>, body: string): string {
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

export class FrontMatterFsRef {
  readonly path: string;

  /** Frontmatter field: the name of this document */
  name: string = '';
  /** Frontmatter field: short description */
  description: string = '';
  /** The markdown body (everything after the closing --- delimiter) */
  markdown: string = '';

  constructor(path: string) {
    this.path = path;
  }

  private getTypeId(): TypeId {
    const typeId = dataContext.computeNodeTypeId;
    if (!typeId) throw new Error('Compute node not available');
    return typeId;
  }

  /** Read the file from disk and populate name, description, markdown. */
  async load(): Promise<void> {
    const typeId = this.getTypeId();
    const { fsManager } = await import('../services/fsService');
    const raw = (await fsManager.download(typeId, this.path)) as string;
    const fm = parseFrontmatter(raw);
    this.name = fm['name'] ?? '';
    this.description = fm['description'] ?? '';
    this.markdown = extractBody(raw);
  }

  /** Serialize name, description, and markdown back to the file on disk. */
  async save(): Promise<void> {
    const typeId = this.getTypeId();
    const { fsManager } = await import('../services/fsService');
    const fm: Record<string, string> = {};
    if (this.name) fm['name'] = this.name;
    if (this.description !== undefined) fm['description'] = this.description;
    const content = serializeDoc(fm, this.markdown);
    await fsManager.writeFile(typeId, this.path, content);
  }
}
