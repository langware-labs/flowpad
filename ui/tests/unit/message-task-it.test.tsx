import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { taskTitleFromText } from '@sdk/entities/task';
import { MemoryRouter } from 'react-router';
import { MessageBubble } from '@src/components/conversation/MessageBubble';

/**
 * "Task it" — one click makes a conversation message a task. The bubble's control creates it while
 * the message has none and opens it once it has one (one message, one task); the title is the
 * message's first line.
 */
describe('Task it', () => {
  const message: ConversationMessage = {
    role: 'sender',
    content: 'Please render HTML in machine output',
    sender_id: 'user-1',
    timestamp: '2026-10-02T10:00:00.000Z',
  };

  it('creates when the message has no task', () => {
    const onTaskIt = vi.fn();
    render(<MemoryRouter><MessageBubble message={message} senderName="Ron" taskIt={{ onClick: onTaskIt }} /></MemoryRouter>);
    const control = screen.getByTestId('message-task-it');
    expect(control.getAttribute('aria-label')).toBe('Task it');
    fireEvent.click(control);
    expect(onTaskIt).toHaveBeenCalledTimes(1);
  });

  it('reads "Open task" once the message is a task', () => {
    render(<MemoryRouter><MessageBubble message={message} senderName="Ron" taskIt={{ onClick: () => {}, title: 'Render HTML' }} /></MemoryRouter>);
    const chip = screen.getByTestId('message-task-it');
    expect(chip.getAttribute('aria-label')).toBe('Open task');
    expect(chip.textContent).toBe('Render HTML');
  });

  it("shows an opened task's status and owner beside it", () => {
    const task = { onClick: () => {}, title: 'Render HTML', status: 'in_progress', owner: 'ron@x.com' };
    render(<MemoryRouter><MessageBubble message={message} senderName="Ron" taskIt={task} /></MemoryRouter>);
    expect(screen.getByTestId('message-task-status').textContent).toBe('In progress');
    expect(screen.getByTestId('message-task-owner').textContent).toBe('ron@x.com');
  });

  it('a message not yet a task has no status or owner chip', () => {
    render(<MemoryRouter><MessageBubble message={message} senderName="Ron" taskIt={{ onClick: () => {} }} /></MemoryRouter>);
    expect(screen.queryByTestId('message-task-status')).toBeNull();
    expect(screen.queryByTestId('message-task-owner')).toBeNull();
  });

  it('offers nothing without a handler', () => {
    render(<MemoryRouter><MessageBubble message={message} senderName="Ron" /></MemoryRouter>);
    expect(screen.queryByTestId('message-task-it')).toBeNull();
  });

  it('titles the task from the first non-empty line', () => {
    expect(taskTitleFromText('\n  Fix the login\nmore detail')).toBe('Fix the login');
    expect(taskTitleFromText('')).toBe('');
    const long = 'word '.repeat(40).trim();
    const title = taskTitleFromText(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });
});
