/**
 * AMD Parser Tests - Design tests for parser interface agreement.
 *
 * These tests define the expected behavior of the AMD (Annotated Markdown) parser.
 * Ported from Python tests in flowpad/hub/tests/unit/test_amd_parser.py
 */

import { describe, expect, it } from 'vitest';
import { InstructionFile } from '@sdk/models/workflow/InstructionFile';
import { InstructionElement } from '@sdk/models/workflow/InstructionElement';

// ============================================================
// HELPER: Round-trip Serialization Validation
// ============================================================

/**
 * Recursively assert two elements are semantically equal.
 * For markless elements, auto-generated IDs are not compared.
 */
function assertElementsEqual(el1: InstructionElement, el2: InstructionElement, path: string = 'root'): void {
  expect(el1.elementType).toBe(el2.elementType);
  expect(el1.content).toBe(el2.content);

  // For markless elements, compare attributes excluding auto-generated id
  if (el1.markless && el2.markless) {
    const attrs1 = { ...el1.attributes };
    const attrs2 = { ...el2.attributes };
    delete attrs1['id'];
    delete attrs2['id'];
    expect(attrs1).toEqual(attrs2);
  } else {
    expect(el1.attributes).toEqual(el2.attributes);
  }

  expect(el1.title).toBe(el2.title);
  expect(el1.markless).toBe(el2.markless);
  expect(el1.isSelfClosing).toBe(el2.isSelfClosing);
  expect(el1.children.length).toBe(el2.children.length);

  for (let i = 0; i < el1.children.length; i++) {
    assertElementsEqual(el1.children[i], el2.children[i], `${path}.children[${i}]`);
  }
}

/**
 * Assert that serializing and re-parsing produces semantically equivalent structure.
 *
 * 1. Serialize the file to string
 * 2. Parse the serialized string
 * 3. Compare element structures recursively
 */
function assertRoundtrip(file: InstructionFile): void {
  const serialized = file.toAmdString();
  const reparsed = InstructionFile.fromContent(serialized);

  // Compare metadata
  expect(file.metadata).toEqual(reparsed.metadata);

  // Compare element count
  expect(file.elements.length).toBe(reparsed.elements.length);

  // Compare each element recursively
  for (let i = 0; i < file.elements.length; i++) {
    assertElementsEqual(file.elements[i], reparsed.elements[i], `elements[${i}]`);
  }
}

// ============================================================
// SCENARIO 1: Pure Markdown (no flow elements)
// ============================================================

describe('AMD Parser - Scenario 1: Pure Markdown', () => {
  it('should parse pure markdown multiple lines as separate instructions', () => {
    const content = `First line is instruction one.
Second line is instruction two.
Third line is instruction three.`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(3);
    expect(file.elements[0].content).toContain('First line');
    expect(file.elements[1].content).toContain('Second line');
    expect(file.elements[2].content).toContain('Third line');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should parse YAML frontmatter into metadata', () => {
    const content = `---
title: My Document
author: Test
version: 1.0
---

This is the actual content after frontmatter.

Second paragraph here.`;

    const file = InstructionFile.fromContent(content);

    // Frontmatter should be stripped from content
    expect(file.length).toBe(2);
    expect(file.elements[0].content).toContain('actual content');
    expect(file.elements[0].content).not.toContain('title:');

    // Frontmatter should be available in metadata
    expect(file.metadata).toBeDefined();
    expect(file.metadata['title']).toBe('My Document');
    expect(file.metadata['author']).toBe('Test');
    expect(file.metadata['version']).toBe(1.0);

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should convert markdown headers to element titles', () => {
    const content = `# Main Title

First real paragraph.

## Section Header

Second real paragraph.`;

    const file = InstructionFile.fromContent(content);

    // Should have 2 elements (paragraphs)
    expect(file.length).toBe(2);

    // First element should have "Main Title" as its title
    expect(file.elements[0].title).toBe('Main Title');
    expect(file.elements[0].content).toContain('First real paragraph');

    // Second element should have "Section Header" as its title
    expect(file.elements[1].title).toBe('Section Header');
    expect(file.elements[1].content).toContain('Second real paragraph');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });
});

// ============================================================
// SCENARIO 2: Interleaved Elements and Text
// ============================================================

describe('AMD Parser - Scenario 2: Interleaved Elements and Text', () => {
  it('should capture text before first element', () => {
    const content = `This text comes before any flow element.
It should be captured.

<!-- <flow-do id="task1" /> -->
This is task1 content.`;

    const file = InstructionFile.fromContent(content);

    // First element should be text type with preamble
    expect(file.length).toBeGreaterThanOrEqual(2);
    expect(file.elements[0].content).toContain('before any flow element');
    expect(file.elements[1].id).toBe('task1');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should handle mixed self-closing, block, and unmarked text', () => {
    const content = `Unmarked preamble text.

<!-- <flow-do id="task1" /> -->
Content for self-closing task1.

<!-- <flow-if test="$condition"> -->
Content inside the if block.

<!-- <flow-do id="inner" /> -->
Content for inner task.
<!-- </flow-if> -->

More unmarked text after the block.

<!-- <flow-set name="x" value="1" /> -->

<!-- <flow-do id="task2" /> -->
Content for task2.

Final unmarked text.`;

    const file = InstructionFile.fromContent(content);

    // Should parse all elements correctly
    const elementTypes = file.elements.map((el) => el.elementType);

    // Verify we have: text/do, do, if (with children), text/do, set, do, text/do
    expect(elementTypes).toContain('do');
    expect(elementTypes).toContain('if');
    expect(elementTypes).toContain('set');

    // Find the if block and verify it has children
    const ifBlock = file.elements.find((el) => el.elementType === 'if');
    expect(ifBlock).toBeDefined();
    expect(ifBlock!.hasChildren()).toBe(true);
    expect(ifBlock!.content).toContain('Content inside the if block');

    // Find inner task inside the if block
    const innerTask = ifBlock!.children[0];
    expect(innerTask.id).toBe('inner');
    expect(innerTask.content).toContain('Content for inner task');

    // Find task1 (self-closing)
    const task1 = file.elements.find((el) => el.elementType === 'do' && el.id === 'task1');
    expect(task1).toBeDefined();
    expect(task1!.content).toContain('Content for self-closing task1');

    // Find task2 (self-closing)
    const task2 = file.elements.find((el) => el.elementType === 'do' && el.id === 'task2');
    expect(task2).toBeDefined();
    expect(task2!.content).toContain('Content for task2');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should capture text inside block element', () => {
    const content = `<!-- <flow-if test="$condition"> -->
This text is inside the if block.
It belongs to the block content.
<!-- </flow-if> -->`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(1);
    expect(file.elements[0].elementType).toBe('if');
    expect(file.elements[0].content).toContain('inside the if block');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should handle interleaved elements and text', () => {
    const content = `Preamble text.

<!-- <flow-set name="x" value="1" /> -->

<!-- <flow-do id="first" /> -->
First task content.

Some unmarked text between elements.

<!-- <flow-do id="second" /> -->
Second task content.

<!-- <flow-ui uri="ui://test" /> -->`;

    const file = InstructionFile.fromContent(content);

    // Should have: text, set, do, text, do, ui
    const elementTypes = file.elements.map((el) => el.elementType);
    expect(elementTypes).toContain('set');
    expect(elementTypes).toContain('do');
    expect(elementTypes).toContain('ui');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should handle unmarked text between siblings', () => {
    const content = `<!-- <flow-do id="task1" /> -->
Task 1 content.

Unmarked content between tasks.

<!-- <flow-do id="task2" /> -->
Task 2 content.`;

    const file = InstructionFile.fromContent(content);

    // The unmarked content should be associated with task1 or be a separate text element
    const contents = file.elements.map((el) => el.content);
    const fullContent = contents.join(' ');
    expect(fullContent).toContain('Unmarked content');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });
});

// ============================================================
// SCENARIO 3: Nested Blocks
// ============================================================

describe('AMD Parser - Scenario 3: Nested Blocks', () => {
  it('should parse nested block with content', () => {
    const content = `<!-- <flow-if test="$flag"> -->
This is block-level content.

<!-- <flow-do id="inner-task" /> -->
Inner task content.

More block-level content after the inner element.
<!-- </flow-if> -->`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(1);
    const ifBlock = file.elements[0];
    expect(ifBlock.elementType).toBe('if');
    expect(ifBlock.hasChildren()).toBe(true);

    // Block should have content
    expect(ifBlock.content).toContain('block-level content');

    // Block should have child element
    expect(ifBlock.children.length).toBeGreaterThanOrEqual(1);
    const inner = ifBlock.children[0];
    expect(inner.elementType).toBe('do');
    expect(inner.id).toBe('inner-task');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should parse deeply nested blocks', () => {
    const content = `<!-- <flow-if test="$outer"> -->
Outer block content.

<!-- <flow-each items="$list" as="item"> -->
Each block content.

<!-- <flow-if test="$item.valid"> -->
Inner if content.

<!-- <flow-do id="deep-task" /> -->
Deep task content.
<!-- </flow-if> -->

<!-- </flow-each> -->

<!-- </flow-if> -->`;

    const file = InstructionFile.fromContent(content);

    // Root level
    expect(file.length).toBe(1);
    const outerIf = file.elements[0];
    expect(outerIf.elementType).toBe('if');
    expect(outerIf.test).toBe('$outer');

    // Second level - each
    const eachBlock = outerIf.children[0];
    expect(eachBlock.elementType).toBe('each');
    expect(eachBlock.items).toBe('$list');

    // Third level - inner if
    const innerIf = eachBlock.children[0];
    expect(innerIf.elementType).toBe('if');
    expect(innerIf.test).toBe('$item.valid');

    // Fourth level - do
    const deepTask = innerIf.children[0];
    expect(deepTask.elementType).toBe('do');
    expect(deepTask.id).toBe('deep-task');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should parse block with multiple children', () => {
    const content = `<!-- <flow-block agentic="false"> -->
Block preamble.

<!-- <flow-set name="a" value="1" /> -->
<!-- <flow-set name="b" value="2" /> -->
<!-- <flow-ui uri="ui://loading" non-blocking="true" /> -->
<!-- <flow-do /> -->This should be skipped in non-agentic

<!-- </flow-block> -->`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(1);
    const block = file.elements[0];
    expect(block.elementType).toBe('block');
    expect(block.agentic).toBe(false);

    // Should have 4 children: set, set, ui, do
    expect(block.children.length).toBe(4);
    const childTypes = block.children.map((c) => c.elementType);
    expect(childTypes).toEqual(['set', 'set', 'ui', 'do']);

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should parse sibling blocks', () => {
    const content = `<!-- <flow-if test="$a"> -->
Block A content.
<!-- <flow-do id="a-task" /> -->
<!-- </flow-if> -->

<!-- <flow-if test="$b"> -->
Block B content.
<!-- <flow-do id="b-task" /> -->
<!-- </flow-if> -->

<!-- <flow-each items="$items" as="x"> -->
<!-- <flow-do id="loop-task" /> -->
<!-- </flow-each> -->`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(3);
    expect(file.elements[0].elementType).toBe('if');
    expect(file.elements[0].test).toBe('$a');
    expect(file.elements[1].elementType).toBe('if');
    expect(file.elements[1].test).toBe('$b');
    expect(file.elements[2].elementType).toBe('each');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should distinguish between block content and child content', () => {
    const content = `<!-- <flow-if test="$show"> -->
This text belongs to the IF block itself.

<!-- <flow-do id="child" /> -->
This text belongs to the DO child element.

Back to IF block content.
<!-- </flow-if> -->`;

    const file = InstructionFile.fromContent(content);

    const ifBlock = file.elements[0];
    const doChild = ifBlock.children[0];

    // IF block should have its own content
    expect(ifBlock.content).toContain('belongs to the IF block');

    // DO child should have its own content
    expect(doChild.content).toContain('belongs to the DO child');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });
});

// ============================================================
// SCENARIO 4: Agentic and Non-Agentic Blocks
// ============================================================

describe('AMD Parser - Scenario 4: Agentic and Non-Agentic Blocks', () => {
  it('should parse non-agentic block with UI elements', () => {
    const content = `<!-- <flow-block agentic="false"> -->
Block for UI operations only.

<!-- <flow-ui uri="ui://form1" /> -->
<!-- <flow-ui uri="ui://form2" /> -->
<!-- <flow-ui uri="ui://form3" /> -->
<!-- <flow-ui uri="ui://form4" /> -->

<!-- </flow-block> -->`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(1);
    const block = file.elements[0];
    expect(block.elementType).toBe('block');
    expect(block.agentic).toBe(false);

    // Should have 4 UI children
    expect(block.children.length).toBe(4);
    for (const child of block.children) {
      expect(child.elementType).toBe('ui');
    }

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should parse agentic block with DO elements', () => {
    const content = `<!-- <flow-block agentic="true"> -->
Block for agentic operations.

<!-- <flow-do id="task1" /> -->
First task content.

<!-- <flow-do id="task2" /> -->
Second task content.

<!-- <flow-do id="task3" /> -->
Third task content.

<!-- </flow-block> -->`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(1);
    const block = file.elements[0];
    expect(block.elementType).toBe('block');
    expect(block.agentic).toBe(true);

    // Should have 3 DO children
    expect(block.children.length).toBe(3);
    for (const child of block.children) {
      expect(child.elementType).toBe('do');
    }

    // Verify IDs
    expect(block.children[0].id).toBe('task1');
    expect(block.children[1].id).toBe('task2');
    expect(block.children[2].id).toBe('task3');

    // Validate round-trip serialization
    assertRoundtrip(file);
  });

  it('should default agentic to true when attribute is missing', () => {
    const content = `<!-- <flow-block> -->
Block without explicit agentic attribute.
<!-- <flow-do id="task" /> -->
<!-- </flow-block> -->`;

    const file = InstructionFile.fromContent(content);

    expect(file.length).toBe(1);
    const block = file.elements[0];
    expect(block.agentic).toBe(true);
  });

  it('should recognize various false values for agentic', () => {
    const testCases = [
      { attr: 'agentic="false"', expected: false },
      { attr: 'agentic="0"', expected: false },
      { attr: 'agentic="no"', expected: false },
      { attr: 'agentic="true"', expected: true },
      { attr: 'agentic="1"', expected: true },
      { attr: 'agentic="yes"', expected: true },
    ];

    for (const { attr, expected } of testCases) {
      const content = `<!-- <flow-block ${attr}> -->
Content
<!-- </flow-block> -->`;

      const file = InstructionFile.fromContent(content);
      expect(file.elements[0].agentic).toBe(expected);
    }
  });
});

// ============================================================
// Additional Tests: New Features
// ============================================================

describe('AMD Parser - New Features', () => {
  describe('title property', () => {
    it('should assign title from markdown header to following element', () => {
      const content = `# My Title

<!-- <flow-do id="task" /> -->
Task content`;

      const file = InstructionFile.fromContent(content);

      // The do element should have the title
      const doElement = file.elements.find((el) => el.id === 'task');
      expect(doElement).toBeDefined();
      expect(doElement!.title).toBe('My Title');
    });

    it('should handle title on markless elements', () => {
      const content = `# Introduction

This is unmarked content that follows a header.`;

      const file = InstructionFile.fromContent(content);

      expect(file.length).toBe(1);
      expect(file.elements[0].title).toBe('Introduction');
      expect(file.elements[0].markless).toBe(true);
    });
  });

  describe('markless property', () => {
    it('should set markless=true for implicit DO elements', () => {
      const content = `This is unmarked preamble text.

<!-- <flow-do id="explicit" /> -->
Explicit task content`;

      const file = InstructionFile.fromContent(content);

      // Preamble should be markless
      const preamble = file.elements[0];
      expect(preamble.markless).toBe(true);
      expect(preamble.elementType).toBe('do');

      // Explicit element should not be markless
      const explicit = file.elements.find((el) => el.id === 'explicit');
      expect(explicit).toBeDefined();
      expect(explicit!.markless).toBe(false);
    });
  });

  describe('toAmdString serialization', () => {
    it('should serialize element with attributes', () => {
      const content = `<!-- <flow-do id="task1" on-error="skip" /> -->
Task content`;

      const file = InstructionFile.fromContent(content);
      const serialized = file.toAmdString();

      expect(serialized).toContain('flow-do');
      expect(serialized).toContain('id="task1"');
      expect(serialized).toContain('on-error="skip"');
      expect(serialized).toContain('Task content');
    });

    it('should serialize block elements with children', () => {
      const content = `<!-- <flow-if test="$flag"> -->
Block content
<!-- <flow-do id="inner" /> -->
Inner content
<!-- </flow-if> -->`;

      const file = InstructionFile.fromContent(content);
      const serialized = file.toAmdString();

      expect(serialized).toContain('flow-if');
      expect(serialized).toContain('test="$flag"');
      expect(serialized).toContain('</flow-if>');
      expect(serialized).toContain('flow-do');
    });

    it('should serialize metadata as YAML frontmatter', () => {
      const content = `---
title: Test Document
version: 2.0
---

Content here.`;

      const file = InstructionFile.fromContent(content);
      const serialized = file.toAmdString();

      expect(serialized).toContain('---');
      expect(serialized).toContain('title: Test Document');
      expect(serialized).toContain('version: 2');
    });

    it('should serialize titles as markdown headers', () => {
      const content = `# Section Title

Content with title.`;

      const file = InstructionFile.fromContent(content);
      const serialized = file.toAmdString();

      expect(serialized).toContain('# Section Title');
      expect(serialized).toContain('Content with title');
    });
  });

  describe('iterator support', () => {
    it('should iterate over instruction elements excluding header', () => {
      const content = `<!-- <flow-header version="1.0" /> -->
<!-- <flow-do id="task1" /> -->First
<!-- <flow-do id="task2" /> -->Second`;

      const file = InstructionFile.fromContent(content);

      const elements = [...file];

      // Should iterate over instruction elements only (header is excluded from _elements)
      expect(elements.length).toBe(2);
      expect(elements[0].id).toBe('task1');
      expect(elements[1].id).toBe('task2');
      // Verify header is detected but not in elements
      expect(file.compiled).toBe(true);
    });

    it('should support for-of loop', () => {
      const content = `<!-- <flow-do id="a" /> -->A
<!-- <flow-do id="b" /> -->B
<!-- <flow-do id="c" /> -->C`;

      const file = InstructionFile.fromContent(content);

      const ids: string[] = [];
      for (const el of file) {
        if (el.id) {
          ids.push(el.id);
        }
      }

      expect(ids).toEqual(['a', 'b', 'c']);
    });
  });

  describe('length property', () => {
    it('should return count of instruction elements excluding header', () => {
      const content = `<!-- <flow-header version="1.0" /> -->
<!-- <flow-do id="task1" /> -->First
<!-- <flow-do id="task2" /> -->Second
<!-- <flow-do id="task3" /> -->Third`;

      const file = InstructionFile.fromContent(content);

      expect(file.length).toBe(3);
    });
  });

  describe('BLOCK and TEXT element types', () => {
    it('should parse flow-block elements', () => {
      const content = `<!-- <flow-block id="my-block"> -->
Block content here
<!-- </flow-block> -->`;

      const file = InstructionFile.fromContent(content);

      expect(file.length).toBe(1);
      expect(file.elements[0].elementType).toBe('block');
      expect(file.elements[0].id).toBe('my-block');
    });
  });
});
