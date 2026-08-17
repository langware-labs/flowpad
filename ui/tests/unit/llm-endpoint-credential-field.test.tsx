/**
 * `CredentialField` — write-only. The input is a password field, the typed
 * key never appears as text anywhere in the DOM, it is cleared after Save,
 * Test yields a Valid/Invalid badge, and only the hub's masked hint is echoed.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

const h = vi.hoisted(() => ({
  setCredential: vi.fn(() => Promise.resolve({ ok: true, credential_hint: '****cret' })),
  testCredential: vi.fn(
    (): Promise<{ valid: boolean; status: number; models_count: number; message?: string }> =>
      Promise.resolve({ valid: true, status: 200, models_count: 42 }),
  ),
  deleteCredential: vi.fn(() => Promise.resolve({ ok: true })),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmEndpointsService: {
      ...(actual.llmEndpointsService as object),
      setCredential: h.setCredential,
      testCredential: h.testCredential,
      deleteCredential: h.deleteCredential,
    },
  };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { CredentialField } from '@src/components/llm-endpoints/CredentialField';

const ID = '99999999-0000-4000-8000-000000000000';
const KEY = 'sk-ant-VERY-secret';

function Harness({ endpointId, hint = '' }: { endpointId?: string; hint?: string }) {
  const [value, setValue] = useState('');
  const [stored, setStored] = useState(hint);
  return (
    <CredentialField
      endpointId={endpointId}
      credentialHint={stored}
      value={value}
      onChange={setValue}
      onStored={setStored}
    />
  );
}

describe('CredentialField', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('is a password input that never shows the key as text', async () => {
    const { container } = render(<Harness endpointId={ID} />);
    const input = screen.getByTestId<HTMLInputElement>('credential-input');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('new-password');

    await userEvent.type(input, KEY);
    expect(input.value).toBe(KEY);
    // Never a text node: the only place the key exists is the password input's
    // own value (a controlled input mirrors it onto the `value` attribute, so
    // the check is on text and on every OTHER element's markup).
    expect(container.textContent).not.toContain(KEY);
    input.remove();
    expect(container.innerHTML).not.toContain(KEY);
  });

  it('Save sends the key to the hub, clears the input, and shows only the masked hint', async () => {
    const { container } = render(<Harness endpointId={ID} />);
    const input = screen.getByTestId<HTMLInputElement>('credential-input');
    await userEvent.type(input, KEY);
    await userEvent.click(screen.getByTestId('credential-save'));

    await waitFor(() => expect(h.setCredential).toHaveBeenCalledWith(ID, KEY));
    await waitFor(() => expect(input.value).toBe(''));
    expect(screen.getByTestId('credential-hint').textContent).toContain('****cret');
    expect(container.innerHTML).not.toContain(KEY);
  });

  it('Test on a typed key tests WITHOUT storing and shows Valid', async () => {
    render(<Harness endpointId={ID} />);
    await userEvent.type(screen.getByTestId('credential-input'), KEY);
    await userEvent.click(screen.getByTestId('credential-test'));

    await waitFor(() => expect(h.testCredential).toHaveBeenCalledWith(ID, KEY));
    expect(h.setCredential).not.toHaveBeenCalled();
    expect((await screen.findByTestId('credential-verdict')).textContent).toContain('Valid (42 models)');
  });

  it('Test with a stored key and no input tests the stored one; Invalid shows the status', async () => {
    h.testCredential.mockResolvedValueOnce({ valid: false, status: 401, models_count: 0, message: 'unauthorized' });
    render(<Harness endpointId={ID} hint="****abcd" />);
    await userEvent.click(screen.getByTestId('credential-test'));

    await waitFor(() => expect(h.testCredential).toHaveBeenCalledWith(ID, undefined));
    expect((await screen.findByTestId('credential-verdict')).textContent).toContain('Invalid (401)');
  });

  it('Delete asks first, then removes the stored key', async () => {
    render(<Harness endpointId={ID} hint="****abcd" />);
    await userEvent.click(screen.getByTestId('credential-delete'));
    expect(h.deleteCredential).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.deleteCredential).toHaveBeenCalledWith(ID));
    await waitFor(() => expect(screen.queryByTestId('credential-hint')).toBeNull());
  });

  it('without an endpoint (create flow) it is a plain controlled input — no Save/Test/Delete', async () => {
    render(<Harness />);
    expect(screen.queryByTestId('credential-save')).toBeNull();
    expect(screen.queryByTestId('credential-test')).toBeNull();
    expect(screen.queryByTestId('credential-delete')).toBeNull();
    await userEvent.type(screen.getByTestId('credential-input'), 'abc{enter}');
    expect(h.setCredential).not.toHaveBeenCalled();
  });
});
