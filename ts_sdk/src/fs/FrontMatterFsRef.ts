/**
 * FrontMatterFsRef — markdown file with YAML frontmatter, backed by FSRef.
 *
 * Extends FSRef so it carries its own TypeId and uses inherited read/write.
 * Holds name, description, and markdown body as mutable fields.
 * Call load() to populate from the backend document reader.
 *
 * Usage:
 *   const doc = agent.doc          // FrontMatterFsRef pointing to agent .md file
 *   await doc.load()
 */

import { TypeId } from '../models/TypeId';
import { FSRef } from './FSRef';

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
    const document = await this.readDocument();
    this.name = String(document.fields.name ?? '');
    this.description = String(document.fields.description ?? '');
    this.markdown = document.body;
  }
}
