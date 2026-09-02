/**
 * `RagIndex` — a searchable index over a set of project folders.
 *
 * The TypeScript mirror of `flow_sdk/builtin/rag_index.py`, maintained by hand 1:1.
 *
 * `roots` is the list of folders the index covers, derived on the backend from context links to
 * `Folder` entities rather than stored as a field — so it arrives read-only. Everything under a
 * root is covered; only the roots themselves carry a marker in the tree, because that is where
 * the coverage was chosen.
 */

import { APIEntity, registerEntity } from '../APIEntity';
import type { IEntity } from '../IEntity';

/** Where an index is in its life. A separate axis from whether it can run right now. */
export enum RagStatus {
  /** Created; nothing funds embeddings yet. */
  Setup = 'setup',
  Active = 'active',
  /** Paused by a person. Only a person moves it out. */
  Disabled = 'disabled',
}

export interface IRagIndex extends IEntity {
  name?: string;
  description?: string;
  status?: RagStatus | string;
  pending?: boolean;
  endpoint_typeid?: string;
  model?: string;
  dimensions?: number;
  chunk_count?: number;
  document_count?: number;
  last_indexed_at?: string | null;
  last_error?: string;
  roots?: string[];
}

@registerEntity
export class RagIndex extends APIEntity<RagIndex> implements IRagIndex {
  static type: string = 'rag_index';

  name: string = '';
  description: string = '';
  status: RagStatus | string = RagStatus.Setup;
  /** A covered document changed and the background pass has not caught up yet. */
  pending: boolean = false;
  /** Which `LLMEndpoint` funds the embeddings; empty ⇒ whatever funds this box. */
  endpoint_typeid: string = '';
  /** Both pinned at the first embed. Changing either is a rebuild, not a top-up. */
  model: string = '';
  dimensions: number = 0;
  chunk_count: number = 0;
  document_count: number = 0;
  last_indexed_at: string | null = null;
  /** Rendered verbatim; the backend owns this sentence. */
  last_error: string = '';
  /** Read-only: computed from the folder context links. */
  roots: string[] = [];

  constructor(entity: Partial<IRagIndex> = {}) {
    super(entity);
    this.name = entity.name ?? this.name;
    this.description = entity.description ?? this.description;
    this.status = entity.status ?? this.status;
    this.pending = entity.pending ?? this.pending;
    this.endpoint_typeid = entity.endpoint_typeid ?? this.endpoint_typeid;
    this.model = entity.model ?? this.model;
    this.dimensions = entity.dimensions ?? this.dimensions;
    this.chunk_count = entity.chunk_count ?? this.chunk_count;
    this.document_count = entity.document_count ?? this.document_count;
    this.last_indexed_at = entity.last_indexed_at ?? this.last_indexed_at;
    this.last_error = entity.last_error ?? this.last_error;
    this.roots = entity.roots ?? this.roots;
  }

  /**
   * Replace `roots` wholesale instead of letting the merge touch it.
   *
   * `deepAssign` merges arrays BY INDEX and never shrinks the target, so a wire value with one
   * fewer root leaves the removed path sitting in the cached entity — the folder keeps its brain
   * in every open tree until a reload. Strip the field from the payload after assigning it, since
   * `onEntityUpdate` runs BEFORE the merge.
   */
  onEntityUpdate(source: Partial<IRagIndex>): void {
    if (Array.isArray(source.roots)) {
      this.roots = [...source.roots];
      delete source.roots;
    }
  }

  get isActive(): boolean {
    return this.status === RagStatus.Active;
  }
}
