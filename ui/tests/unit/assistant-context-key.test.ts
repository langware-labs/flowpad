import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { assistantContextInstructions, assistantContextKey } from '@src/components/floating-chat/assistant-context';

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const dock = (url: string) => DockPointer.fromUrl(url);

describe('assistantContextKey — one assistant chat per dock context', () => {
  it('two documents in ONE assets tab are two contexts (the tab alone would fold them)', () => {
    const a = dock(`/dock/project/${P}/editor/agent/vfs/compute_node-%40local/w/p/agentic-assets/agent/a/agent.md`);
    const b = dock(`/dock/project/${P}/editor/agent/vfs/compute_node-%40local/w/p/agentic-assets/agent/b/agent.md`);
    expect(assistantContextKey(a)).not.toBe(assistantContextKey(b));
  });

  it('the same place always gives the same key', () => {
    const url = `/dock/project/${P}/editor/agent/vfs/compute_node-%40local/w/p/agentic-assets/agent/a/agent.md`;
    expect(assistantContextKey(dock(url))).toBe(assistantContextKey(dock(url)));
  });

  it('a view with no tab (home) still has a context', () => {
    expect(assistantContextKey(dock('/dock/home'))).toBeTruthy();
    expect(assistantContextKey(null)).toBe('root');
  });

  it('the creation instructions name the page', () => {
    const d = dock('/dock/data-sources');
    const text = assistantContextInstructions(d, [{ label: 'p' }, { label: 'Data sources' }]);
    expect(text).toContain('p › Data sources');
    expect(text).toContain('`data-sources`');
  });

  it('names where the shown thing lives on disk, so the worker need not search', () => {
    const d = dock('/dock/data-sources');
    const text = assistantContextInstructions(d, [{ label: 'p' }, { label: 'Dana', path: '/w/p/agent/dana/agent.md' }]);
    expect(text).toContain('`/w/p/agent/dana/agent.md`');
  });
});
