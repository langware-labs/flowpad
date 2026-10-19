/**
 * The task under a message (and on a task thread's first message): its title opens it, its status and its
 * owner act right there. A task made from a message is local and mine; handing it to someone else shares it
 * through the cloud. Status is one write (`task.save`, reflected to the hub for a shared task).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ allow: true }));
vi.mock('@src/services/privacy-guard', () => ({ guardCloudAction: () => guard.allow }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));

import { Task } from '@sdk/entities/task';
import { TaskChips, type TaskPeople } from '@src/components/conversation/task-it';

const ME = 'alice@x.com';
const BOB = 'bob@x.com';
const DANA = 'dana@x.com';

function makeTask(fields: Partial<Task> = {}): Task {
  return new Task({ id: crypto.randomUUID(), type: 'task', title: 'Set up the studio', status: 'to_do', assignee: ME, ...fields } as never);
}

const people: TaskPeople = {
  me: ME,
  cloudUserId: 'cloud-alice',
  members: [
    { user_id: 'cloud-alice', email: ME, name: 'Alice' },
    { user_id: 'cloud-bob', email: BOB, name: 'Bob' },
    { user_id: 'cloud-dana', email: DANA, name: null },
    { user_id: 'whatsapp-1', email: null, name: '+972 50 000' },
  ],
};

function show(task: Task, who: TaskPeople = people) {
  return render(<TaskChips task={task} onOpen={vi.fn()} people={who} />);
}

beforeEach(() => {
  guard.allow = true;
  vi.spyOn(Task.prototype, 'save').mockImplementation(async function (this: Task) {
    return this;
  });
  vi.spyOn(Task.prototype, 'markEdit').mockImplementation(() => undefined);
  vi.spyOn(Task.prototype, 'assign').mockResolvedValue({ conversationId: null, self: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('where a task lives', () => {
  it('a task made from a message is local and mine', () => {
    show(makeTask());
    const chip = screen.getByTestId('task-owner-chip');
    expect(chip).toHaveTextContent('Me');
    expect(chip).toHaveAttribute('title', 'This task is local on this machine');
    expect(chip.querySelector('[data-task-location="local"]')).not.toBeNull();
  });

  it('a shared task says it is on the cloud, and with whom', () => {
    show(makeTask({ remote: true, assignee: BOB }));
    const chip = screen.getByTestId('task-owner-chip');
    expect(chip).toHaveTextContent(BOB);
    expect(chip).toHaveAttribute('title', `Shared via cloud with ${BOB}`);
    expect(chip.querySelector('[data-task-location="cloud"]')).not.toBeNull();
  });
});

describe('the status chip', () => {
  it('moves the task — one save, completed_at stamped on Done', () => {
    const task = makeTask();
    show(task);
    fireEvent.keyDown(screen.getByTestId('task-status-chip'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('task-status-done'));
    expect(Task.prototype.save).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('done');
    expect(task.completed_at).toBeTruthy();
  });

  it('a delegated task is moved by its ledger, not from here', () => {
    show(makeTask({ owner: 'subagent:general-worker' }));
    fireEvent.keyDown(screen.getByTestId('task-status-chip'), { key: 'Enter' });
    expect(screen.queryByTestId('task-status-menu')).toBeNull();
  });
});

describe('the owner chip hands the task over', () => {
  it("offers the conversation's members — never me, never someone with no address", () => {
    show(makeTask());
    fireEvent.click(screen.getByTestId('task-owner-chip'));
    const members = within(screen.getByTestId('task-owner-members'));
    expect(members.getAllByTestId('task-owner-member').map((b) => b.getAttribute('data-email'))).toEqual([BOB, DANA]);
    expect(screen.queryByTestId('task-owner-me')).toBeNull(); // it is already mine
  });

  it('a member is one click: shared through the cloud, no second conversation', () => {
    const task = makeTask();
    show(task);
    fireEvent.click(screen.getByTestId('task-owner-chip'));
    fireEvent.click(screen.getAllByTestId('task-owner-member')[0]);
    expect(Task.prototype.assign).toHaveBeenCalledTimes(1);
    const [person, opts] = vi.mocked(Task.prototype.assign).mock.calls[0];
    expect(person).toMatchObject({ email: BOB });
    expect(opts).toMatchObject({ notify: false });
  });

  it('in Local privacy mode nobody else can be given the task', () => {
    guard.allow = false;
    show(makeTask());
    fireEvent.click(screen.getByTestId('task-owner-chip'));
    fireEvent.click(screen.getAllByTestId('task-owner-member')[0]);
    expect(Task.prototype.assign).not.toHaveBeenCalled();
  });

  it('a task given away can be taken back by me', () => {
    show(makeTask({ remote: true, assignee: BOB }));
    fireEvent.click(screen.getByTestId('task-owner-chip'));
    expect(screen.getAllByTestId('task-owner-member').map((b) => b.getAttribute('data-email'))).toEqual([DANA]);
    fireEvent.click(screen.getByTestId('task-owner-me'));
    expect(vi.mocked(Task.prototype.assign).mock.calls[0][0]).toMatchObject({ email: ME });
  });

  it('the address book is there too, empty — not pre-filled with the current owner', () => {
    show(makeTask());
    fireEvent.click(screen.getByTestId('task-owner-chip'));
    expect(screen.getByTestId('task-owner-search')).toHaveValue('');
    expect(screen.getByTestId('task-owner-assign')).toBeDisabled();
  });
});
