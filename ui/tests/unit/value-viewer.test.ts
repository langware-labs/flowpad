// A `.value.json` names its own kind; the viewer reads it from the dump's `spec_kind` tag.
import { describe, expect, it } from 'vitest';

import { readValue } from '@src/components/value-viewer/ValueViewer';

describe('readValue', () => {
  it('takes the kind from spec_kind and leaves the value without it', () => {
    expect(readValue('{"spec_kind": "diagnosis", "status": "ok", "title": "fine"}')).toEqual({
      kind: 'diagnosis',
      value: { status: 'ok', title: 'fine' },
    });
  });

  it('accepts an already-parsed download', () => {
    expect(readValue({ spec_kind: 'eval.run', run_id: 'r' }).kind).toBe('eval.run');
  });

  it.each([
    ['{"status": "ok"}', 'the file names no spec_kind'],
    ['[1, 2]', 'not a value: expected an object'],
    ['{not json', 'JSON'],
  ])('refuses %s', (raw, why) => {
    expect(() => readValue(raw)).toThrow(why);
  });
});
