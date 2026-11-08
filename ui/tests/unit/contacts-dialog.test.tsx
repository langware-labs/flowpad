import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContactsDialog } from '@src/components/contact-picker/ContactsDialog';

vi.mock('@src/components/conversation/ContactPermissionsDialog', () => ({ ContactPermissionsDialog: () => null }));
vi.mock('@src/components/contact-picker/CreateContactsGroupDialog', () => ({
  CreateContactsGroupDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="create-group-open" /> : null),
}));
vi.mock('@src/components/contact-picker/use-contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/contact-picker/use-contacts')>()),
  useContacts: () => ({ contacts: [{ id: 'u-noa', email: 'noa@example.com', name: 'Noa' }], refetch: vi.fn() }),
}));
vi.mock('@src/components/contact-picker/use-contacts-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/contact-picker/use-contacts-groups')>()),
  useContactsGroups: () => ({
    groups: [{ id: 'g-1', displayName: 'Design team', contacts: [{}, {}, {}] }],
    refetch: vi.fn(),
  }),
}));

describe('ContactsDialog', () => {
  it('lists people, then groups, and opens New group from the Groups tab', () => {
    render(<ContactsDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByText('Noa')).toBeTruthy();
    expect(screen.queryByTestId('contacts-new-group')).toBeNull();

    fireEvent.click(screen.getByTestId('contacts-tab-groups'));
    expect(screen.getByText('Design team')).toBeTruthy();
    expect(screen.getByText('3 members')).toBeTruthy();

    fireEvent.click(screen.getByTestId('contacts-new-group'));
    expect(screen.getByTestId('create-group-open')).toBeTruthy();
  });
});
