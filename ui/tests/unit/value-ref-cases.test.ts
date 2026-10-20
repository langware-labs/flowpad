/**
 * `<kind>.id.<uuid>` parses the same in the browser as on the server: the cases of
 * `test_fixtures/value_ref_cases.json` run here against `parseValueRef`, and in
 * `tests/unit/test_data_spec/test_value_ref_cases.py` against `parse_ref`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseValueRef } from '../../../ts_sdk/src/viewers/kinds';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../test_fixtures/value_ref_cases.json'), 'utf-8')) as {
  cases: { text: string; ref: { kind: string; id: string } | null }[];
};

describe('a value reference', () => {
  it.each(fixture.cases)('$text', ({ text, ref }) => {
    expect(parseValueRef(text)).toEqual(ref);
  });
});
