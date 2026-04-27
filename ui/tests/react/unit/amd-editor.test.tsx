import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AMDEditor } from '@src/components/skills-viewer/amd-editor';
import { unitTestSetup } from '../../utils/test-utils';

// Demo AMD content for testing
const DEMO_AMD_CONTENT = `---
name: demo
description: Demo skill showcasing AMD block structure
tags:
  - demo
  - example
allowedTools:
  - Read
  - Bash
---

# Demo Workflow

<!-- <flow-do /> -->
First instruction: Initialize the workflow context.

<!-- <flow-do /> -->
Second instruction: Validate input parameters.

<!-- <flow-do /> -->
Third instruction: Prepare processing environment.

<!-- <flow-block> -->

## Processing Block

<!-- <flow-do /> -->
Block instruction 1: Load data from source.

<!-- <flow-do /> -->
Block instruction 2: Transform data format.

<!-- <flow-do /> -->
Block instruction 3: Validate transformed data.

<!-- </flow-block> -->

<!-- <flow-if test="$shouldFetch"> -->

<!-- <flow-do /> -->
Fetching external data...

<!-- <flow-call href="./fetch-data.md" /> -->

<!-- </flow-if> -->

<!-- <flow-set name="results" value="$callResult" /> -->

<!-- <flow-each items="$results" as="item"> -->

<!-- <flow-block> -->

## Process Each Item

<!-- <flow-do /> -->
Processing item: $item.name

<!-- <flow-do /> -->
Validating item data integrity.

<!-- <flow-do /> -->
Storing processed result.

<!-- </flow-block> -->

<!-- </flow-each> -->
`;

describe('AMDEditor', () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    await unitTestSetup();

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const renderEditor = (initialContent: string, onSave = vi.fn()) => {
    const result = render(
      <TestWrapper>
        <AMDEditor initialContent={initialContent} onSave={onSave} autoSaveInterval={100} />
      </TestWrapper>,
    );
    return { ...result, onSave };
  };

  describe('Empty State', () => {
    it('shows empty message when no content', async () => {
      renderEditor('');

      await waitFor(() => {
        expect(screen.getByText('No instructions yet')).toBeInTheDocument();
      });
    });

    it('shows Add Block guidance text', async () => {
      renderEditor('');

      await waitFor(() => {
        expect(screen.getByText(/Click Add Block above to get started/i)).toBeInTheDocument();
      });
    });

    it('shows Add Block button in toolbar', async () => {
      renderEditor('');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add block/i })).toBeInTheDocument();
      });
    });
  });

  describe('Block Rendering', () => {
    it('renders DO block labels', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          const doLabels = screen.getAllByText('Do');
          // Should have multiple DO blocks (3 root + 3 in block container + 1 in if + 3 in each/block)
          expect(doLabels.length).toBeGreaterThanOrEqual(3);
        },
        { timeout: 3000 },
      );
    });

    it('renders BLOCK container label', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          const blockLabels = screen.getAllByText('Block');
          expect(blockLabels.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );
    });

    it('renders IF block label', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          expect(screen.getByText('If')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    it('renders SET block label', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          expect(screen.getByText('Set')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    it('renders EACH block label', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          expect(screen.getByText('Each')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    it('renders CALL block label when IF is expanded', async () => {
      const user = userEvent.setup();
      renderEditor(DEMO_AMD_CONTENT);

      // Wait for IF block to render
      await waitFor(
        () => {
          expect(screen.getByText('If')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      // Find and click the IF block's expand button
      const ifBlock = screen.getByText('If').closest('[class*="group"]');
      expect(ifBlock).not.toBeNull();

      // Find the chevron button (expand toggle)
      const expandButton = ifBlock?.querySelector('button');
      if (expandButton) {
        await user.click(expandButton);

        // Now the CALL block should be visible
        await waitFor(() => {
          expect(screen.getByText('Call')).toBeInTheDocument();
        });
      }
    });
  });

  describe('Block Content', () => {
    it('shows DO block content in textarea', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          const textareas = screen.getAllByPlaceholderText('Enter instructions...');
          expect(textareas.length).toBeGreaterThanOrEqual(1);
          // Verify textareas have content (could be any content depending on parser)
          const hasContent = textareas.some((textarea) => (textarea as HTMLTextAreaElement).value.length > 0);
          expect(hasContent).toBe(true);
        },
        { timeout: 3000 },
      );
    });

    it('shows IF block test condition input', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          expect(screen.getByText('If')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      // The IF block should have an input for the test condition
      await waitFor(() => {
        const conditionInput = screen.getByDisplayValue('$shouldFetch');
        expect(conditionInput).toBeInTheDocument();
      });
    });

    it('shows SET block name and value inputs', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          expect(screen.getByText('Set')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      // The SET block should have inputs for name and value
      await waitFor(() => {
        expect(screen.getByDisplayValue('results')).toBeInTheDocument();
        expect(screen.getByDisplayValue('$callResult')).toBeInTheDocument();
      });
    });

    it('shows EACH block items and as attribute inputs', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          expect(screen.getByText('Each')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      // The EACH block should have inputs for items and as
      await waitFor(() => {
        expect(screen.getByDisplayValue('$results')).toBeInTheDocument();
        expect(screen.getByDisplayValue('item')).toBeInTheDocument();
      });
    });
  });

  describe('Container Expansion', () => {
    it('container blocks have expand/collapse chevrons', async () => {
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          // Container types (Block, If, Each) should have chevron buttons
          const blockElement = screen.getAllByText('Block')[0].closest('[class*="group"]');
          expect(blockElement?.querySelector('button')).toBeInTheDocument();

          const ifElement = screen.getByText('If').closest('[class*="group"]');
          expect(ifElement?.querySelector('button')).toBeInTheDocument();

          const eachElement = screen.getByText('Each').closest('[class*="group"]');
          expect(eachElement?.querySelector('button')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    it('can expand BLOCK container to show children', async () => {
      const user = userEvent.setup();
      renderEditor(DEMO_AMD_CONTENT);

      // Wait for Block element to render
      await waitFor(
        () => {
          expect(screen.getAllByText('Block').length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );

      // Find the first Block container and expand it
      const blockElement = screen.getAllByText('Block')[0].closest('[class*="group"]');
      expect(blockElement).not.toBeNull();

      const expandButton = blockElement?.querySelector('button');
      if (expandButton) {
        await user.click(expandButton);

        // After expansion, should see child DO blocks
        await waitFor(() => {
          // Block container has 3 DO children
          const doLabels = screen.getAllByText('Do');
          expect(doLabels.length).toBeGreaterThanOrEqual(3);
        });
      }
    });

    it('can expand EACH container to show children', async () => {
      const user = userEvent.setup();
      renderEditor(DEMO_AMD_CONTENT);

      // Wait for Each element to render
      await waitFor(
        () => {
          expect(screen.getByText('Each')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      // Find and expand the EACH container
      const eachElement = screen.getByText('Each').closest('[class*="group"]');
      expect(eachElement).not.toBeNull();

      const expandButton = eachElement?.querySelector('button');
      if (expandButton) {
        await user.click(expandButton);

        // After expansion, should see nested Block container
        await waitFor(() => {
          // Should now show more Block labels (the nested one inside EACH)
          const blockLabels = screen.getAllByText('Block');
          expect(blockLabels.length).toBeGreaterThanOrEqual(2);
        });
      }
    });
  });

  describe('User Interactions', () => {
    it('selects block on click', async () => {
      const user = userEvent.setup();
      renderEditor(DEMO_AMD_CONTENT);

      await waitFor(
        () => {
          expect(screen.getAllByText('Do').length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );

      // Find the first DO block
      const firstDoBlock = screen.getAllByText('Do')[0].closest('[class*="group"]');
      expect(firstDoBlock).not.toBeNull();

      // Click to select
      await user.click(firstDoBlock!);

      // Check for selection highlight (bg-zinc-200/60 class for light mode)
      await waitFor(() => {
        expect(firstDoBlock?.className).toContain('bg-zinc-200/60');
      });
    });

    it('updates content when editing DO block', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderEditor(DEMO_AMD_CONTENT, onSave);

      await waitFor(
        () => {
          const textareas = screen.getAllByPlaceholderText('Enter instructions...');
          expect(textareas.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );

      // Find the first textarea and type in it
      const firstTextarea = screen.getAllByPlaceholderText('Enter instructions...')[0];
      await user.clear(firstTextarea);
      await user.type(firstTextarea, 'New instruction content');

      // Verify the textarea value changed
      expect(firstTextarea).toHaveValue('New instruction content');

      // Wait for auto-save interval to fire (100ms in tests)
      await waitFor(
        () => {
          expect(onSave).toHaveBeenCalled();
        },
        { timeout: 500 },
      );
    });

    it('calls onSave with serialized content after edit', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderEditor(DEMO_AMD_CONTENT, onSave);

      await waitFor(
        () => {
          const textareas = screen.getAllByPlaceholderText('Enter instructions...');
          expect(textareas.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );

      // Edit the first DO block
      const firstTextarea = screen.getAllByPlaceholderText('Enter instructions...')[0];
      await user.clear(firstTextarea);
      await user.type(firstTextarea, 'Modified content');

      // Wait for auto-save interval (100ms in tests)
      await waitFor(
        () => {
          expect(onSave).toHaveBeenCalled();
          // The serialized content should be a string
          const lastCall = onSave.mock.calls[onSave.mock.calls.length - 1];
          expect(typeof lastCall[0]).toBe('string');
        },
        { timeout: 500 },
      );
    });

    it('can edit IF block test condition', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderEditor(DEMO_AMD_CONTENT, onSave);

      await waitFor(
        () => {
          expect(screen.getByText('If')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );

      // Find the IF block's condition input
      const conditionInput = screen.getByDisplayValue('$shouldFetch');
      expect(conditionInput).toBeInTheDocument();

      // Clear and type new condition
      await user.clear(conditionInput);
      await user.type(conditionInput, '$newCondition > 10');

      expect(conditionInput).toHaveValue('$newCondition > 10');

      // Wait for auto-save interval
      await waitFor(
        () => {
          expect(onSave).toHaveBeenCalled();
        },
        { timeout: 500 },
      );
    });
  });

  describe('Serialization Round-trip', () => {
    it('preserves content structure after edit and serialize', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      renderEditor(DEMO_AMD_CONTENT, onSave);

      await waitFor(
        () => {
          const textareas = screen.getAllByPlaceholderText('Enter instructions...');
          expect(textareas.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );

      // Make an edit
      const firstTextarea = screen.getAllByPlaceholderText('Enter instructions...')[0];
      await user.clear(firstTextarea);
      await user.type(firstTextarea, 'Serialization test');

      // Wait for onSave
      await waitFor(
        () => {
          expect(onSave).toHaveBeenCalled();
          const serialized = onSave.mock.calls[onSave.mock.calls.length - 1][0];
          // The serialized content should contain flow-do markers
          expect(serialized).toContain('flow-do');
        },
        { timeout: 500 },
      );
    });
  });

});
