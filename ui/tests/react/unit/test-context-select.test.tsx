import { CompletionOptionsEvents, Flow, dataManager } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LabelSelect } from '@src/components/label-select';
import { unitTestSetup, waitForLabels } from '../../utils/test-utils';

// Wrapper that mounts two LabelSelect instances with scoped containers to demonstrate
// the scopeElementId pattern for testing multiple components with the same internal structure
const TwoLabelSelectsWrapper: React.FC<{ flow: Flow }> = ({ flow }) => {
  // Force re-render when completion options change
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);

  React.useEffect(() => {
    const handleChange = () => forceUpdate();
    flow.options.on(CompletionOptionsEvents.CHANGE, handleChange);
    return () => flow.options.off(CompletionOptionsEvents.CHANGE, handleChange);
  }, [flow]);

  // Access labels directly from flow.options (getter returns resolved)
  const labels = flow.options.labels || [];

  const handleToggle = (label: string) => {
    if (labels.includes(label)) {
      flow.options.removeLabel(label);
    } else {
      flow.options.addLabel(label);
    }
  };

  return (
    <>
      {/* First LabelSelect in its own scoped container */}
      <div data-testid="label-select-1">
        <LabelSelect
          selected={labels}
          available={labels}
          onToggle={handleToggle}
          onAdd={(label) => flow.options.addLabel(label)}
          onRemove={(label) => flow.options.removeLabel(label)}
        />
      </div>

      {/* Second LabelSelect in its own scoped container */}
      <div data-testid="label-select-2">
        <LabelSelect
          selected={labels}
          available={labels}
          onToggle={handleToggle}
          onAdd={(label) => flow.options.addLabel(label)}
          onRemove={(label) => flow.options.removeLabel(label)}
        />
      </div>

      {/* Test helpers */}
      <div data-testid="labels-list">{labels.join(', ')}</div>
    </>
  );
};

describe('Context Select Tests', () => {
  let queryClient: QueryClient;
  let flow: Flow;

  beforeEach(async () => {
    await unitTestSetup();

    // Create a Flow instance for testing with a valid UUIDv4
    flow = new Flow({ id: '12345678-1234-4234-a234-123456789abc' });

    // Register flow in dataManager so ToolsPanel can access it
    dataManager.register_new_entity(flow.typeId, flow);

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('should add label and validate both LabelSelect chip blocks are updated using scoped validation', async () => {
    const user = userEvent.setup();

    render(
      <TestWrapper>
        <TwoLabelSelectsWrapper flow={flow} />
      </TestWrapper>,
    );

    // Initially no labels in either chip block
    await waitForLabels([], 'label-select-1');
    await waitForLabels([], 'label-select-2');

    // Find the first LabelSelect input field (there will be two, get the first)
    const inputs = screen.getAllByPlaceholderText('Add custom label...');
    const firstInput = inputs[0];

    // Type and press Enter to add label "test"
    await user.type(firstInput, 'test{Enter}');

    // Validate both chip blocks are updated (they share the same flow.options)
    await waitForLabels(['test'], 'label-select-1');
    await waitForLabels(['test'], 'label-select-2');

    // Verify labels-list testid also shows the label
    expect(screen.getByTestId('labels-list')).toHaveTextContent('test');
  });
});
