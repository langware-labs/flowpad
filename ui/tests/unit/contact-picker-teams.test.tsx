/**
 * Teams in the ContactPicker (R2): only where the surface asks for them, one
 * chip per team.
 *
 * This is a React test in the UNIT tier: the react tier needs a live backend,
 * and the local team rows are stubbed through `useEntitiesQuery`.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConversationParticipant, type QueryRequest } from '@sdk';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const ZSCHOOL = { id: UUID(1), name: 'zschool', remote: true };

const h = vi.hoisted(() => ({ teams: [] as unknown[], teamRequests: [] as QueryRequest[] }));

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: (request: QueryRequest) => {
    if (request.type === 'team') h.teamRequests.push(request);
    return { data: request.type === 'team' ? h.teams : [], refetch: () => undefined };
  },
}));
vi.mock('@src/components/contact-picker/use-computed-groups', () => ({ useComputedGroups: () => [] }));

import { ContactPicker } from '@src/components/contact-picker/ContactPicker';

let changes: ConversationParticipant[][];

function Harness({ includeTeams }: { includeTeams?: boolean }) {
  const [value, setValue] = useState<ConversationParticipant[]>([]);
  return (
    <ContactPicker
      value={value}
      onChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
      includeTeams={includeTeams}
    />
  );
}

beforeEach(() => {
  h.teams = [ZSCHOOL];
  h.teamRequests = [];
  changes = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ContactPicker with includeTeams', () => {
  it('suggests zschool as the sharer types "zs", and picking it adds one team chip', async () => {
    const user = userEvent.setup();
    render(<Harness includeTeams />);

    await user.type(screen.getByTestId('contact-input'), 'zs');
    const option = await screen.findByTestId(`contact-team-option-${ZSCHOOL.id}`);
    expect(option).toHaveTextContent('zschool');
    await user.click(option);

    const chip = screen.getByTestId(`contact-team-chip-${ZSCHOOL.id}`);
    expect(chip).toHaveTextContent('zschool');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual([
      expect.objectContaining({ kind: 'team', typeid: `team-${ZSCHOOL.id}`, name: 'zschool' }),
    ]);
  });

  it('adds nothing when an already-selected team is picked again', async () => {
    const user = userEvent.setup();
    render(<Harness includeTeams />);

    await user.type(screen.getByTestId('contact-input'), 'zs');
    await user.click(await screen.findByTestId(`contact-team-option-${ZSCHOOL.id}`));
    await user.type(screen.getByTestId('contact-input'), 'zs');
    await user.click(await screen.findByTestId(`contact-team-option-${ZSCHOOL.id}`));

    expect(changes).toHaveLength(1);
    expect(screen.getAllByTestId(`contact-team-chip-${ZSCHOOL.id}`)).toHaveLength(1);
  });

  it('asks the local query for hub (remote) teams only', () => {
    render(<Harness includeTeams />);

    expect(h.teamRequests.length).toBeGreaterThan(0);
    for (const request of h.teamRequests) {
      expect(request.query?.validate({ id: ZSCHOOL.id, remote: true })).toBe(true);
      expect(request.query?.validate({ id: ZSCHOOL.id, remote: false })).toBe(false);
    }
  });
});

describe('ContactPicker without includeTeams (every non-project share surface)', () => {
  it('shows no team', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByTestId('contact-input'), 'zs');

    expect(screen.queryByTestId(`contact-team-option-${ZSCHOOL.id}`)).toBeNull();
  });
});
