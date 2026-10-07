// A `.value.json` names its own kind; the viewer reads it from the dump's `spec_kind` tag.
import { describe, expect, it } from 'vitest';

import { readValue } from '@src/components/value-viewer/ValueViewer';
import { namedKind } from '../../../ts_sdk/src/viewers/kinds';

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

describe('namedKind', () => {
  it('a wildcard names no kind, so it is never asked for (the backend answered `*` with a 500)', () => {
    expect(namedKind('*')).toBeNull();
    expect(namedKind('?*')).toBeNull();
    expect(namedKind('?diagnosis')).toBe('diagnosis');
  });
});
