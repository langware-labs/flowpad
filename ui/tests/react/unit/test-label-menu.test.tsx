import {
  CompletionOptionsEvents,
  Flow,
} from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LabelSelect } from '@src/components/label-select';
import ToolsPanel from '@src/components/tools/ToolsPanel';
import { unitTestSetup, waitForLabels } from '../../utils/test-utils';

// Unified wrapper that mounts LabelSelect and ToolsPanel together with a test flow
// Works directly with flow.options for testing with a registered flow instance
const ChatPanelWithToolsWrapper: React.FC<{ flow: Flow }> = ({ flow }) => {
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

  // Get values for ToolsPanel controlled component
  const toolsPanelValues = flow.options.toValues();

  return (
    <>
      {/* Label Select - for adding custom labels */}
      <LabelSelect
        selected={labels}
        available={labels}
        onToggle={handleToggle}
        onAdd={(label) => flow.options.addLabel(label)}
        onRemove={(label) => flow.options.removeLabel(label)}
      />

      {/* Tools Panel - controlled component with value/onChange */}
      <ToolsPanel value={toolsPanelValues} onChange={(values) => flow.options.applyValues(values)} />

      {/* Test helpers */}
      <div data-testid="labels-list">{labels.join(', ')}</div>
      <div data-testid="all-labels">{labels.join(', ')}</div>
    </>
  );
};

describe('Label Menu Tests', () => {
  let queryClient: QueryClient;
  let flow: Flow;

  beforeEach(async () => {
    await unitTestSetup();

    // Create a Flow instance for testing with a valid UUIDv4
    flow = new Flow({ id: '12345678-1234-4234-a234-123456789abc' });

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

  describe('Test 1: Plain Label UI Testing', () => {
    it('should add label via input and validate useEntityLabels updates', async () => {
      const user = userEvent.setup();

      render(
        <TestWrapper>
          <ChatPanelWithToolsWrapper flow={flow} />
        </TestWrapper>,
      );

      // Initially no labels
      expect(screen.getByTestId('labels-list')).toHaveTextContent('');

      // Find the LabelSelect input field in ChatPanelBodyHeader
      const input = screen.getByPlaceholderText('Add custom label...');

      // Type and press Enter to add label
      await user.type(input, 'TestLabel1{Enter}');

      await waitFor(() => {
        expect(screen.getByTestId('labels-list')).toHaveTextContent('TestLabel1');
      });
    });

    it('should remove label by clicking X and validate useEntityLabels updates', async () => {
      render(
        <TestWrapper>
          <ChatPanelWithToolsWrapper flow={flow} />
        </TestWrapper>,
      );

      // Add a label first
      const user = userEvent.setup();
      const input = screen.getByPlaceholderText('Add custom label...');
      await user.type(input, 'TestLabel1{Enter}');

      await waitFor(() => {
        expect(screen.getByTestId('labels-list')).toHaveTextContent('TestLabel1');
      });

      // Find the chip (first occurrence is in the button) and click the X icon inside it
      const chips = screen.getAllByText('TestLabel1');
      const chip = chips[0].closest('button');
      const xIcon = chip?.querySelector('svg');
      expect(xIcon).toBeTruthy();
      await user.click(xIcon!);

      await waitFor(() => {
        expect(screen.getByTestId('labels-list')).toHaveTextContent('');
      });
    });

    it('should add labels and validate they appear in LabelChipBlock', async () => {
      const user = userEvent.setup();

      render(
        <TestWrapper>
          <ChatPanelWithToolsWrapper flow={flow} />
        </TestWrapper>,
      );

      // Initially no labels in chip block
      await waitForLabels([]);

      // Add multiple labels
      const input = screen.getByPlaceholderText('Add custom label...');

      await user.type(input, 'Label1{Enter}');
      await waitForLabels(['Label1']);

      await user.type(input, 'Label2{Enter}');
      await waitForLabels(['Label2', 'Label1']);

      await user.type(input, 'Label3{Enter}');
      await waitForLabels(['Label3', 'Label2', 'Label1']);

      // Add a 4th label - only first 3 should be visible by default (maxChips=3)
      await user.type(input, 'Label4{Enter}');
      await waitForLabels(['Label4', 'Label3', 'Label2']);

      // Verify labels-list testid shows all labels
      await waitFor(() => {
        expect(screen.getByTestId('labels-list')).toHaveTextContent('Label4, Label3, Label2, Label1');
      });
    });
  });

  describe('Test 2: Labels with Model Choice', () => {
    it('should preserve user labels when modelChoice changes', async () => {
      const user = userEvent.setup();

      render(
        <TestWrapper>
          <ChatPanelWithToolsWrapper flow={flow} />
        </TestWrapper>,
      );

      // Add user labels first
      const input = screen.getByPlaceholderText('Add custom label...');
      await user.type(input, 'UserLabel1{Enter}');
      await user.type(input, 'UserLabel2{Enter}');

      await waitFor(() => {
        const labelsValue = flow.state.chat_options.labels.value;
        expect(labelsValue).toContain('UserLabel1');
        expect(labelsValue).toContain('UserLabel2');
      });

      // Backend sends model choice (simulate backend state update)
      flow.state.chat_options.labels.model_choice = ['BackendLabel1', 'BackendLabel2'];
      flow.options.setOptionsState(flow.state.chat_options);

      await waitFor(() => {
        const labelsState = flow.state.chat_options.labels;

        // User values preserved
        expect(labelsState.value).toContain('UserLabel1');
        expect(labelsState.value).toContain('UserLabel2');

        // Model choice set
        expect(labelsState.model_choice).toContain('BackendLabel1');
        expect(labelsState.model_choice).toContain('BackendLabel2');

        // Resolved merges both (via flow.options.labels getter)
        const resolved = flow.options.labels;
        expect(resolved).toEqual(['BackendLabel1', 'BackendLabel2', 'UserLabel2', 'UserLabel1']);

        // All labels displayed
        const labelsDisplay = screen.getByTestId('labels-list').textContent;
        expect(labelsDisplay).toContain('BackendLabel1');
        expect(labelsDisplay).toContain('BackendLabel2');
        expect(labelsDisplay).toContain('UserLabel1');
        expect(labelsDisplay).toContain('UserLabel2');
      });
    });

    it('should not duplicate labels when modelChoice overlaps with value', async () => {
      const user = userEvent.setup();

      render(
        <TestWrapper>
          <ChatPanelWithToolsWrapper flow={flow} />
        </TestWrapper>,
      );

      // User adds labels
      const input = screen.getByPlaceholderText('Add custom label...');
      await user.type(input, 'SharedLabel{Enter}');
      await user.type(input, 'UserOnly{Enter}');

      await waitFor(() => {
        const labelsValue = flow.state.chat_options.labels.value;
        expect(labelsValue).toContain('SharedLabel');
        expect(labelsValue).toContain('UserOnly');
      });

      // Backend sends overlapping label (simulate backend state update)
      flow.state.chat_options.labels.model_choice = ['SharedLabel', 'ModelOnly'];
      flow.options.setOptionsState(flow.state.chat_options);

      await waitFor(() => {
        // Resolved should not duplicate SharedLabel (via flow.options.labels getter)
        const resolved = flow.options.labels;
        expect(resolved).toEqual(['SharedLabel', 'ModelOnly', 'UserOnly']);

        // SharedLabel appears only once
        expect(resolved.filter((l) => l === 'SharedLabel').length).toBe(1);

        // All unique labels displayed
        const labelsDisplay = screen.getByTestId('labels-list').textContent;
        expect(labelsDisplay).toContain('SharedLabel');
        expect(labelsDisplay).toContain('ModelOnly');
        expect(labelsDisplay).toContain('UserOnly');
      });
    });
  });
});
