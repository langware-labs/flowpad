import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';

// The unit tier has no global RTL cleanup (unlike the react tier's setup file).
afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
});

function Section(props: { isLoading?: boolean; itemCount: number; id?: string; scope?: string }) {
  return (
    <NavigatorSection
      id={props.id ?? 'demo'}
      scope={props.scope ?? 'test-nav'}
      label="Demo"
      isLoading={props.isLoading}
      itemCount={props.itemCount}
      emptyState={<span>nothing here</span>}
    >
      <span>a row</span>
    </NavigatorSection>
  );
}

const header = (id = 'demo') => screen.getByTestId(`navigator-section-${id}`);

describe('NavigatorSection', () => {
  it('starts closed, however many rows it holds', () => {
    render(<Section itemCount={3} />);
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a row')).not.toBeInTheDocument();
  });

  it('shows how many rows it holds while closed', () => {
    render(<Section itemCount={42} />);
    expect(screen.getByTestId('navigator-section-demo-count')).toHaveTextContent('42');
  });

  it('says a capped count is a floor', () => {
    render(
      <NavigatorSection id="demo" scope="test-nav" label="Demo" itemCount={1000} truncated>
        <span>a row</span>
      </NavigatorSection>,
    );
    expect(screen.getByTestId('navigator-section-demo-count')).toHaveTextContent('1000+');
  });

  it('shows no count while loading — never a false 0', () => {
    render(<Section isLoading itemCount={0} />);
    expect(screen.queryByTestId('navigator-section-demo-count')).not.toBeInTheDocument();
  });

  it('remembers a section the person opened, and one they closed again', async () => {
    const first = render(<Section itemCount={2} />);
    await userEvent.click(header());
    expect(screen.getByText('a row')).toBeInTheDocument();
    first.unmount();

    const second = render(<Section itemCount={2} />);
    expect(header()).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(header());
    second.unmount();

    render(<Section itemCount={2} />);
    expect(header()).toHaveAttribute('aria-expanded', 'false');
  });

  it('remembers each section of each navigator apart', async () => {
    const opened = render(<Section itemCount={1} id="docs" scope="agent-resources" />);
    await userEvent.click(header('docs'));
    opened.unmount();

    render(
      <>
        <Section itemCount={1} id="docs" scope="agent-resources" />
        <Section itemCount={1} id="skills" scope="agent-resources" />
      </>,
    );
    expect(header('docs')).toHaveAttribute('aria-expanded', 'true');
    expect(header('skills')).toHaveAttribute('aria-expanded', 'false');
    cleanup();
    render(<Section itemCount={1} id="docs" scope="another-nav" />);
    expect(header('docs')).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the empty state once an empty section is opened', async () => {
    render(<Section itemCount={0} />);
    await userEvent.click(header());
    expect(screen.getByText('nothing here')).toBeInTheDocument();
  });

  it('renders the children when empty and no emptyState is given', async () => {
    render(
      <NavigatorSection id="demo" scope="test-nav" label="Demo" itemCount={0}>
        <span>own empty state</span>
      </NavigatorSection>,
    );
    await userEvent.click(header());
    expect(screen.getByText('own empty state')).toBeInTheDocument();
  });
});
