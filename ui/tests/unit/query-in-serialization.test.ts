/**
 * X2 regression lock: an ``$IN`` match whose second operand is a literal
 * id-array must survive ``ExpressionNode`` construction + ``toJSON`` UNCHANGED.
 *
 * Before the fix the constructor treated the id-array operand as a plain map
 * (``typeof [] === 'object'``) and recursively wrapped it in a nested
 * ``$AND``/``$EQ`` tree — so ``$IN ['id', [a,b,c]]`` serialized to a bogus
 * shape and the backend ``ids`` filter silently matched everything. The batch
 * inbox/feed hydration depends on this array reaching the backend intact.
 */
import { describe, expect, it } from 'vitest';
import { ExpressionNode, QueryFilter, QueryRequest, FlowMessage } from '@sdk';

describe('$IN id-array serialization', () => {
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];

  it('keeps the id array intact through ExpressionNode.toJSON', () => {
    const node = new ExpressionNode({ op: '$IN', operands: ['id', ids] });
    const json = node.toJSON() as { op: string; operands: unknown[] };
    expect(json.op).toBe('$IN');
    expect(json.operands).toEqual(['id', ids]);
  });

  it('keeps a single-id array intact (length-1 must not collapse to $EQ)', () => {
    const single = [ids[0]];
    const node = new ExpressionNode({ op: '$IN', operands: ['id', single] });
    const json = node.toJSON() as { operands: unknown[] };
    expect(json.operands).toEqual(['id', single]);
  });

  it('serializes a QueryRequest with an $IN id-array to the wire shape', () => {
    const request = new QueryRequest({
      type: FlowMessage.type,
      query: { match: { op: '$IN', operands: ['id', ids] } },
      name: 'batch hydrate',
    });
    const wire = request.toJSON() as {
      query: { filter: { match: { op: string; operands: unknown[] } } };
    };
    const match = wire.query.filter.match;
    expect(match.op).toBe('$IN');
    expect(match.operands).toEqual(['id', ids]);
  });

  it('round-trips through QueryFilter.parse without mangling the array', () => {
    const filter = QueryFilter.parse(
      { match: { op: '$IN', operands: ['id', ids] } },
      FlowMessage.type,
    );
    const json = filter.toJSON() as { filter: { match: { operands: unknown[] } } };
    expect(json.filter.match.operands).toEqual(['id', ids]);
  });
});
