/**
 * A dataset READ BY ID carries an `examples` field on the wire. Assigning the wire row onto the
 * instance used to hide a method of that name, so the dataset editor failed to start with
 * "examples is not a function" -- found in the browser, pinned here.
 */
import { describe, expect, it } from 'vitest';
import { Dataset } from '@sdk';

describe('a dataset built from a wire row keeps its actions', () => {
  it('a wire `examples` field does not hide listing the examples', () => {
    const ds = new Dataset({ id: '6d1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'n', examples: [] } as never);
    expect(typeof ds.listExamples).toBe('function');
    expect(typeof ds.example).toBe('function');
    expect(typeof ds.annotate).toBe('function');
  });
});
