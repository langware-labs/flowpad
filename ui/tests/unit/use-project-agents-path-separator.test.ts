/**
 * `useProjectAgents` — the `asset_ref` prefix ranges that decide which agents a
 * project's homes show.
 *
 * Membership is a LEXICAL range over `asset_ref`, and on Windows that column
 * holds two spellings of the same path: the indexer writes it through pathlib
 * (`C:\Users\…`) while `context_roots` and the other producers write
 * `canonical_posix_path` (`C:/Users/…`). A POSIX-only range matched neither the
 * agent nor anything else there — `\` (0x5C) sorts past the `0` (0x30) that
 * closes it — so `ProjectAgentsStrip` rendered nothing under the vibe input on
 * Windows while the identical project worked on macOS.
 *
 * Pinned as ranges evaluated against real stored spellings rather than as a
 * shape assertion: what matters is which rows the query SELECTS, and an
 * operand-tree snapshot would keep passing if the bounds were wrong.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ request: null as import('@sdk').QueryRequest | null }));

vi.mock('@sdk/react/hooks', () => ({
  useEntitiesQuery: (request: import('@sdk').QueryRequest) => {
    h.request = request;
    return { data: [] };
  },
}));

import { renderHook } from '@testing-library/react';
import type { ExpressionNode, Project } from '@sdk';
import { useProjectAgents } from '@src/hooks/use-project-agents';

/** Evaluate the built `$OR` of `$AND(GE, LT)` range leaves against one
 *  `asset_ref`, exactly as the SQL driver and the live re-validator do. */
function selects(assetRef: string): boolean {
  const match = h.request?.query?.match as ExpressionNode | undefined;
  if (!match) return false;
  const value = (node: ExpressionNode) => node.operands[1] as string;
  return (match.operands as ExpressionNode[]).some((range) => {
    const [ge, lt] = range.operands as ExpressionNode[];
    return assetRef >= value(ge) && assetRef < value(lt);
  });
}

function mount(contextRoots: string[]) {
  h.request = null;
  renderHook(() => useProjectAgents({ id: 'p1', context_roots: contextRoots } as Project));
}

describe('useProjectAgents asset_ref ranges', () => {
  it('selects a Windows-spelled asset_ref under a canonical-posix context root', () => {
    // The real shape: the project's own mount plus an attached desk, both
    // canonical posix; the desk's agent indexed with backslashes.
    mount(['C:/Users/dev/Flowpad workspace/hello-flowpad-task', 'C:/Users/dev/Flowpad workspace/appbuild-helpdesk']);

    expect(selects('C:\\Users\\dev\\Flowpad workspace\\appbuild-helpdesk\\agentic-assets\\agent\\agent-smith')).toBe(
      true,
    );
    // The posix spelling of the same row still matches — both forms are live.
    expect(selects('C:/Users/dev/Flowpad workspace/appbuild-helpdesk/agentic-assets/agent/agent-smith')).toBe(true);
  });

  it('keeps the ranges strict — a sibling directory sharing a prefix is not under the root', () => {
    mount(['C:/Users/dev/Flowpad workspace/appbuild-helpdesk']);

    expect(selects('C:\\Users\\dev\\Flowpad workspace\\appbuild-helpdesk-old\\agentic-assets\\agent\\x')).toBe(false);
    expect(selects('C:/Users/dev/Flowpad workspace/appbuild-helpdesk-old/agentic-assets/agent/x')).toBe(false);
    // The root itself is not its own strict descendant.
    expect(selects('C:/Users/dev/Flowpad workspace/appbuild-helpdesk')).toBe(false);
  });

  it('adds no second spelling for a POSIX root, which has only one', () => {
    mount(['/Users/dev/Flowpad workspace/appbuild-helpdesk']);

    const match = h.request?.query?.match as ExpressionNode;
    expect(match.operands).toHaveLength(1);
    expect(selects('/Users/dev/Flowpad workspace/appbuild-helpdesk/agentic-assets/agent/agent-smith')).toBe(true);
  });
});
