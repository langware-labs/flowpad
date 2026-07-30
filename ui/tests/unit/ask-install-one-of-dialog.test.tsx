import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useCapability } = vi.hoisted(() => ({
  useCapability: vi.fn(() => ({
    resolvedKind: null,
  })),
}));

vi.mock('@sdk/react/hooks', () => ({
  useCapability,
}));

import { CapabilityKinds } from '@sdk';
import { AskInstallOneOfDialog } from '@src/components/terminal/openers/AskInstallOneOfDialog';

describe('AskInstallOneOfDialog', () => {
  beforeEach(() => {
    useCapability.mockClear();
  });

  it('does not execute a harness probe while the controller keeps it closed', () => {
    render(<AskInstallOneOfDialog kinds={null} onClose={vi.fn()} />);

    expect(useCapability).toHaveBeenCalledTimes(1);
    expect(useCapability).toHaveBeenCalledWith(CapabilityKinds.Harness, { autoCheck: false });
  });
});
