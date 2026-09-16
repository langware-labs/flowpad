import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { InstallSnippetDialog } from '@src/components/install/InstallSnippetDialog';

const TYPEID = 'skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(cleanup);

describe('InstallSnippetDialog', () => {
  it('renders every line copyable, ending with the shell form of Install, plus the one-paste form', () => {
    render(<InstallSnippetDialog open onOpenChange={() => undefined} typeid={TYPEID} />);
    const dialog = screen.getByTestId('install-snippet-dialog');
    expect(dialog).toHaveTextContent(`flow asset install ${TYPEID}`);
    expect(dialog).toHaveTextContent(`uv tool install flowpad && flow start && flow auth login && flow asset install ${TYPEID}`);
  });
});
