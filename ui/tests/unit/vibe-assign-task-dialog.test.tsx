/**
 * The Vibe "Ask for help" button and its dialog.
 *
 * - A typed-but-never-Entered email must still count as the picked person.
 * - The button is the CURRENT TASK button: my open Vibe help tasks in this project (not closed,
 *   not shared with me, not another project's) are listed, each opening the conversation it was
 *   asked in; the icon counts the messages waiting across them; with none open it asks anew.
 * - Asking the same person again in the same project offers the open conversation.
 * - Asking is ONE `ask-for-help` call (a person recipient, files multipart) — the backend writes the
 *   task, the conversation and the message, and delivers them (docs/collab/ask-for-help.md).
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
// The annotator is a popup; markup is its own concern — here it hands the image back as-is.
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: (files: File[]) => Promise.resolve({ files, caption: '' }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

import { dataManager, Task, TaskKind } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { AskForHelpButton } from '@src/components/help/AskForHelpButton';
import { AskForHelpDialog } from '@src/components/help/AskForHelpDialog';

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

describe('AskForHelpDialog', () => {
  it('enables Assign when the email was typed and the user moved on to the title', () => {
    render(<AskForHelpDialog open onOpenChange={() => {}} projectId={null} sessionTypeId={null} origin="vibe" />);

    // The user's path: type the email, move straight on to the title — no Enter.
    const person = screen.getByTestId('vibe-assign-person');
    fireEvent.change(person, { target: { value: 'eran@langware.ai' } });
    fireEvent.blur(person);
    fireEvent.change(screen.getByTestId('vibe-assign-title'), { target: { value: 'Popout button is disabled' } });

    expect(screen.getByTestId('vibe-assign-submit')).toBeEnabled();
  });
});

describe('AskForHelpButton — the current task button', () => {
  it('with no open help task, a click asks anew', () => {
    render(<AskForHelpButton projectId={P1} sessionTypeId={null} origin="vibe" />);

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
    render(<AskForHelpButton projectId={P1} sessionTypeId={null} origin="vibe" />);

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
    render(<AskForHelpButton projectId={P1} sessionTypeId={null} origin="vibe" />);

    expect(screen.getByTestId('vibe-assign-task')).toHaveTextContent('7');
  });

  it('keeps asking anew from the list', async () => {
    h.tasks = [helpTask()];
    render(<AskForHelpButton projectId={P1} sessionTypeId={null} origin="vibe" />);

    act(() => {
      fireEvent.click(screen.getByTestId('vibe-assign-task'));
    });
    fireEvent.click(await screen.findByTestId('vibe-help-new'));

    expect(screen.getByTestId('vibe-assign-submit')).toBeInTheDocument();
  });
});

describe('AskForHelpDialog — asking again', () => {
  const renderWith = (email: string, onOpenExisting = vi.fn()) => {
    const row = { task: helpTask(), conversationId: 'conv-1', unread: 0 };
    render(
      <AskForHelpDialog
        open
        onOpenChange={() => {}}
        projectId={P1}
        sessionTypeId={null}
        origin="vibe"
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

  /** Fill the required fields, run `attach`, submit; returns the one `ask-for-help` call. */
  async function submit(attach: () => void | Promise<void> = () => {}) {
    const calls: unknown[] = [];
    vi.spyOn(dataManager, 'callAction').mockImplementation(async (info) => {
      if (info.name === 'ask-for-help') {
        calls.push(info.bodyParameters);
        return {
          conversation_id: 'conv-9',
          task_id: 't-9',
          message_id: 'm-9',
          delivery: { header: 'sent', body: null, failure: null },
        };
      }
      return { desks: [], default_state: 'known' };
    });
    render(<AskForHelpDialog open onOpenChange={() => {}} projectId={P1} sessionTypeId={null} origin="vibe" />);
    const person = screen.getByTestId('vibe-assign-person');
    fireEvent.change(person, { target: { value: 'bob@x.com' } });
    fireEvent.blur(person);
    fireEvent.change(screen.getByTestId('vibe-assign-title'), { target: { value: 'Popout button is disabled' } });
    await attach();
    act(() => {
      fireEvent.click(screen.getByTestId('vibe-assign-submit'));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    return calls[0];
  }

  it('asking a person is one request, to them, from this project', async () => {
    const body = (await submit()) as Record<string, unknown>;
    expect(body).toMatchObject({
      recipient: { kind: 'person', email: 'bob@x.com' },
      title: 'Popout button is disabled',
      project_id: P1,
      origin: 'vibe',
    });
    expect(typeof body.conversation_id).toBe('string'); // the asker's id: a resend is the same request
  });

  it('"Send diagnostic" is on by default and replaces the transcript: nothing is attached for it', async () => {
    const body = (await submit()) as Record<string, unknown>;
    expect(body.diagnose).toBe(true);
    expect(body.context ?? []).toEqual([]);
  });

  it('unticking "Send diagnostic" asks without one', async () => {
    const body = (await submit(() => {
      fireEvent.click(screen.getByTestId('ask-for-help-send-diagnostic'));
    })) as Record<string, unknown>;
    expect(body.diagnose).toBe(false);
  });

  it('a file picked with "+" rides with the request', async () => {
    const shot = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const form = (await submit(() => {
      fireEvent.change(screen.getByTestId('vibe-assign-attach-input'), { target: { files: [shot] } });
    })) as FormData;

    expect(form.getAll('files').map((f) => (f as File).name)).toEqual(['shot.png']);
    expect(JSON.parse(form.get('request') as string).recipient.email).toBe('bob@x.com');
  });

  it('a pasted screenshot goes through the annotator and rides with the request', async () => {
    const form = (await submit(async () => {
      const image = new File([new Uint8Array([9])], 'image.png', { type: 'image/png' });
      fireEvent.paste(screen.getByTestId('vibe-assign-notes'), {
        clipboardData: {
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
          files: [image],
          types: ['Files'],
          getData: () => '',
        },
      });
      await waitFor(() => expect(screen.getByText(/screenshot/i)).toBeInTheDocument());
    })) as FormData;

    const names = form.getAll('files').map((f) => (f as File).name);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^screenshot.*\.png$/);
  });
});
