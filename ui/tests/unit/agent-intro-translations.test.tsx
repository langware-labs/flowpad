import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  AddIntroTranslationButton,
  IntroTranslationFields,
} from '@src/components/assets/editor/agent-profile/AgentIntroTranslations';

vi.mock('@src/contexts/locale-context', () => ({
  useSupportedLocales: () => [
    { code: 'en-US', nativeName: 'English', dir: 'ltr' },
    { code: 'he', nativeName: 'עברית', dir: 'rtl' },
    { code: 'ar', nativeName: 'العربية', dir: 'rtl' },
  ],
}));

describe('AddIntroTranslationButton', () => {
  it('offers only the languages not added yet, and adds the one picked', async () => {
    const onAdd = vi.fn();
    render(<AddIntroTranslationButton translations={{ ar: 'مرحبا' }} onAdd={onAdd} />);
    await userEvent.click(screen.getByTestId('agent-intro-add-language'));
    expect(screen.queryByTestId('agent-intro-add-ar')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('agent-intro-add-en-US'));
    expect(onAdd).toHaveBeenCalledWith('en-US');
  });

  it('disappears once every language is added', () => {
    const { container } = render(
      <AddIntroTranslationButton translations={{ 'en-US': '', he: '', ar: '' }} onAdd={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('IntroTranslationFields', () => {
  it('renders one field per added language and commits trimmed text on blur', () => {
    const onCommit = vi.fn();
    render(<IntroTranslationFields translations={{ ar: ' مرحبا ' }} onChange={() => {}} onCommit={onCommit} />);
    const field = screen.getByTestId('agent-intro-translation-ar').querySelector('textarea')!;
    expect(field).toHaveAttribute('dir', 'rtl');
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith({ ar: 'مرحبا' });
  });

  it('removes a language with its X button', async () => {
    const onCommit = vi.fn();
    render(<IntroTranslationFields translations={{ ar: 'a', 'en-US': 'b' }} onChange={() => {}} onCommit={onCommit} />);
    await userEvent.click(screen.getByRole('button', { name: /العربية/ }));
    expect(onCommit).toHaveBeenCalledWith({ 'en-US': 'b' });
  });
});
