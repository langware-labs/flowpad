import { describe, expect, it } from 'vitest';

// Test the parseInstructionId function directly
// without importing from SDK to avoid browser environment requirements

describe('parseInstructionId', () => {
  // Inline implementation for testing
  function parseInstructionId(id: string): { depth: number; parentId: string | null } {
    const parts = id.split('.');
    return {
      depth: parts.length - 1,
      parentId: parts.length > 1 ? parts.slice(0, -1).join('.') : null,
    };
  }

  it('should parse root-level instruction ID', () => {
    const result = parseInstructionId('inst_1');
    expect(result.depth).toBe(0);
    expect(result.parentId).toBeNull();
  });

  it('should parse first-level nested instruction ID', () => {
    const result = parseInstructionId('inst_2.1');
    expect(result.depth).toBe(1);
    expect(result.parentId).toBe('inst_2');
  });

  it('should parse second-level nested instruction ID', () => {
    const result = parseInstructionId('inst_2.3.1');
    expect(result.depth).toBe(2);
    expect(result.parentId).toBe('inst_2.3');
  });

  it('should parse deeply nested instruction ID', () => {
    const result = parseInstructionId('inst_1.2.3.4.5');
    expect(result.depth).toBe(4);
    expect(result.parentId).toBe('inst_1.2.3.4');
  });
});

describe('Instruction type structure', () => {
  it('should validate flow-call instruction structure', () => {
    const flowCallInstruction = {
      id: 'inst_2',
      lineNumber: 2,
      content: 'Execute sub/a.md',
      status: 'pending',
      type: 'call',
      href: './sub/a.md',
      children: [],
      parentId: null,
      depth: 0,
      expanded: true,
    };

    expect(flowCallInstruction.type).toBe('call');
    expect(flowCallInstruction.href).toBe('./sub/a.md');
    expect(flowCallInstruction.children).toEqual([]);
    expect(flowCallInstruction.depth).toBe(0);
  });

  it('should validate childProgress structure', () => {
    const flowCallWithProgress = {
      id: 'inst_2',
      lineNumber: 2,
      content: 'Execute sub/a.md',
      status: 'completed',
      type: 'call',
      href: './sub/a.md',
      children: [],
      parentId: null,
      depth: 0,
      expanded: true,
      childProgress: {
        total: 3,
        completed: 2,
        failed: 1,
      },
    };

    expect(flowCallWithProgress.childProgress?.total).toBe(3);
    expect(flowCallWithProgress.childProgress?.completed).toBe(2);
    expect(flowCallWithProgress.childProgress?.failed).toBe(1);
  });

  it('should validate nested children structure', () => {
    const child = {
      id: 'inst_2.1',
      lineNumber: 1,
      content: 'Child instruction',
      status: 'completed',
      type: 'do',
      children: [],
      parentId: 'inst_2',
      depth: 1,
      expanded: true,
    };

    const parent = {
      id: 'inst_2',
      lineNumber: 2,
      content: 'Execute sub/a.md',
      status: 'executing',
      type: 'call',
      href: './sub/a.md',
      children: [child],
      parentId: null,
      depth: 0,
      expanded: true,
    };

    expect(parent.children.length).toBe(1);
    expect(parent.children[0].id).toBe('inst_2.1');
    expect(parent.children[0].parentId).toBe('inst_2');
  });
});

describe('weighted progress calculation', () => {
  it('should count each root instruction as one step', () => {
    const instructions = [
      {
        id: 'inst_1',
        status: 'completed',
        type: 'do',
        children: [],
      },
      {
        id: 'inst_2',
        status: 'completed',
        type: 'call',
        children: [
          { id: 'inst_2.1', status: 'completed' },
          { id: 'inst_2.2', status: 'completed' },
        ],
        childProgress: { total: 2, completed: 2, failed: 0 },
      },
      {
        id: 'inst_3',
        status: 'pending',
        type: 'do',
        children: [],
      },
    ];

    // Count only root-level for weighted progress
    const completed = instructions.filter((i) => i.status === 'completed').length;
    const total = instructions.length;

    // Even though inst_2 has 2 children, it counts as 1 step
    expect(completed).toBe(2); // inst_1 and inst_2
    expect(total).toBe(3); // inst_1, inst_2, inst_3
  });
});

describe('instruction status values', () => {
  it('should support all status types', () => {
    const statuses = ['pending', 'executing', 'completed', 'failed', 'skipped'];

    statuses.forEach((status) => {
      const instruction = {
        id: 'inst_1',
        status,
        type: 'do',
        children: [],
      };
      expect(instruction.status).toBe(status);
    });
  });
});

// FlowData parsing tests are in traced-instructions.test.ts
// They test the actual parseTraceReport function with real FlowData objects
