/**
 * The Flowpad Assistant follows the user's page under three rules:
 *   1. only while visible, 2. only onto a page that already has a chat (or away
 *   from an empty one), 3. never while the user is typing.
 * And an `ask` lands on the chat of the page it was made on, as its auto-prompt.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { assistantContextKey } from '@src/components/floating-chat/assistant-context';

const panelProps: Array<Record<string, unknown>> = [];
let processes: Array<{ id: string; context_key: string | null }> = [];

vi.mock('@src/components/entity-execution-panel', () => ({
  EntityExecutionPanel: (props: Record<string, unknown>) => {
    panelProps.push(props);
    if (panelProps.length > 300) throw new Error("render loop: " + String(props.contextKey));
    return <textarea data-testid="panel-input" data-context={String(props.contextKey)} />;
  },
}));
vi.mock('@src/components/entity-execution-panel/hooks/useProcessesForTarget', () => ({
  useProcessesForTarget: () => ({ processes, isLoading: false }),
}));
vi.mock('@src/components/floating-chat/useFlowpadAssistantProject', () => ({
  useFlowpadAssistantProject: () => ({ project: { id: 'asst' }, target: 'project-asst', isLoading: false }),
}));
vi.mock('@src/components/top-nav-bar/use-entity-breadcrumbs', () => ({
  useEntityBreadcrumbs: () => ({ crumbs: [], targetTypeId: null, targetTitle: '' }),
}));

import { AssistantChat } from '@src/components/floating-chat/AssistantChat';

const A = DockPointer.fromUrl('/dock/data-sources');
const B = DockPointer.fromUrl('/dock/credentials');
const C = DockPointer.fromUrl('/dock/rag');
const shown = () => screen.getByTestId('assistant-chat').getAttribute('data-context-key');
const settle = () => act(() => void vi.advanceTimersByTime(300));

function Host(props: { dock: DockPointer; visible?: boolean; ask?: { url: string; text: string } | null }) {
  const pendingAsk = props.ask ? { ...props.ask, nonce: 7 } : null;
  return (
    <AssistantChat followedDock={props.dock} visible={props.visible ?? true} pendingAsk={pendingAsk} onAskConsumed={() => {}} />
  );
}

describe('AssistantChat follows the page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    panelProps.length = 0;
    processes = [];
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('binds to the page it opens on', () => {
    render(<Host dock={A} />);
    settle();
    expect(shown()).toBe(assistantContextKey(A));
  });

  it('switches to a page that has its own chat', () => {
    processes = [
      { id: '1', context_key: assistantContextKey(A) },
      { id: '2', context_key: assistantContextKey(B) },
    ];
    const { rerender } = render(<Host dock={A} />);
    settle();
    rerender(<Host dock={B} />);
    settle();
    expect(shown()).toBe(assistantContextKey(B));
  });

  it('stays on its chat when the new page has none, and offers a new one there', () => {
    processes = [{ id: '1', context_key: assistantContextKey(A) }];
    const { rerender } = render(<Host dock={A} />);
    settle();
    rerender(<Host dock={C} />);
    settle();
    expect(shown()).toBe(assistantContextKey(A));
    fireEvent.click(screen.getByTestId('assistant-new-chat-here'));
    expect(shown()).toBe(assistantContextKey(C));
  });

  it('leaves an EMPTY chat for the next page (nothing to keep)', () => {
    const { rerender } = render(<Host dock={A} />);
    settle();
    rerender(<Host dock={C} />);
    settle();
    expect(shown()).toBe(assistantContextKey(C));
  });

  it('does not follow while hidden, and catches up once shown', () => {
    processes = [
      { id: '1', context_key: assistantContextKey(A) },
      { id: '2', context_key: assistantContextKey(B) },
    ];
    const { rerender } = render(<Host dock={A} />);
    settle();
    rerender(<Host dock={B} visible={false} />);
    settle();
    expect(shown()).toBe(assistantContextKey(A));
    rerender(<Host dock={B} visible />);
    settle();
    expect(shown()).toBe(assistantContextKey(B));
  });

  it('waits while the user is typing, and switches once the composer is left', () => {
    processes = [
      { id: '1', context_key: assistantContextKey(A) },
      { id: '2', context_key: assistantContextKey(B) },
    ];
    const { rerender } = render(
      <div>
        <Host dock={A} />
        <button data-testid="elsewhere" />
      </div>,
    );
    settle();
    const input = screen.getByTestId<HTMLTextAreaElement>("panel-input");
    input.focus();
    fireEvent.change(input, { target: { value: 'half a sent' } });
    input.value = 'half a sent';
    rerender(
      <div>
        <Host dock={B} />
        <button data-testid="elsewhere" />
      </div>,
    );
    settle();
    expect(shown()).toBe(assistantContextKey(A));
    act(() => void screen.getByTestId("elsewhere").focus());
    expect(shown()).toBe(assistantContextKey(B));
  });

  it('an ask binds to the page it was made on and becomes the auto-prompt', () => {
    const { rerender } = render(<Host dock={A} />);
    settle();
    rerender(<Host dock={B} ask={{ url: B.toUrl(), text: 'use the agent-builder skill and answer: hi' }} />);
    expect(shown()).toBe(assistantContextKey(B));
    const last = panelProps[panelProps.length - 1];
    expect(last.contextKey).toBe(assistantContextKey(B));
    expect(last.autoPrompt).toMatchObject({ text: 'use the agent-builder skill and answer: hi', nonce: 7 });
  });
});
