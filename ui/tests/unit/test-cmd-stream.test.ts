import { describe, expect, it } from 'vitest';
import { ShellCmdProgress, ShellCommandProcessor } from '@sdk/flow_processing/shell-cmd-processor';
import { MockXMLStreamer } from './mock_flow_streamer_test_utils';

describe('ShellCommandProcessor', () => {
  describe('processCmdStream', () => {
    it('should process simple stdout with exit code', async () => {
      // Mock XML response with stdout
      const xml = `<flow-shell-output group-id="cmd_123" channel="stdout" data-type="string">Hello World
</flow-shell-output>
<flow-shell-output group-id="cmd_123" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      // Track progress updates with deltas
      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);
      });

      // Verify progress callbacks were called
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Verify final progress includes exit code
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.exitCode).toBe(0);
      expect(finalProgress.stdoutElement?.content).toBe('Hello World\n');
      expect(finalProgress.stderrElement?.content ?? '').toBe('');

      // Verify deltas - with progressive streaming, deltas accumulate across multiple updates
      // Collect all stdout deltas
      const allStdoutDeltas = progressUpdates.map((p) => p.stdoutDelta).join('');
      expect(allStdoutDeltas).toBe('Hello World\n');
    });

    it('should process simple stderr with exit code', async () => {
      // Mock XML response with stderr
      const xml = `<flow-shell-output group-id="cmd_456" channel="stderr" data-type="string">Error: file not found
</flow-shell-output>
<flow-shell-output group-id="cmd_456" final="true" exit-code="1" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);
      });

      // Verify final progress
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.stdoutElement?.content ?? '').toBe('');
      expect(finalProgress.stderrElement?.content).toBe('Error: file not found\n');
      expect(finalProgress.exitCode).toBe(1);
    });

    it('should process both stdout and stderr with exit code', async () => {
      // Mock XML response with both stdout and stderr
      const xml = `<flow-shell-output group-id="cmd_789" channel="stdout" data-type="string">Processing...
Done!
</flow-shell-output>
<flow-shell-output group-id="cmd_789" channel="stderr" data-type="string">Warning: deprecated function
</flow-shell-output>
<flow-shell-output group-id="cmd_789" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);
      });

      // Verify final progress
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.stdoutElement?.content).toBe('Processing...\nDone!\n');
      expect(finalProgress.stderrElement?.content).toBe('Warning: deprecated function\n');
      expect(finalProgress.exitCode).toBe(0);
    });

    it('should handle streaming chunks progressively with deltas', async () => {
      // Mock XML with chunk markers to simulate streaming
      const xml = `<flow-shell-output group-id="cmd_999" channel="stdout" data-type="string">||Line 1
||Line 2
||Line 3
||</flow-shell-output>
||<flow-shell-output group-id="cmd_999" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      // Track progress updates with deltas
      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);
      });

      // Verify progressive updates occurred
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Verify final result
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.stdoutElement?.content).toBe('Line 1\nLine 2\nLine 3\n');
      expect(finalProgress.exitCode).toBe(0);

      // Verify all deltas combined equal the final content
      const allDeltas = progressUpdates.map((p) => p.stdoutDelta).join('');
      expect(allDeltas).toBe('Line 1\nLine 2\nLine 3\n');

      // Verify cumulative stdout grows with each update - at least one update should have content
      const updatesWithContent = progressUpdates.filter((p) => p.stdoutElement?.content.length > 0);
      expect(updatesWithContent.length).toBeGreaterThan(0);
      expect(finalProgress.stdoutElement?.content).toBe('Line 1\nLine 2\nLine 3\n');
    });

    it('should handle multiple group-ids for different commands', async () => {
      // Mock XML with multiple commands (different group-ids)
      const xml = `<flow-shell-output group-id="cmd_001" channel="stdout" data-type="string">First command
</flow-shell-output>
<flow-shell-output group-id="cmd_001" final="true" exit-code="0" data-type="string"></flow-shell-output>
<flow-shell-output group-id="cmd_002" channel="stdout" data-type="string">Second command
</flow-shell-output>
<flow-shell-output group-id="cmd_002" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);
      });

      // Should process all commands - verify we got progress for both
      expect(progressUpdates.length).toBeGreaterThan(0);

      // Verify we got progress events for both commands
      // Each group-id has its own element, so we should see different stdout content
      const uniqueStdoutValues = new Set(progressUpdates.map((p) => p.stdoutElement?.content).filter(Boolean));
      expect(uniqueStdoutValues.size).toBeGreaterThan(0);

      // Final progress should have last command's exit code
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.exitCode).toBe(0);

      // Final progress should have the second command's output (last group-id)
      expect(finalProgress.stdoutElement?.content).toContain('Second command');
    });

    it('should handle empty output with exit code', async () => {
      // Mock XML with no output, just final element
      const xml = `<flow-shell-output group-id="cmd_empty" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);
      });

      // Should have progress with exit code but no stdout/stderr
      expect(progressUpdates.length).toBeGreaterThan(0);
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.exitCode).toBe(0);
      expect(finalProgress.stdoutElement).toBeNull();
      expect(finalProgress.stderrElement).toBeNull();
    });

    it('should handle non-zero exit codes', async () => {
      // Mock XML with various exit codes
      const testCases = [
        { exitCode: 1, description: 'general error' },
        { exitCode: 127, description: 'command not found' },
        { exitCode: 130, description: 'interrupted' },
      ];

      for (const testCase of testCases) {
        const xml = `<flow-shell-output group-id="cmd_error" channel="stderr" data-type="string">Error occurred
</flow-shell-output>
<flow-shell-output group-id="cmd_error" final="true" exit-code="${testCase.exitCode}" data-type="string"></flow-shell-output>`;

        const streamer = new MockXMLStreamer(xml);
        const reader = streamer.readableStream().getReader();

        const progressUpdates: ShellCmdProgress[] = [];

        await ShellCommandProcessor.processCmdStream(reader, (progress) => {
          progressUpdates.push(progress);
        });

        const finalProgress = progressUpdates[progressUpdates.length - 1];
        expect(finalProgress.exitCode).toBe(testCase.exitCode);
        expect(finalProgress.stderrElement?.content).toBe('Error occurred\n');
      }
    });

    it('should invoke progress callback with deltas during streaming', async () => {
      // Mock XML with streaming content
      const xml = `<flow-shell-output group-id="cmd_callback" channel="stdout" data-type="string">||Chunk 1||Chunk 2||</flow-shell-output>
||<flow-shell-output group-id="cmd_callback" final="true" exit-code="0" data-type="string"></flow-shell-output>`;

      const streamer = new MockXMLStreamer(xml);
      const reader = streamer.readableStream().getReader();

      const progressUpdates: ShellCmdProgress[] = [];

      await ShellCommandProcessor.processCmdStream(reader, (progress) => {
        progressUpdates.push(progress);
      });

      // Verify callbacks were invoked
      expect(progressUpdates.length).toBeGreaterThan(0);

      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.stdoutElement?.content).toBe('Chunk 1Chunk 2');

      // Verify deltas accumulate correctly
      const allDeltas = progressUpdates.map((p) => p.stdoutDelta).join('');
      expect(allDeltas).toBe('Chunk 1Chunk 2');

      // Verify exit code is in final progress
      expect(finalProgress.exitCode).toBe(0);
    });
  });
});
