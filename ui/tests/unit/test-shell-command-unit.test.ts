import { FlowElementTypes, ShellInputFlowData, ShellOutputFlowData } from '@sdk';
import { describe, expect, it } from 'vitest';

describe('Shell Command FlowData Types - Unit Tests', () => {
  it('should create valid ShellInputFlowData with default session', () => {
    // Test FlowData type creation without compute node
    const input = new ShellInputFlowData('echo "test"');

    // Validate default values
    expect(input.sessionId).toBe('flowShell'); // Default session ID
    expect(input.id).toBeTruthy(); // Auto-generated 10-char ID
    expect(input.id.length).toBe(10);
    expect(input.command).toBe('echo "test"');
    expect(input.elementType).toBe(FlowElementTypes.SHELL_INPUT);
    expect(input.attributes['data-type']).toBe('string');
  });

  it('should create valid ShellOutputFlowData with all parameters', () => {
    // Test FlowData type creation
    const output = new ShellOutputFlowData('test stdout', 'test stderr', 42);

    // Validate all properties
    expect(output.stdout).toBe('test stdout');
    expect(output.stderr).toBe('test stderr');
    expect(output.exitCode).toBe(42);
    expect(output.isComplete).toBe(true);
    expect(output.elementType).toBe(FlowElementTypes.SHELL_OUTPUT);
    expect(output.attributes['exit-code']).toBe('42');
  });

  it('should handle ShellInputFlowData with custom session ID', () => {
    const customSessionId = 'my-custom-session';

    const input = new ShellInputFlowData('ls -la', customSessionId);

    expect(input.sessionId).toBe(customSessionId);
    expect(input.id).toBeTruthy(); // Auto-generated ID
    expect(input.command).toBe('ls -la');
    expect(input.attributes['session-id']).toBe(customSessionId);
  });

  it('should support appending output to ShellOutputFlowData', () => {
    const output = new ShellOutputFlowData();

    // Initially empty
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
    expect(output.isComplete).toBe(false);

    // Append stdout
    output.appendStdout('Line 1\n');
    expect(output.stdout).toBe('Line 1\n');

    output.appendStdout('Line 2\n');
    expect(output.stdout).toBe('Line 1\nLine 2\n');

    // Append stderr
    output.appendStderr('Error 1\n');
    expect(output.stderr).toBe('Error 1\n');

    // Mark complete
    output.markComplete(0);
    expect(output.isComplete).toBe(true);
    expect(output.exitCode).toBe(0);
    expect(output.attributes['exit-code']).toBe('0');
  });

  it('should create ShellOutputFlowData from response data', () => {
    const responseData = {
      exit_code: 0,
      stdout: 'Hello World\n',
      stderr: '',
    };

    const output = ShellOutputFlowData.fromResponse(responseData);

    expect(output.stdout).toBe('Hello World\n');
    expect(output.stderr).toBe('');
    expect(output.exitCode).toBe(0);
    expect(output.isComplete).toBe(true);
  });

  it('should validate FlowData inheritance and properties', () => {
    const input = new ShellInputFlowData('echo test', 'test-session');
    const output = new ShellOutputFlowData('output', '', 0);

    // Both should have base FlowData properties
    expect(input.elementType).toBeTruthy();
    expect(output.elementType).toBeTruthy();

    expect(input.attributes).toBeTruthy();
    expect(output.attributes).toBeTruthy();

    expect(input.data).toBeTruthy();
    expect(output.data).toBeTruthy();

    // Input should have auto-generated ID
    expect(input.id).toBeTruthy();
    expect(input.id.length).toBe(10);

    // Verify data types match expectations
    expect(input.attributes['data-type']).toBe('string');
    expect(output.attributes['data-type']).toBe('object');

    // Verify element types are correct
    expect(input.attributes['element-type']).toBe('shell-input');
    expect(output.attributes['element-type']).toBe('shell-output');
  });
});
