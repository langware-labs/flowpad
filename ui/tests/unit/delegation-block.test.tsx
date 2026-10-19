import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ post: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { post: (...a: unknown[]) => h.post(...a) } }));
vi.mock('@src/notifications', () => ({ notify: { success: h.success, error: h.error } }));

import { DelegationBlock } from '@src/components/assets/editor/task/DelegationBlock';

function task(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    status: 'working',
    creator: 'agent:11111111-1111-4111-8111-111111111111',
    owner: 'subagent:general-worker',
    process_id: 'agentic_process-abcdef12-0000',
    placement: 'instance',
    ...over,
  } as never;
}

beforeEach(() => {
  h.post.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('DelegationBlock', () => {
  it('shows who asked, who owns it, its run and its result', () => {
    render(<DelegationBlock task={task({ status: 'done', result: '3 themes, summary.md written', cost_usd: 0.04 })} />);
    const block = screen.getByTestId('task-delegation');
    expect(block).toHaveTextContent('Agent 11111111');
    expect(block).toHaveTextContent('general-worker');
    expect(block).toHaveTextContent('Done');
    expect(block).toHaveTextContent('abcdef12');
    expect(block).toHaveTextContent('$0.04');
    expect(screen.getByTestId('task-result')).toHaveTextContent('3 themes, summary.md written');
  });

  it('is nothing for a task a person made', () => {
    const { container } = render(<DelegationBlock task={task({ owner: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps an instance task in the project on a click, and offers nothing once it is there', async () => {
    render(<DelegationBlock task={task()} />);
    fireEvent.click(screen.getByTestId('task-keep-in-project'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/v1/tasks/t1/keep', {}));
    expect(h.success).toHaveBeenCalled();
    cleanup();
    render(<DelegationBlock task={task({ placement: 'repo' })} />);
    expect(screen.queryByTestId('task-keep-in-project')).toBeNull();
  });
});
