/**
 * Everything a wizard run needs, asked once: a question that carries `items` is drawn as one list
 * — an approval is a tick, a value is a field — and answered with `{item path: its value}`. A row
 * left unticked or empty is left out (declined); on a REQUIRED row that is said before sending.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));

import { AskForm } from '@src/components/ask/AskForm';
import { AskItems } from '@src/components/ask/AskItems';

const GIT = { path: 'git/ask', prompt: 'Install Git?', detail: 'Git is missing.', kind: 'confirm', required: true };
const NODE = { path: 'node/ask', prompt: 'Install Node.js?', detail: '', kind: 'confirm', required: false };
const TOKEN = {
  path: 'token',
  prompt: 'Access token',
  detail: 'Used to call the API.',
  kind: 'string',
  secret: true,
  required: true,
};

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.post.mockReset();
});

describe('AskItems', () => {
  it('draws every item with what it is for, approvals ticked', () => {
    render(<AskItems items={[GIT, NODE, TOKEN]} onAnswer={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId('ask-item-git/ask')).toHaveTextContent('Install Git?');
    expect(screen.getByTestId('ask-item-git/ask')).toHaveTextContent('Git is missing.');
    expect(screen.getByTestId('ask-item-git/ask-tick')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ask-item-git/ask-required')).toBeInTheDocument();
    expect(screen.queryByTestId('ask-item-node/ask-required')).toBeNull();
    expect(screen.getByTestId('ask-item-token-input')).toHaveAttribute('type', 'password');
  });

  it('answers once, with each approved or filled item under its path', () => {
    const onAnswer = vi.fn();
    render(<AskItems items={[GIT, NODE, TOKEN]} onAnswer={onAnswer} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByTestId('ask-item-node/ask-tick'));
    fireEvent.change(screen.getByTestId('ask-item-token-input'), { target: { value: ' s3cret ' } });
    fireEvent.click(screen.getByTestId('ask-items-submit'));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({ 'git/ask': {}, token: 's3cret' });
  });

  it('warns on a required item left out, and still lets the person send', () => {
    const onAnswer = vi.fn();
    render(<AskItems items={[GIT, NODE]} onAnswer={onAnswer} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('ask-item-git/ask-warning')).toBeNull();

    fireEvent.click(screen.getByTestId('ask-item-git/ask-tick'));
    expect(screen.getByTestId('ask-item-git/ask-warning')).toBeInTheDocument();
    expect(screen.getByTestId('ask-item-git/ask')).toHaveAttribute('data-missing', 'true');

    fireEvent.click(screen.getByTestId('ask-item-node/ask-tick'));
    expect(screen.queryByTestId('ask-item-node/ask-warning')).toBeNull();

    fireEvent.click(screen.getByTestId('ask-items-submit'));
    expect(onAnswer).toHaveBeenCalledWith({});
  });

  it('an empty required value is a warning from the start', () => {
    render(<AskItems items={[TOKEN]} onAnswer={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('ask-item-token-warning')).toBeInTheDocument();
  });
});

describe('AskForm with a list question', () => {
  it('draws the list in place of its own field and buttons, and posts the list answer', async () => {
    h.get.mockResolvedValue({ id: 'q1', op: 'setup', prompt: 'Finish setting up', fields: null, items: [GIT, NODE] });
    h.post.mockResolvedValue({});
    render(<AskForm questionId="q1" showOp={false} />);

    await waitFor(() => expect(screen.getByTestId('ask-items')).toBeInTheDocument());
    expect(screen.queryByTestId('ask-input-value')).toBeNull();

    fireEvent.click(screen.getByTestId('ask-items-submit'));
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q1/answer', { value: { 'git/ask': {}, 'node/ask': {} } }),
    );
  });

  it('cancelling the list cancels the question', async () => {
    h.get.mockResolvedValue({ id: 'q1', op: 'setup', prompt: 'Finish setting up', fields: null, items: [GIT] });
    h.post.mockResolvedValue({});
    render(<AskForm questionId="q1" showOp={false} />);

    await waitFor(() => expect(screen.getByTestId('ask-items-cancel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ask-items-cancel'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/v1/ask/q1/cancel', undefined));
  });
});
