/**
 * `AddPeopleDialog` — the two ways an admin puts people on a team's budget: type rows, or upload
 * a sheet. One form for both, because a CSV import that landed somewhere different from the
 * manual add would grow different rules over time.
 *
 * The write itself (`addPeopleToTeam`, the add-vs-update decision) is `add-people` layer's own
 * suite; this covers the DIALOG's job — turning a click, a typed row or a picked file into the
 * drafts that layer receives, and what the dialog shows back when some of them fail.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useAddPeople: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));

import { AddPeopleDialog } from '@src/components/organization/budgets/AddPeopleDialog';

const POOL_ID = 'llm_endpoint-550e8400-e29b-41d4-a716-446655440000';

function draw(
  existing: unknown[] = [],
  // Uncapped by default: most of these tests are about WHAT is sent, not about the ceiling. The
  // ceiling's own arithmetic is `available-to-allocate.test.ts`; that it is actually WIRED to this
  // dialog is the last describe block below.
  poolFunds: { limit_usd: number | null; allocated_usd: number | null } = { limit_usd: null, allocated_usd: null },
) {
  const onOpenChange = vi.fn();
  render(
    <AddPeopleDialog
      open
      onOpenChange={onOpenChange}
      poolId={POOL_ID}
      teamName="Platform"
      existing={existing as never}
      poolFunds={poolFunds}
    />,
  );
  return { onOpenChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddPeopleDialog — adding one by one', () => {
  it('sends a typed row as one draft, and closes on a clean result', async () => {
    h.mutateAsync.mockResolvedValue({ added: ['ada@example.com'], updated: [], failed: [] });
    const { onOpenChange } = draw();

    fireEvent.change(screen.getByTestId('add-person-name-0'), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByTestId('add-person-email-0'), { target: { value: 'ADA@example.com' } });
    fireEvent.change(screen.getByTestId('add-person-budget-0'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    expect(h.mutateAsync).toHaveBeenCalledWith({
      poolId: POOL_ID,
      drafts: [{ name: 'Ada Lovelace', email: 'ada@example.com', budget: 50 }],
      existing: [],
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('adds another row and sends both', async () => {
    h.mutateAsync.mockResolvedValue({ added: ['a@example.com', 'b@example.com'], updated: [], failed: [] });
    draw();

    fireEvent.click(screen.getByTestId('add-person-row'));
    fireEvent.change(screen.getByTestId('add-person-email-0'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByTestId('add-person-email-1'), { target: { value: 'b@example.com' } });
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    const drafts = h.mutateAsync.mock.calls[0][0].drafts;
    expect(drafts.map((d: { email: string }) => d.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('leaves an unfilled row out of the drafts rather than sending an empty address', async () => {
    h.mutateAsync.mockResolvedValue({ added: ['a@example.com'], updated: [], failed: [] });
    draw();

    fireEvent.click(screen.getByTestId('add-person-row'));
    fireEvent.change(screen.getByTestId('add-person-email-0'), { target: { value: 'a@example.com' } });
    // Row 1 (the blank one just added) is left empty.
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    expect(h.mutateAsync.mock.calls[0][0].drafts).toHaveLength(1);
  });

  it('refuses to submit with no address anywhere, and never calls the mutation', () => {
    draw();
    fireEvent.click(screen.getByTestId('add-people-submit'));
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-people-problems').textContent).toMatch(/add at least one email/i);
  });

  it('keeps the dialog open and lists exactly the failed addresses when some rows bounce', async () => {
    h.mutateAsync.mockResolvedValue({
      added: ['ok@example.com'],
      updated: [],
      failed: [{ email: 'bad@example.com', reason: 'Sign in to share this budget' }],
    });
    const { onOpenChange } = draw();

    fireEvent.click(screen.getByTestId('add-person-row'));
    fireEvent.change(screen.getByTestId('add-person-email-0'), { target: { value: 'ok@example.com' } });
    fireEvent.change(screen.getByTestId('add-person-email-1'), { target: { value: 'bad@example.com' } });
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    expect(screen.getByTestId('add-people-problems').textContent).toMatch(/bad@example\.com.*Sign in to share/);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('AddPeopleDialog — uploading a CSV', () => {
  function csvFile(text: string) {
    const file = new File([text], 'people.csv', { type: 'text/csv' });
    // jsdom's File has no real `.text()`; the component reads it exactly as a browser upload would.
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
    return file;
  }

  it('replaces the rows with the parsed sheet rather than appending to the blank starter row', async () => {
    draw();
    const csv = 'name,email,budget\nAda Lovelace,ada@example.com,50\nAlan Turing,alan@example.com,25\n';

    fireEvent.change(screen.getByTestId('add-people-csv-input'), { target: { files: [csvFile(csv)] } });

    await waitFor(() => expect(screen.getByTestId('add-person-email-1')).toBeTruthy());
    expect(screen.getByTestId<HTMLInputElement>('add-person-name-0').value).toBe('Ada Lovelace');
    expect(screen.getByTestId<HTMLInputElement>('add-person-email-0').value).toBe('ada@example.com');
    expect(screen.getByTestId<HTMLInputElement>('add-person-budget-0').value).toBe('50');
    expect(screen.getByTestId<HTMLInputElement>('add-person-email-1').value).toBe('alan@example.com');
    // The pre-upload blank starter row must be gone, not sitting as a third, empty draft.
    expect(screen.queryByTestId('add-person-email-2')).toBeNull();
  });

  it('imports the good rows and reports the bad line when the sheet is partly broken', async () => {
    draw();
    const csv = 'name,email,budget\nAda,ada@example.com,50\nBroken,not-an-email,10\n';

    fireEvent.change(screen.getByTestId('add-people-csv-input'), { target: { files: [csvFile(csv)] } });

    await waitFor(() => expect(screen.getByTestId('add-people-problems')).toBeTruthy());
    expect(screen.getByTestId<HTMLInputElement>('add-person-email-0').value).toBe('ada@example.com');
    expect(screen.getByTestId('add-people-problems').textContent).toMatch(/line 3/i);
  });

  it('reports a file with no readable rows instead of silently doing nothing', async () => {
    draw();
    fireEvent.change(screen.getByTestId('add-people-csv-input'), {
      target: { files: [csvFile('name,email,budget\n')] },
    });

    await waitFor(() => expect(screen.getByTestId('add-people-problems')).toBeTruthy());
    expect(screen.getByTestId('add-people-problems').textContent).toMatch(/no rows/i);
  });

  it('re-budgets someone already on the team instead of duplicating them, via the existing list', async () => {
    h.mutateAsync.mockResolvedValue({ added: [], updated: ['ada@example.com'], failed: [] });
    draw([
      {
        endpoint_id: 'llm_endpoint-1',
        name: 'Ada',
        email: 'ada@example.com',
        limit_usd: 10,
        spent_usd: 0,
        user_id: 'u1',
        system_default: false,
      },
    ]);
    const csv = 'name,email,budget\nAda,ada@example.com,80\n';

    fireEvent.change(screen.getByTestId('add-people-csv-input'), { target: { files: [csvFile(csv)] } });
    await waitFor(() =>
      expect(screen.getByTestId<HTMLInputElement>('add-person-email-0').value).toBe('ada@example.com'),
    );
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
    expect(h.mutateAsync.mock.calls[0][0].existing).toHaveLength(1);
  });
});

/**
 * The whole sheet is weighed at once against what the team pool has left. Row by row would wave
 * through forty $10 allowances against a pool holding $50 — each one fits, the sheet does not.
 */
describe('AddPeopleDialog — more than the team has left', () => {
  const capped = { limit_usd: 50, allocated_usd: 0 };

  function typeRow(index: number, email: string, budget: string) {
    if (index > 0) fireEvent.click(screen.getByTestId('add-person-row'));
    fireEvent.change(screen.getByTestId(`add-person-email-${index}`), { target: { value: email } });
    fireEvent.change(screen.getByTestId(`add-person-budget-${index}`), { target: { value: budget } });
  }

  it('refuses a sheet whose total exceeds the pool, and sends nothing', async () => {
    draw([], capped);
    typeRow(0, 'a@example.com', '30');
    typeRow(1, 'b@example.com', '30');
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(screen.getByTestId('add-people-problems')).toBeTruthy());
    expect(screen.getByTestId('add-people-problems').textContent).toMatch(/\$60.*\$50.*Platform/);
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('accepts the same rows when they fit', async () => {
    h.mutateAsync.mockResolvedValue({ added: ['a@example.com', 'b@example.com'], updated: [], failed: [] });
    draw([], capped);
    typeRow(0, 'a@example.com', '30');
    typeRow(1, 'b@example.com', '20');
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
  });

  it('frees what a re-budget overwrites before judging the sheet', async () => {
    // Ada is the only allocation on the pool: $40 of $50. Moving her to $45 costs $5, not $45.
    // Without crediting back what she already holds this reads as "$10 left, $45 asked" and an
    // edit that plainly fits gets refused.
    h.mutateAsync.mockResolvedValue({ added: [], updated: ['ada@example.com'], failed: [] });
    draw([{ endpoint_id: 'llm_endpoint-x', email: 'ada@example.com', limit_usd: 40 }], {
      limit_usd: 50,
      allocated_usd: 40,
    });
    typeRow(0, 'ada@example.com', '45');
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled());
  });

  it('still holds the ceiling for a re-budget, counting what OTHERS hold', async () => {
    // Same $50 pool, but $50 is out: Ada's $40 plus $10 to somebody else. Her real ceiling is $40,
    // so $45 is refused — the credit above frees her own money back, never anyone else's.
    draw([{ endpoint_id: 'llm_endpoint-x', email: 'ada@example.com', limit_usd: 40 }], {
      limit_usd: 50,
      allocated_usd: 50,
    });
    typeRow(0, 'ada@example.com', '45');
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(screen.getByTestId('add-people-problems')).toBeTruthy());
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('requires an amount on every row when the pool is capped', async () => {
    draw([], capped);
    typeRow(0, 'a@example.com', '');
    fireEvent.click(screen.getByTestId('add-people-submit'));

    await waitFor(() => expect(screen.getByTestId('add-people-problems')).toBeTruthy());
    expect(screen.getByTestId('add-people-problems').textContent).toMatch(/needs an amount/i);
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });
});
