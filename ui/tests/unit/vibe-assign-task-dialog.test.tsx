/**
 * The Vibe "Ask for help" button and its dialog.
 *
 * - A typed-but-never-Entered email must still count as the picked person.
 * - The button is the CURRENT TASK button: my open Vibe help tasks in this project (not closed,
 *   not shared with me, not another project's) are listed, each opening the conversation it was
 *   asked in; the icon counts the messages waiting across them; with none open it asks anew.
 * - Asking the same person again in the same project offers the open conversation.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tasks: [] as unknown[], conversations: [] as unknown[], openDock: vi.fn() }));
// The queries are the seam (the project filter is theirs, server-side); the selection is real.
vi.mock('@src/hooks/use-my-vibe-tasks', async (orig) => {
  const real = await orig<typeof import('@src/hooks/use-my-vibe-tasks')>();
  return {
    ...real,
    useMyVibeTasks: (projectId: string | null) =>
      real.vibeTaskRows(
        real.openHelpTasks(
          h.tasks.filter((t) => (t as { project_id?: string }).project_id === projectId) as never,
          'me@x.com',
        ),
        h.conversations as never,
      ),
  };
});
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@src/services/privacy-guard', () => ({ guardCloudAction: () => true }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

import { Task, TaskKind } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { VibeAssignTaskButton } from '@src/pages/flow-page/VibeAssignTaskButton';
import { VibeAssignTaskDialog } from '@src/pages/flow-page/VibeAssignTaskDialog';

afterEach(() => {
  cleanup();
  h.tasks = [];
  h.conversations = [];
  h.openDock.mockReset();
  vi.restoreAllMocks();
});

const ME = 'me@x.com';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

function helpTask(over: Record<string, unknown> = {}) {
  return new Task({
    id: crypto.randomUUID(),
    type: 'task',
    title: 'Popout button is disabled',
    kind: TaskKind.VIBE,
    status: 'to_do',
    project_id: P1,
    reporter: ME,
    assignee: 'bob@x.com',
    origin_conversation: 'conv-1',
    ...over,
  });
}

describe('ContactPicker', () => {
  it('takes a typed email as the person when the field loses focus', () => {
    const onChange = vi.fn();
    render(<ContactPicker value={[]} onChange={onChange} />);

    const input = screen.getByTestId('contact-input');
    fireEvent.change(input, { target: { value: 'eran@langware.ai' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith([{ email: 'eran@langware.ai', name: null }]);
  });
});

describe('VibeAssignTaskDialog', () => {
  it('enables Assign when the email was typed and the user moved on to the title', () => {
    render(<VibeAssignTaskDialog open onOpenChange={() => {}} projectId={null} sessionTypeId={null} />);

    // The user's path: type the email, move straight on to the title — no Enter.
    const person = screen.getByTestId('vibe-assign-person');
    fireEvent.change(person, { target: { value: 'eran@langware.ai' } });
    fireEvent.blur(person);
    fireEvent.change(screen.getByTestId('vibe-assign-title'), { target: { value: 'Popout button is disabled' } });

    expect(screen.getByTestId('vibe-assign-submit')).toBeEnabled();
  });
});

describe('VibeAssignTaskButton — the current task button', () => {
  it('with no open help task, a click asks anew', () => {
    render(<VibeAssignTaskButton projectId={P1} sessionTypeId={null} />);

    fireEvent.click(screen.getByTestId('vibe-assign-task'));

    expect(screen.getByTestId('vibe-assign-submit')).toBeInTheDocument();
  });

  it('lists my open help tasks here, each opening the conversation it was asked in', async () => {
    const mine = helpTask();
    h.tasks = [
      mine,
      helpTask({ title: 'done one', status: 'done' }),
      helpTask({ title: 'canceled one', status: 'canceled' }),
      // The helper's received copy: no reporter, assigned to me — never "my request".
      helpTask({ title: 'shared with me', reporter: null, assignee: ME }),
      helpTask({ title: 'asked by someone else', reporter: 'carol@x.com' }),
      helpTask({ title: 'other project', project_id: P2 }),
    ];
    h.conversations = [{ id: 'conv-1', unread_count: 3 }];
    render(<VibeAssignTaskButton projectId={P1} sessionTypeId={null} />);

    const icon = screen.getByTestId('vibe-assign-task');
    expect(icon).toHaveAttribute('data-open-tasks', '1');
    expect(icon).toHaveTextContent('3');
    act(() => {
      fireEvent.click(icon);
    });

    const list = await screen.findByTestId('vibe-help-tasks');
    expect(list).toHaveTextContent('Popout button is disabled');
    expect(list).not.toHaveTextContent('done one');
    expect(list).not.toHaveTextContent('canceled one');
    expect(list).not.toHaveTextContent('shared with me');
    expect(list).not.toHaveTextContent('asked by someone else');
    expect(list).not.toHaveTextContent('other project');
    expect(screen.getByTestId(`vibe-help-task-unread-${mine.id}`)).toHaveTextContent('3');

    fireEvent.click(screen.getByTestId(`vibe-help-task-${mine.id}`));
    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect(h.openDock.mock.calls[0][0].tabHash).toContain('conv-1');
  });

  it('sums the waiting messages across tasks, and a read conversation counts nothing', () => {
    h.tasks = [helpTask(), helpTask({ origin_conversation: 'conv-2' }), helpTask({ origin_conversation: 'conv-3' })];
    h.conversations = [
      { id: 'conv-1', unread_count: 2 },
      { id: 'conv-2', unread_count: 5 },
      { id: 'conv-3', unread_count: 0 },
    ];
    render(<VibeAssignTaskButton projectId={P1} sessionTypeId={null} />);

    expect(screen.getByTestId('vibe-assign-task')).toHaveTextContent('7');
  });

  it('keeps asking anew from the list', async () => {
    h.tasks = [helpTask()];
    render(<VibeAssignTaskButton projectId={P1} sessionTypeId={null} />);

    act(() => {
      fireEvent.click(screen.getByTestId('vibe-assign-task'));
    });
    fireEvent.click(await screen.findByTestId('vibe-help-new'));

    expect(screen.getByTestId('vibe-assign-submit')).toBeInTheDocument();
  });
});

describe('VibeAssignTaskDialog — asking again', () => {
  const renderWith = (email: string, onOpenExisting = vi.fn()) => {
    const row = { task: helpTask(), conversationId: 'conv-1', unread: 0 };
    render(
      <VibeAssignTaskDialog
        open
        onOpenChange={() => {}}
        projectId={P1}
        sessionTypeId={null}
        openTasks={[row]}
        onOpenExisting={onOpenExisting}
      />,
    );
    const person = screen.getByTestId('vibe-assign-person');
    fireEvent.change(person, { target: { value: email } });
    fireEvent.blur(person);
    return { row, onOpenExisting };
  };

  it('offers the open conversation with the same person (whatever the case of the email)', () => {
    const { row, onOpenExisting } = renderWith('Bob@X.com');

    fireEvent.click(screen.getByTestId('vibe-assign-open-existing'));

    expect(onOpenExisting).toHaveBeenCalledWith(row);
    expect(screen.getByTestId('vibe-assign-already-asked').className).toContain('text-foreground');
  });

  it('offers nothing for someone not yet asked', () => {
    renderWith('carol@x.com');

    expect(screen.queryByTestId('vibe-assign-already-asked')).not.toBeInTheDocument();
  });

  it('a new request is a Vibe task, so the button lists it', async () => {
    const saved: Task[] = [];
    vi.spyOn(Task.prototype, 'save').mockImplementation(function (this: Task) {
      saved.push(this);
      return Promise.resolve(this);
    });
    const assign = vi.spyOn(Task.prototype, 'assign').mockResolvedValue({ conversationId: 'conv-9', self: false });
    render(<VibeAssignTaskDialog open onOpenChange={() => {}} projectId={P1} sessionTypeId={null} />);
    const person = screen.getByTestId('vibe-assign-person');
    fireEvent.change(person, { target: { value: 'bob@x.com' } });
    fireEvent.blur(person);
    fireEvent.change(screen.getByTestId('vibe-assign-title'), { target: { value: 'Popout button is disabled' } });

    act(() => {
      fireEvent.click(screen.getByTestId('vibe-assign-submit'));
    });

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(saved[0].kind).toBe(TaskKind.VIBE);
  });
});
