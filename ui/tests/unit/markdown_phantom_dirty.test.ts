import { describe, expect, it } from 'vitest';
import { DocumentDraft, type AssetDocument } from '@sdk/fs/AssetDocument';

export function document(overrides: Partial<AssetDocument> = {}): AssetDocument {
  return { body_ref: { path: '/a/SKILL.md', type_id: 'compute_node-@local', read_only: false, ref_type: 'file' },
    raw_text: '---\nname: sample\n---\n\nBody\n', body: 'Body\n', fields: { name: 'sample', version: 131 },
    body_start_line: 5, revision: 'first', ...overrides };
}

describe('structured document draft', () => {
  it('opening a document preserves its bytes and does not create a write', () => {
    const saved = document(); const draft = new DocumentDraft(saved);
    expect(draft.dirty).toBe(false);
    expect(draft.patch()).toEqual({ expected_revision: 'first' });
    expect(draft.document.raw_text).toBe(saved.raw_text);
  });
  it('rich editor whitespace changes do not manufacture a save', () => {
    const draft = new DocumentDraft(document()); draft.body = 'Body  \n\n';
    expect(draft.dirty).toBe(false);
    draft.body = 'Edited\n'; expect(draft.patch().body).toBe('Edited\n');
  });
  it('body editing never resends or flattens structured metadata', () => {
    const fields = { tools: ['Read', 'Write'], metadata: { owner: 'team' }, eval: true };
    const draft = new DocumentDraft(document({ fields })); draft.body = 'Edited';
    expect(draft.patch()).toEqual({ expected_revision: 'first', body: 'Edited' });
    expect(draft.fields).toEqual(fields);
  });
  it('preserves edits made during a save and uses the returned revision', () => {
    const draft = new DocumentDraft(document()); draft.body = 'First edit';
    const submitted = draft.snapshot(); draft.body = 'Second edit'; draft.fields.eval = true;
    draft.accept(document({ body: 'First edit', revision: 'second' }), submitted);
    expect(draft.patch()).toEqual({ expected_revision: 'second', body: 'Second edit', set_fields: { eval: true } });
  });
  it('keeps a field reverted during a save instead of adopting the submitted value', () => {
    const draft = new DocumentDraft(document({ fields: { eval: false } })); draft.fields.eval = true;
    const submitted = draft.snapshot(); draft.fields.eval = false;
    draft.accept(document({ fields: { eval: true }, revision: 'second' }), submitted);
    expect(draft.patch().set_fields).toEqual({ eval: false });
  });
  it('distinguishes omitted body, empty body and removed metadata', () => {
    const draft = new DocumentDraft(document()); draft.body = ''; delete draft.fields.name;
    expect(draft.patch()).toEqual({ expected_revision: 'first', body: '', drop_fields: ['name'] });
  });
});
