/**
 * A question with more than one way to answer it — "a key file, OR sign in with gcloud".
 *
 * A value way is the ordinary input, sent as `<choice>=<value>` so the op knows which way was
 * taken. A sign-in way has nothing to type and nothing to send: Run starts its command in a terminal
 * drawn right under it, and the backend closes the question by itself — so there is no Send for it,
 * and nothing here polls.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  sendInput: vi.fn(),
  ensureStarted: vi.fn(),
  connect: vi.fn(),
  /** The flow-complete listener the block holds right now, per provider (enabled only). */
  flowDone: {} as Record<string, (payload: { provider: string; status: string }) => void>,
}));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@sdk/react/hooks', () => ({
  useOAuthFlowComplete: (provider: string, handler: (payload: { provider: string; status: string }) => void, enabled = true) => {
    if (enabled) h.flowDone[provider] = handler;
    else delete h.flowDone[provider];
  },
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, oauthService: { connect: h.connect } };
});
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));
// xterm needs a canvas jsdom lacks; what the terminal draws is its own business.
vi.mock('@src/components/terminal/interactive-terminal/ShellTerminal', () => ({
  ShellTerminal: ({ shellId }: { shellId: string }) => <div data-testid="shell-terminal">{shellId}</div>,
}));

import { Shell } from '@sdk';

import { AskChoiceBlock } from '@src/components/ask/AskChoiceBlock';
import { AskForm } from '@src/components/ask/AskForm';

const LOGIN = 'gcloud auth application-default login';
const KEY_FILE = { value: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Service account key', hint: 'A JSON key file', secret: true, file: false, command: '' };
const GCLOUD = { value: 'GCLOUD_ADC', label: 'Sign in with gcloud', hint: 'Uses your own Google account', secret: false, file: false, command: LOGIN };
const GOOGLE = {
  value: 'GMAIL_GOOGLE', label: 'Sign in with Google', hint: 'Nothing to copy', secret: false, file: false, command: '',
  provider: 'google', scopes: ['https://mail.google.com/'],
};
const APP_PASSWORD = { value: 'GMAIL_APP_PASSWORD', label: 'App password', hint: '', secret: true, file: false, command: '' };
const QUESTION = {
  id: 'q1', op: 'ask-google-cloud', prompt: 'Google Cloud', fields: 'string', auto: true,
  guide: 'Create a key under **IAM**.', choices: [KEY_FILE, GCLOUD],
};

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.post.mockReset();
  h.sendInput.mockReset();
  h.ensureStarted.mockReset();
  h.connect.mockReset();
  h.flowDone = {};
  vi.restoreAllMocks();
});

describe('AskChoiceBlock', () => {
  it('a sign-in-through-Flowpad way connects its provider and, once granted, answers with its name alone', async () => {
    const onAnswer = vi.fn();
    h.connect.mockResolvedValue(null);
    render(<AskChoiceBlock choices={[GOOGLE, APP_PASSWORD]} onAnswer={onAnswer} />);

    expect(screen.queryByTestId('ask-choice-input')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-choice-sign-in-button'));
    await waitFor(() => expect(h.connect).toHaveBeenCalledWith('google'));
    expect(await screen.findByTestId('ask-choice-oauth-waiting')).toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();

    h.flowDone.google({ provider: 'google', status: 'success' });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('GMAIL_GOOGLE'));
  });

  it('a sign-in that does not finish answers nothing and says so; the other way stays open', async () => {
    const onAnswer = vi.fn();
    h.connect.mockResolvedValue(null);
    render(<AskChoiceBlock choices={[GOOGLE, APP_PASSWORD]} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByTestId('ask-choice-sign-in-button'));
    await waitFor(() => expect(h.flowDone.google).toBeDefined());
    h.flowDone.google({ provider: 'google', status: 'cancelled' });

    expect(await screen.findByTestId('ask-choice-oauth-refused')).toHaveTextContent('did not finish');
    fireEvent.click(screen.getByTestId(`ask-choice-${APP_PASSWORD.value}`));
    fireEvent.change(screen.getByTestId('ask-choice-input'), { target: { value: 'abcd efgh' } });
    fireEvent.click(screen.getByTestId('ask-choice-submit'));
    expect(onAnswer).toHaveBeenCalledWith('GMAIL_APP_PASSWORD=abcd efgh');
  });

  it('draws one card per way, the first one picked and open', () => {
    render(<AskChoiceBlock choices={[KEY_FILE, GCLOUD]} onAnswer={vi.fn()} />);

    expect(screen.getByTestId(`ask-choice-${KEY_FILE.value}`)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId(`ask-choice-${KEY_FILE.value}`)).toHaveTextContent('Service account key');
    expect(screen.getByTestId(`ask-choice-${GCLOUD.value}`)).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId(`ask-choice-${GCLOUD.value}`)).toHaveTextContent('Uses your own Google account');
    expect(screen.getByTestId('ask-choice-input')).toBeInTheDocument();
    expect(screen.queryByTestId('ask-choice-command')).toBeNull();
  });

  it('a value way answers with the chosen name, =, and what was typed — and not before something is', () => {
    const onAnswer = vi.fn();
    render(<AskChoiceBlock choices={[KEY_FILE, GCLOUD]} onAnswer={onAnswer} />);

    expect(screen.getByTestId('ask-choice-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('ask-choice-input'), { target: { value: '{"type": "service_account"}' } });
    fireEvent.click(screen.getByTestId('ask-choice-submit'));

    expect(onAnswer).toHaveBeenCalledWith('GOOGLE_APPLICATION_CREDENTIALS={"type": "service_account"}');
  });

  it('a way of several values draws an input per field and answers them together, one line each', () => {
    const onAnswer = vi.fn();
    const ADDRESS = { value: 'GMAIL_ADDRESS', label: 'Gmail address', hint: '', secret: false, file: false, command: '' };
    const PASSWORD = { ...APP_PASSWORD, hint: 'Needs 2-Step Verification.', help_url: 'https://myaccount.google.com/apppasswords' };
    const paired = { value: 'app_password', label: 'App password', hint: '', secret: true, file: false, command: '', fields: [ADDRESS, PASSWORD] };
    render(<AskChoiceBlock choices={[paired, GOOGLE]} onAnswer={onAnswer} />);

    expect(screen.getByLabelText('Gmail address')).toBeInTheDocument();
    expect(screen.getByTestId('ask-choice-help-GMAIL_APP_PASSWORD')).toHaveTextContent('Create one at myaccount.google.com/apppasswords');
    expect(screen.getByText('Needs 2-Step Verification.')).toBeInTheDocument();
    expect(screen.getByTestId('ask-choice-submit')).toHaveTextContent('Continue');
    fireEvent.change(screen.getByTestId('ask-choice-input-GMAIL_ADDRESS'), { target: { value: 'me@gmail.com' } });
    expect(screen.getByTestId('ask-choice-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('ask-choice-input-GMAIL_APP_PASSWORD'), { target: { value: 'abcd' } });
    fireEvent.click(screen.getByTestId('ask-choice-submit'));
    expect(onAnswer).toHaveBeenCalledWith('GMAIL_ADDRESS=me@gmail.com\nGMAIL_APP_PASSWORD=abcd');
  });

  it('a sign-in way shows its command and a Run: no input, no Send', () => {
    const onAnswer = vi.fn();
    render(<AskChoiceBlock choices={[KEY_FILE, GCLOUD]} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId(`ask-choice-${GCLOUD.value}`));

    expect(screen.getByTestId('ask-choice-command')).toHaveTextContent(LOGIN);
    expect(screen.getByTestId('ask-choice-run')).toHaveTextContent('Run');
    expect(screen.queryByTestId('ask-choice-input')).toBeNull();
    expect(screen.queryByTestId('ask-choice-submit')).toBeNull();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('Run starts the command in a terminal of its own, drawn under the choice, and waits for the check', async () => {
    const belongingTo = vi
      .spyOn(Shell, 'belongingTo')
      .mockResolvedValue({ id: 'sh-1', ensureStarted: h.ensureStarted, sendInput: h.sendInput } as unknown as Shell);
    render(<AskChoiceBlock choices={[GCLOUD]} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ask-choice-run'));

    expect(await screen.findByTestId('shell-terminal')).toHaveTextContent('sh-1');
    expect(belongingTo).toHaveBeenCalledWith(`ask-choice:${GCLOUD.value}`, { name: GCLOUD.label });
    expect(h.ensureStarted).toHaveBeenCalled();
    await waitFor(() => expect(h.sendInput).toHaveBeenCalledWith(`${LOGIN}\r`));
    expect(screen.getByTestId('ask-choice-waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('ask-choice-run')).toBeNull();
  });
});

describe('a question with choices, drawn by AskForm', () => {
  it('keeps the guide below the cards and posts the picked way as one string', async () => {
    h.get.mockResolvedValue(QUESTION);
    h.post.mockResolvedValue({});
    render(<AskForm questionId="q1" />);

    await screen.findByTestId('ask-choices');
    expect(screen.getByTestId('ask-guide')).toHaveTextContent('IAM');
    // The cards are the form: no bare value field, and no Send of the question's own.
    expect(screen.queryByTestId('ask-input-value')).toBeNull();
    expect(screen.queryByTestId('ask-submit')).toBeNull();
    expect(screen.queryByTestId('ask-auto-waiting')).toBeNull();

    fireEvent.change(screen.getByTestId('ask-choice-input'), { target: { value: 'KEY' } });
    fireEvent.click(screen.getByTestId('ask-choice-submit'));

    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q1/answer', { value: 'GOOGLE_APPLICATION_CREDENTIALS=KEY' }),
    );
  });

  it('a sign-in way leaves only Cancel to press', async () => {
    h.get.mockResolvedValue(QUESTION);
    h.post.mockResolvedValue({});
    render(<AskForm questionId="q1" />);

    fireEvent.click(await screen.findByTestId(`ask-choice-${GCLOUD.value}`));
    expect(screen.queryByTestId('ask-choice-submit')).toBeNull();
    fireEvent.click(screen.getByTestId('ask-cancel'));

    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q1/cancel', undefined));
  });

  it('an ordinary question (no choices) is drawn as before', async () => {
    h.get.mockResolvedValue({ ...QUESTION, auto: false, choices: [] });
    render(<AskForm questionId="q1" />);

    expect(await screen.findByTestId('ask-input-value')).toBeInTheDocument();
    expect(screen.getByTestId('ask-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('ask-choices')).toBeNull();
  });
});
