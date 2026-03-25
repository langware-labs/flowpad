import { describe, expect, it } from 'vitest';
import { ShellCmdProgress, ShellCommandProcessor } from '@sdk/flow_processing/shell-cmd-processor';
import { ShellOutputFlowData } from '@sdk/entities/flow/flow-data-types/shell-output';
import { MockXMLStreamer } from './mock_flow_streamer_test_utils';

/**
 * Test suite for shell store streaming behavior
 *
 * Tests the pattern used in use-shell-store.ts where ShellCmdProgress is used
 * to render streaming output in real-time.
 *
 * Key requirement: Progress updates should contain stdoutElement and stderrElement
 * with content that can be rendered incrementally.
 */
describe('Shell Store Streaming Pattern', () => {
  describe('ShellCmdProgress properties for UI rendering', () => {
    it('should provide stdoutElement.content for rendering during streaming', async () => {
      // This test validates the pattern used in shell stores for rendering
      // The UI needs progress.stdoutElement?.content to display streaming output

      const xml = `<flow-shell-output group-id="cmd_001" channel="stdout" data-type="string">||Line 1
||Line 2
||Line 3
||</flow-shell-output>
||<flow-shell-output group-id="cmd_001" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      // Track progress updates - this simulates how shell store handles streaming
      const progressUpdates: ShellCmdProgress[] = [];
      const renderedContents: string[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);

        // This is the pattern the UI uses to render streaming output
        // It should access stdoutElement?.content, NOT a non-existent "stdout" property
        const currentContent = progress.stdoutElement?.content ?? '';
        renderedContents.push(currentContent);
      });

      // Verify progressive content was available for rendering
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(renderedContents.length).toBeGreaterThan(0);

      // Verify content grows progressively (streaming behavior)
      // At least the final content should include all lines
      const finalContent = renderedContents[renderedContents.length - 1];
      expect(finalContent).toBe('Line 1\nLine 2\nLine 3\n');

      // Verify we can access stdoutElement.content at each progress update
      for (const progress of progressUpdates) {
        // This should NOT throw - stdoutElement should exist when there's stdout
        if (progress.stdoutDelta.length > 0) {
          expect(progress.stdoutElement).not.toBeNull();
          expect(typeof progress.stdoutElement?.content).toBe('string');
        }
      }
    });

    it('should provide stderrElement.content for rendering during streaming', async () => {
      const xml = `<flow-shell-output group-id="cmd_err" channel="stderr" data-type="string">||Error 1
||Error 2
||</flow-shell-output>
||<flow-shell-output group-id="cmd_err" final="true" exit-code="1" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);

        // Same pattern for stderr - access stderrElement?.content
        const stderrContent = progress.stderrElement?.content ?? '';
        // Verify property exists when stderr is present
        if (progress.stderrDelta.length > 0) {
          expect(stderrContent.length).toBeGreaterThan(0);
        }
      });

      // Verify final stderr content
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.stderrElement?.content).toBe('Error 1\nError 2\n');
      expect(finalProgress.exitCode).toBe(1);
    });

    it('should provide both stdout and stderr elements for mixed output', async () => {
      const xml = `<flow-shell-output group-id="cmd_mix" channel="stdout" data-type="string">Processing...
</flow-shell-output>
<flow-shell-output group-id="cmd_mix" channel="stderr" data-type="string">Warning: something
</flow-shell-output>
<flow-shell-output group-id="cmd_mix" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      let lastProgress: ShellCmdProgress | null = null;

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        lastProgress = progress;

        // Pattern for rendering both streams - used by shell UI components
        const stdout = progress.stdoutElement?.content ?? '';
        const stderr = progress.stderrElement?.content ?? '';
        const exitCode = progress.exitCode;

        // These properties should all be accessible
        expect(typeof stdout).toBe('string');
        expect(typeof stderr).toBe('string');
        // exitCode is null until final element
        expect(exitCode === null || typeof exitCode === 'number').toBe(true);
      });

      // Verify final state has both elements
      expect(lastProgress).not.toBeNull();
      expect(lastProgress!.stdoutElement?.content).toBe('Processing...\n');
      expect(lastProgress!.stderrElement?.content).toBe('Warning: something\n');
      expect(lastProgress!.exitCode).toBe(0);
    });

    it('should accumulate deltas correctly for progressive rendering', async () => {
      // This tests the delta accumulation which is critical for streaming UI updates
      const xml = `<flow-shell-output group-id="cmd_delta" channel="stdout" data-type="string">||A||B||C||</flow-shell-output>
||<flow-shell-output group-id="cmd_delta" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const deltas: string[] = [];
      const fullContents: string[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        // Collect deltas
        if (progress.stdoutDelta) {
          deltas.push(progress.stdoutDelta);
        }
        // Collect full content at each step
        fullContents.push(progress.stdoutElement?.content ?? '');
      });

      // Verify all deltas together equal the final content
      const allDeltas = deltas.join('');
      expect(allDeltas).toBe('ABC');

      // Verify final content matches accumulated deltas
      const finalContent = fullContents[fullContents.length - 1];
      expect(finalContent).toBe('ABC');
    });

    it('should allow creating ShellOutputFlowData from progress for store updates', async () => {
      // This tests the exact pattern used in use-shell-store.ts line 156
      // const outputFD = new ShellOutputFlowData(progress.stdout, progress.stderr, progress.exitCode ?? undefined);
      // This pattern is INCORRECT - the correct way is to use stdoutElement/stderrElement

      const xml = `<flow-shell-output group-id="cmd_store" channel="stdout" data-type="string">Output here
</flow-shell-output>
<flow-shell-output group-id="cmd_store" channel="stderr" data-type="string">Error here
</flow-shell-output>
<flow-shell-output group-id="cmd_store" final="true" exit-code="42" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      let createdFlowData: InstanceType<typeof ShellOutputFlowData> | null = null;

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        // CORRECT pattern: use stdoutElement?.content and stderrElement?.content
        const stdout = progress.stdoutElement?.content ?? '';
        const stderr = progress.stderrElement?.content ?? '';
        const exitCode = progress.exitCode ?? undefined;

        createdFlowData = new ShellOutputFlowData(stdout, stderr, exitCode);
      });

      // Verify the created FlowData has correct values
      expect(createdFlowData).not.toBeNull();
      expect(createdFlowData!.stdout).toBe('Output here\n');
      expect(createdFlowData!.stderr).toBe('Error here\n');
      expect(createdFlowData!.exitCode).toBe(42);
    });
  });

  describe('Real-time streaming detection', () => {
    it('should emit multiple progress updates for streamed content', async () => {
      // Verify that streaming produces multiple progress events (not just one at the end)
      const xml = `<flow-shell-output group-id="cmd_rt" channel="stdout" data-type="string">||First||Second||Third||</flow-shell-output>
||<flow-shell-output group-id="cmd_rt" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      let progressCount = 0;

      await ShellCommandProcessor.processCmdStream(reader, () => {
        progressCount++;
      });

      // Should have multiple progress updates for streaming
      expect(progressCount).toBeGreaterThan(1);
    });

    it('should have growing content length across progress updates', async () => {
      const xml = `<flow-shell-output group-id="cmd_grow" channel="stdout" data-type="string">||A||AB||ABC||</flow-shell-output>
||<flow-shell-output group-id="cmd_grow" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const contentLengths: number[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        if (progress.stdoutElement) {
          contentLengths.push(progress.stdoutElement.content.length);
        }
      });

      // Content should grow progressively
      expect(contentLengths.length).toBeGreaterThan(1);

      // Final length should be the longest
      const maxLength = Math.max(...contentLengths);
      expect(contentLengths[contentLengths.length - 1]).toBe(maxLength);
    });
  });
});
