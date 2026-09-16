import type { FSRefJson } from './FSRef';

export type DocumentValue = string | number | boolean | null | DocumentValue[] | { [key: string]: DocumentValue };

export interface AssetDocument {
  body_ref: FSRefJson;
  raw_text: string;
  body: string;
  fields: Record<string, DocumentValue>;
  body_start_line: number;
  metadata_error?: string | null;
  revision: string;
}

export interface DocumentPatch {
  expected_revision: string;
  body?: string;
  set_fields?: Record<string, DocumentValue>;
  drop_fields?: string[];
}

export interface DocumentRef {
  readonly path: string;
  readonly readOnly?: boolean;
  readonly vpath?: string;
  readDocument(): Promise<AssetDocument>;
  updateDocument(patch: DocumentPatch): Promise<AssetDocument>;
  exists?(): Promise<boolean>;
  create?(content?: string): Promise<void>;
}

/** Rich editors normalize trailing whitespace on mount; comparison never writes it. */
export function normalizeDocumentBody(body: string): string {
  return body.replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n');
}

const equal = (a: DocumentValue | undefined, b: DocumentValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** An editor draft, not a YAML serializer. The server owns all document bytes. */
export class DocumentDraft {
  body: string;
  fields: Record<string, DocumentValue>;

  constructor(public document: AssetDocument) {
    this.body = document.body;
    this.fields = { ...document.fields };
  }

  patch(): DocumentPatch {
    const patch: DocumentPatch = { expected_revision: this.document.revision };
    if (normalizeDocumentBody(this.body) !== normalizeDocumentBody(this.document.body)) patch.body = this.body;
    const set = Object.fromEntries(Object.entries(this.fields).filter(([key, value]) => !equal(value, this.document.fields[key])));
    const drop = Object.keys(this.document.fields).filter((key) => !(key in this.fields));
    if (Object.keys(set).length) patch.set_fields = set;
    if (drop.length) patch.drop_fields = drop;
    return patch;
  }

  get dirty(): boolean { return Object.keys(this.patch()).length > 1; }

  snapshot() { return { body: this.body, fields: { ...this.fields } }; }

  /** Adopt saved canonical values, keeping only edits made during this save. */
  accept(saved: AssetDocument, submitted: ReturnType<DocumentDraft['snapshot']>): void {
    if (this.body === submitted.body) this.body = saved.body;
    const next = { ...saved.fields };
    for (const key of new Set([...Object.keys(this.fields), ...Object.keys(submitted.fields)])) {
      if (equal(this.fields[key], submitted.fields[key])) continue;
      if (key in this.fields) next[key] = this.fields[key];
      else delete next[key];
    }
    this.fields = next;
    this.document = saved;
  }
}
