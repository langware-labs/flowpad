import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Agent } from '@sdk';
import { AgentIntroMessage } from '@src/components/agents/AgentIntroMessage';

vi.mock('@src/components/agents/AgentIntroCard', () => ({
  AgentIntroCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@src/components/agents/AgentAvatar', () => ({
  AgentAvatar: () => <span data-testid="avatar" />,
}));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/contexts/view-mode-context')>();
  return { ...actual, useViewMode: () => mocks.mode };
});
vi.mock('@src/contexts/locale-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/contexts/locale-context')>();
  return { ...actual, useLocale: () => mocks.locale };
});
const mocks = vi.hoisted(() => ({ mode: 'vibe' as string, locale: 'he' as string }));

describe('AgentIntroMessage', () => {
  it('renders nothing without an agent or without an intro', () => {
    const { container } = render(<AgentIntroMessage agent={null} />);
    expect(container).toBeEmptyDOMElement();
    const blank = render(<AgentIntroMessage agent={new Agent({ name: 'g', intro: '   ' })} />);
    expect(blank.container).toBeEmptyDOMElement();
  });

  it('hides the intro on the terminal surface (Advanced/Dev)', () => {
    mocks.mode = 'advanced';
    const { container } = render(<AgentIntroMessage agent={new Agent({ name: 'g', intro: 'Hi' })} />);
    expect(container).toBeEmptyDOMElement();
    mocks.mode = 'vibe';
  });

  it('renders the intro as an assistant row signed by the agent', () => {
    render(<AgentIntroMessage agent={new Agent({ name: 'greeter', title: 'Greeter', intro: 'Hi **there**' })} />);
    const row = screen.getByTestId('agent-intro-message');
    expect(row).toHaveAttribute('data-role', 'assistant');
    expect(row).toHaveTextContent('Greeter');
    expect(row).toHaveTextContent('Hi there');
    expect(row.querySelector('strong')).toHaveTextContent('there');
  });

  it('shows the active locale translation instead of the default intro', () => {
    mocks.locale = 'ar';
    const agent = new Agent({ name: 'g', intro: 'שלום', intro_translations: { ar: 'مرحبا', 'en-US': 'Hi' } });
    render(<AgentIntroMessage agent={agent} />);
    expect(screen.getByTestId('agent-intro-message')).toHaveTextContent('مرحبا');
    mocks.locale = 'he';
  });

  it('falls back to the default intro when the active locale has no (or a blank) translation', () => {
    mocks.locale = 'en-US';
    const agent = new Agent({ name: 'g', intro: 'שלום', intro_translations: { ar: 'مرحبا', 'en-US': '  ' } });
    render(<AgentIntroMessage agent={agent} />);
    expect(screen.getByTestId('agent-intro-message')).toHaveTextContent('שלום');
    mocks.locale = 'he';
  });
});
