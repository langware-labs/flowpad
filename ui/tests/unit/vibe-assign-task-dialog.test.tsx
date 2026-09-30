/** A typed-but-never-Entered email must still count as the picked person. */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { VibeAssignTaskDialog } from '@src/pages/flow-page/VibeAssignTaskDialog';

afterEach(cleanup);

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
