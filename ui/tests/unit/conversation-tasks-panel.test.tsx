import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Task } from '@sdk';
import { ConversationTasksPanel } from '@src/components/conversation/ConversationTasksPanel';

/** The conversation drawer's Tasks tab: open tasks by default, every task on request. */
describe('ConversationTasksPanel', () => {
  const task = (id: string, title: string, status: string, extra: Partial<Task> = {}) =>
    ({ id, title, status, created_date: `2026-10-04T10:00:0${id}Z`, ...extra }) as unknown as Task;
  const tasks = [
    task('1', 'Ship the renderer', 'to_do', { assignee: 'ron@x.com' }),
    task('2', 'Dark-mode check', 'in_progress'),
    task('3', 'Copy button', 'done'),
    task('4', 'Old idea', 'to_do', { archived_at: '2026-10-01T00:00:00Z' }),
  ];
  const titles = () => screen.getAllByTestId('conversation-task-row').map((r) => r.textContent ?? '');

  it('shows only the open tasks by default, newest first', () => {
    render(
      <MemoryRouter>
        <ConversationTasksPanel tasks={tasks} />
      </MemoryRouter>,
    );
    expect(titles().map((t) => t.split('New')[0].split('In progress')[0])).toEqual([
      'Dark-mode check',
      'Ship the renderer',
    ]);
    expect(screen.getByTestId('conversation-tasks-filter-open').textContent).toBe('Open 2');
    expect(screen.getByTestId('conversation-tasks-filter-all').textContent).toBe('All 4');
  });

  it('shows every task once "All" is picked', () => {
    render(
      <MemoryRouter>
        <ConversationTasksPanel tasks={tasks} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('conversation-tasks-filter-all'));
    expect(titles()).toHaveLength(4);
  });

  it('says so when the conversation has no tasks', () => {
    render(
      <MemoryRouter>
        <ConversationTasksPanel tasks={[]} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('conversation-task-row')).toBeNull();
    expect(screen.getByTestId('conversation-tasks-panel').textContent).toContain('No tasks yet');
  });
});
