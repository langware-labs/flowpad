import { dataManager, ExpressionNode, foldUnkept, QueryFilter, QueryRequest } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEPT = new Set(['id', 'title', 'updated_date', 'deleted_at']);
const kept = (field: string) => KEPT.has(field);
const leaf = (op: string, ...operands: unknown[]) => ({ op, operands }) as never;

describe('a test on a field the server does not keep is answered before sending', () => {
  it('answers each leaf as an empty row would', () => {
    expect(foldUnkept(leaf('$IS_NULL', 'archived'), kept)).toBe(true);
    expect(foldUnkept(leaf('$IS_NOT_NULL', 'archived'), kept)).toBe(false);
    expect(foldUnkept(leaf('$EQ', 'archived', true), kept)).toBe(false);
    expect(foldUnkept(leaf('$NE', 'remote', false), kept)).toBe(true);
    expect(foldUnkept(leaf('$IN', 'owner', ['a', 'b']), kept)).toBe(false);
    expect(foldUnkept(leaf('$NIN', 'owner', ['a']), kept)).toBe(true);
    expect(foldUnkept(leaf('$GT', 'score', 3), kept)).toBe(false);
    expect(foldUnkept(leaf('$EQ', 'input.stage', 'won'), kept)).toBe(false);
  });

  it('leaves a test on a kept field alone', () => {
    const titled = leaf('$EQ', 'title', 'x');
    expect(foldUnkept(titled, kept)).toEqual(titled);
  });

  it('simplifies AND / OR around the answers', () => {
    const titled = leaf('$EQ', 'title', 'x');
    // owner = me OR owner IS NULL → every row
    expect(foldUnkept(leaf('$OR', leaf('$EQ', 'owner', 'me'), leaf('$IS_NULL', 'owner')), kept)).toBe(true);
    expect(foldUnkept(leaf('$AND', titled, leaf('$EQ', 'archived', true)), kept)).toBe(false);
    expect(foldUnkept(leaf('$AND', titled, leaf('$IS_NULL', 'archived')), kept)).toEqual(titled);
    expect(foldUnkept(leaf('$OR', titled, leaf('$EQ', 'archived', true)), kept)).toEqual(titled);
    const both = leaf('$AND', titled, leaf('$IS_NULL', 'deleted_at'), leaf('$IS_NULL', 'archived'));
    expect(foldUnkept(both, kept)).toEqual(leaf('$AND', titled, leaf('$IS_NULL', 'deleted_at')));
  });

  it('drops sorting on a field the server does not keep, and keeps the page', () => {
    const filter = new QueryFilter({
      match: leaf('$IS_NULL', 'archived'),
      order_by: [{ archived: 'desc' }, { updated_date: 'desc' }],
      limit: 10,
      offset: 20,
    });
    expect(filter.forServer(kept)?.toJSON()).toEqual({
      filter: {
        match: { op: '$IS_NOT_NULL', operands: ['id'] },
        order_by: [{ updated_date: 'desc' }],
        limit: 10,
        offset: 20,
      },
      expand: undefined,
    });
  });

  it('says there is nothing to ask when no row can pass', () => {
    expect(new QueryFilter({ match: leaf('$EQ', 'archived', true) }).forServer(kept)).toBeNull();
  });
});

describe('the query path folds to what the connected server lists', () => {
  afterEach(() => vi.restoreAllMocks());

  const loadConversationFields = () =>
    dataManager.loadTypes([
      {
        type_name: 'conversation',
        schema: { properties: Object.fromEntries([...KEPT].map((f) => [f, {}])) },
      } as never,
    ]);

  it('sends only tests on listed fields', async () => {
    await loadConversationFields();
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue([] as never);
    const match = new ExpressionNode({
      op: '$AND',
      operands: [
        new ExpressionNode({ op: '$IS_NULL', operands: ['deleted_at'] }),
        new ExpressionNode({
          op: '$OR',
          operands: [
            { op: '$EQ', operands: ['archived', false] },
            { op: '$IS_NULL', operands: ['archived'] },
          ],
        }),
      ],
    });

    await dataManager.query(
      new QueryRequest({ type: 'conversation', name: 'fold-mixed', query: new QueryFilter({ match }) }),
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect((get.mock.calls[0][1] as { params: { filter: unknown } }).params.filter).toEqual({
      match: { op: '$IS_NULL', operands: ['deleted_at'] },
    });
  });

  it('answers an empty page without a request when no row can pass', async () => {
    await loadConversationFields();
    const get = vi.spyOn(apiClient, 'get');
    const query = new QueryFilter({ match: { op: '$EQ', operands: ['archived', true] } as never, limit: 5 });

    const rows = await dataManager.query(new QueryRequest({ type: 'conversation', name: 'fold-none', query }));

    expect(rows).toEqual([]);
    expect((rows as unknown as { has_more: boolean }).has_more).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});
