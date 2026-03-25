import { describe, expect, it } from 'vitest';
import { InstructionElement } from '@sdk/models/workflow/InstructionElement';
import { InstructionElementParser, ParseError } from '@sdk/models/workflow/InstructionElementParser';
import { InstructionElementTypes } from '@sdk/models/workflow/InstructionElementTypes';

describe('InstructionElementParser', () => {
  const parser = new InstructionElementParser();

  describe('Self-closing elements', () => {
    it('should parse a single self-closing flow-do element', () => {
      const input = '<!-- <flow-do id="1" /> -->Execute this instruction';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.DO);
      expect(result[0].id).toBe('1');
      expect(result[0].content).toBe('Execute this instruction');
      expect(result[0].isSelfClosing).toBe(true);
    });

    it('should parse multiple self-closing elements in sequence', () => {
      const input = `<!-- <flow-do id="1" /> -->First instruction
<!-- <flow-do id="2" /> -->Second instruction
<!-- <flow-do id="3" /> -->Third instruction`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('1');
      expect(result[0].content).toContain('First instruction');
      expect(result[1].id).toBe('2');
      expect(result[1].content).toContain('Second instruction');
      expect(result[2].id).toBe('3');
      expect(result[2].content).toContain('Third instruction');
    });

    it('should parse self-closing flow-set element with value attribute', () => {
      const input = '<!-- <flow-set name="myVar" value="hello" /> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.SET);
      expect(result[0].name).toBe('myVar');
      expect(result[0].value).toBe('hello');
      expect(result[0].isSelfClosing).toBe(true);
    });

    it('should parse self-closing element with on-error attribute', () => {
      const input = '<!-- <flow-do id="1" on-error="skip" /> -->Might fail';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].onError).toBe('skip');
    });

    it('should handle self-closing element with no content after', () => {
      const input = '<!-- <flow-set name="x" value="1" /> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('');
    });
  });

  describe('Open/close elements', () => {
    it('should parse a simple open/close flow-do element', () => {
      const input = '<!-- <flow-do id="1"> -->Execute this<!-- </flow-do> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.DO);
      expect(result[0].id).toBe('1');
      expect(result[0].content).toBe('Execute this');
      expect(result[0].isSelfClosing).toBe(false);
    });

    it('should parse flow-if element with test attribute', () => {
      const input = '<!-- <flow-if test="$count > 0"> -->Do something<!-- </flow-if> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[0].test).toBe('$count > 0');
      expect(result[0].content).toBe('Do something');
    });

    it('should parse flow-each element with items and as attributes', () => {
      const input = '<!-- <flow-each items="$files" as="file"> -->Process $file<!-- </flow-each> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.EACH);
      expect(result[0].items).toBe('$files');
      expect(result[0].as).toBe('file');
      expect(result[0].content).toBe('Process $file');
    });

    it('should parse flow-set element with content as value', () => {
      const input = '<!-- <flow-set name="result"> -->computed value here<!-- </flow-set> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.SET);
      expect(result[0].name).toBe('result');
      expect(result[0].content).toBe('computed value here');
    });

    it('should preserve multiline content', () => {
      const input = `<!-- <flow-do id="1"> -->
Line 1
Line 2
Line 3
<!-- </flow-do> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('Line 1');
      expect(result[0].content).toContain('Line 2');
      expect(result[0].content).toContain('Line 3');
    });
  });

  describe('Nested elements', () => {
    it('should parse flow-if containing flow-do', () => {
      const input = `<!-- <flow-if test="$ready"> -->
<!-- <flow-do id="1" /> -->Execute when ready
<!-- </flow-if> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[0].hasChildren()).toBe(true);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].elementType).toBe(InstructionElementTypes.DO);
      expect(result[0].children[0].content).toContain('Execute when ready');
    });

    it('should parse flow-each containing multiple flow-do elements', () => {
      const input = `<!-- <flow-each items="$items" as="item"> -->
<!-- <flow-do id="1" /> -->Process $item
<!-- <flow-do id="2" /> -->Log $item
<!-- </flow-each> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.EACH);
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].content).toContain('Process $item');
      expect(result[0].children[1].content).toContain('Log $item');
    });

    it('should parse deeply nested structure', () => {
      const input = `<!-- <flow-if test="$enabled"> -->
<!-- <flow-each items="$list" as="x"> -->
<!-- <flow-if test="$x > 0"> -->
<!-- <flow-do id="inner" /> -->Do it
<!-- </flow-if> -->
<!-- </flow-each> -->
<!-- </flow-if> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[0].children).toHaveLength(1);

      const each = result[0].children[0];
      expect(each.elementType).toBe(InstructionElementTypes.EACH);
      expect(each.children).toHaveLength(1);

      const innerIf = each.children[0];
      expect(innerIf.elementType).toBe(InstructionElementTypes.IF);
      expect(innerIf.children).toHaveLength(1);

      const innerDo = innerIf.children[0];
      expect(innerDo.elementType).toBe(InstructionElementTypes.DO);
      expect(innerDo.content).toContain('Do it');
    });

    it('should handle sibling elements at root level', () => {
      const input = `<!-- <flow-set name="x" value="1" /> -->
<!-- <flow-if test="$x == 1"> -->
<!-- <flow-do id="a" /> -->Action A
<!-- </flow-if> -->
<!-- <flow-do id="b" /> -->Action B`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].elementType).toBe(InstructionElementTypes.SET);
      expect(result[1].elementType).toBe(InstructionElementTypes.IF);
      expect(result[2].elementType).toBe(InstructionElementTypes.DO);
    });
  });

  describe('Error handling', () => {
    it('should throw on unclosed tag', () => {
      const input = '<!-- <flow-if test="true"> -->content';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Unclosed tags/);
    });

    it('should throw on mismatched closing tag', () => {
      const input = '<!-- <flow-if test="true"> -->content<!-- </flow-each> -->';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Mismatched closing tag/);
    });

    it('should throw on unexpected closing tag', () => {
      const input = '<!-- </flow-do> -->';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Unexpected closing tag/);
    });

    it('should throw on invalid element type in InstructionElement', () => {
      expect(() => new InstructionElement('invalid')).toThrow(/Invalid instruction element type/);
    });
  });

  describe('Attribute parsing', () => {
    it('should parse multiple attributes correctly', () => {
      const input = '<!-- <flow-do id="test" on-error="stop" /> -->content';

      const result = parser.parse(input);

      expect(result[0].attributes['id']).toBe('test');
      expect(result[0].attributes['on-error']).toBe('stop');
    });

    it('should handle attributes with special characters in values', () => {
      const input = '<!-- <flow-if test="$x > 0 and $y < 10"> -->content<!-- </flow-if> -->';

      const result = parser.parse(input);

      expect(result[0].test).toBe('$x > 0 and $y < 10');
    });

    it('should handle empty attribute values', () => {
      const input = '<!-- <flow-set name="" value="" /> -->';

      const result = parser.parse(input);

      // Empty string attributes are parsed but getters return null for empty values
      expect(result[0].attributes['name']).toBe('');
      expect(result[0].attributes['value']).toBe('');
      // The convenience getters return null for empty strings (falsy)
      expect(result[0].name).toBeNull();
      expect(result[0].value).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty input', () => {
      const result = parser.parse('');
      expect(result).toHaveLength(0);
    });

    it('should handle input with no flow elements', () => {
      // Plain text without flow elements creates a markless "do" element (preamble)
      const input = 'Just plain text without any flow elements';
      const result = parser.parse(input);
      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe('do');
      expect(result[0].content).toBe(input);
      expect(result[0].markless).toBe(true);
    });

    it('should ignore regular HTML comments', () => {
      // Regular HTML comments are treated as text (not flow elements)
      // This creates a preamble element containing the comment text
      const input = '<!-- regular comment --> <!-- <flow-do id="1" /> -->real instruction';

      const result = parser.parse(input);

      // Two elements: preamble with comment text, then flow-do with content
      expect(result).toHaveLength(2);
      expect(result[0].elementType).toBe('do');
      expect(result[0].content).toBe('<!-- regular comment -->');
      expect(result[0].markless).toBe(true);
      expect(result[1].elementType).toBe('do');
      expect(result[1].content).toBe('real instruction');
    });

    it('should ignore unknown flow element types', () => {
      // Unknown flow types are ignored by the parser (no element created)
      // But text before valid elements becomes preamble
      const input = '<!-- <flow-unknown id="1" /> -->ignored <!-- <flow-do id="2" /> -->kept';

      const result = parser.parse(input);

      // Two elements: preamble with "ignored" text, then flow-do with content "kept"
      expect(result).toHaveLength(2);
      expect(result[0].elementType).toBe('do');
      expect(result[0].content).toBe('ignored');
      expect(result[0].markless).toBe(true);
      expect(result[1].id).toBe('2');
      expect(result[1].content).toBe('kept');
    });

    it('should handle whitespace variations in comments', () => {
      const input1 = '<!--<flow-do id="1"/>-->content1';
      const input2 = '<!--  <flow-do id="2" />  -->content2';
      const input3 = '<!-- \n <flow-do id="3" /> \n -->content3';

      const result1 = parser.parse(input1);
      const result2 = parser.parse(input2);
      const result3 = parser.parse(input3);

      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result3).toHaveLength(1);
    });

    it('should normalize flow- prefix in element type', () => {
      const input = '<!-- <flow-do id="1" /> -->content';

      const result = parser.parse(input);

      expect(result[0].elementType).toBe('do'); // Normalized without prefix
    });
  });

  describe('Complex real-world scenarios', () => {
    it('should parse a complete workflow with mixed elements', () => {
      const input = `# My Workflow

<!-- <flow-set name="count" value="0" /> -->

<!-- <flow-do id="init" /> -->
Initialize the system with default values

<!-- <flow-each items="$files" as="file"> -->
<!-- <flow-if test="$file.size > 0"> -->
<!-- <flow-do id="process" /> -->
Process the file: $file.name

<!-- <flow-set name="count" value="$count + 1" /> -->
<!-- </flow-if> -->
<!-- </flow-each> -->

<!-- <flow-if test="$count > 0"> -->
<!-- <flow-do id="summary" /> -->
Processed $count files successfully
<!-- </flow-if> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(4);

      // First: flow-set
      expect(result[0].elementType).toBe(InstructionElementTypes.SET);
      expect(result[0].name).toBe('count');

      // Second: flow-do init
      expect(result[1].elementType).toBe(InstructionElementTypes.DO);
      expect(result[1].id).toBe('init');

      // Third: flow-each with nested structure
      expect(result[2].elementType).toBe(InstructionElementTypes.EACH);
      expect(result[2].items).toBe('$files');
      expect(result[2].children).toHaveLength(1);
      expect(result[2].children[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[2].children[0].children).toHaveLength(2); // flow-do and flow-set

      // Fourth: flow-if with summary
      expect(result[3].elementType).toBe(InstructionElementTypes.IF);
      expect(result[3].test).toBe('$count > 0');
    });
  });

  describe('flow-call element (function-like calls)', () => {
    it('should parse a self-closing flow-call with href attribute', () => {
      const input = '<!-- <flow-call href="path/to/helper.md" /> -->Call helper function';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.CALL);
      expect(result[0].href).toBe('path/to/helper.md');
      expect(result[0].isSelfClosing).toBe(true);
      expect(result[0].content).toBe('Call helper function');
    });

    it('should parse flow-call with optional description content', () => {
      const input = `<!-- <flow-call href="skills/process.md" /> -->
Process and validate the data`;

      const result = parser.parse(input);

      expect(result[0].elementType).toBe(InstructionElementTypes.CALL);
      expect(result[0].href).toBe('skills/process.md');
      expect(result[0].content).toContain('Process and validate the data');
    });

    it('should parse multiple flow-call elements in sequence', () => {
      const input = `<!-- <flow-call href="init.md" /> -->Initialize
<!-- <flow-call href="validate.md" /> -->Validate data
<!-- <flow-call href="finalize.md" /> -->Finalize`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].href).toBe('init.md');
      expect(result[1].href).toBe('validate.md');
      expect(result[2].href).toBe('finalize.md');
    });

    it('should parse flow-call with nested instructions', () => {
      const input = `<!-- <flow-if test="$ready"> -->
<!-- <flow-call href="process.md" /> -->Process when ready
<!-- </flow-if> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].elementType).toBe(InstructionElementTypes.CALL);
      expect(result[0].children[0].href).toBe('process.md');
    });

    it('should handle href with relative paths', () => {
      const input = '<!-- <flow-call href="../parent/utils.md" /> -->Call parent utility';

      const result = parser.parse(input);

      expect(result[0].href).toBe('../parent/utils.md');
    });

    it('should handle href with absolute VFS paths', () => {
      const input = '<!-- <flow-call href="compute_node-xxx/skills/common/helpers.md" /> -->Call shared helper';

      const result = parser.parse(input);

      expect(result[0].href).toBe('compute_node-xxx/skills/common/helpers.md');
    });

    it('should work inside flow-each loop', () => {
      const input = `<!-- <flow-each items="$tasks" as="task"> -->
<!-- <flow-call href="execute_task.md" /> -->Execute task: $task
<!-- </flow-each> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.EACH);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].elementType).toBe(InstructionElementTypes.CALL);
      expect(result[0].children[0].href).toBe('execute_task.md');
    });

    it('should have href property return null when not present', () => {
      const input = '<!-- <flow-do id="1" /> -->Regular instruction';

      const result = parser.parse(input);

      expect(result[0].href).toBeNull();
    });
  });

  describe('Tag elements', () => {
    it('should parse a simple tag without value', () => {
      const input = '<!-- my-tag -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].tagName).toBe('my-tag');
      expect(result[0].tagValue).toBeNull();
      expect(result[0].isSelfClosing).toBe(true);
    });

    it('should parse a tag with value', () => {
      const input = '<!-- version: 1.0.0 -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].tagName).toBe('version');
      expect(result[0].tagValue).toBe('1.0.0');
    });

    it('should parse multiple tags in sequence', () => {
      const input = `<!-- author: John Doe -->
<!-- version: 2.3.1 -->
<!-- status -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].tagName).toBe('author');
      expect(result[0].tagValue).toBe('John Doe');
      expect(result[1].tagName).toBe('version');
      expect(result[1].tagValue).toBe('2.3.1');
      expect(result[2].tagName).toBe('status');
      expect(result[2].tagValue).toBeNull();
    });

    it('should parse tag with hyphenated name', () => {
      const input = '<!-- my-custom-tag: some value -->';

      const result = parser.parse(input);

      expect(result[0].tagName).toBe('my-custom-tag');
      expect(result[0].tagValue).toBe('some value');
    });

    it('should parse tag with underscore in name', () => {
      const input = '<!-- my_tag: value -->';

      const result = parser.parse(input);

      expect(result[0].tagName).toBe('my_tag');
      expect(result[0].tagValue).toBe('value');
    });

    it('should handle tags with extra whitespace', () => {
      const input = '<!--   tag-name  :  value with spaces   -->';

      const result = parser.parse(input);

      expect(result[0].tagName).toBe('tag-name');
      expect(result[0].tagValue).toBe('value with spaces');
    });

    it('should parse tags mixed with flow elements', () => {
      const input = `<!-- author: Jane -->
<!-- <flow-do id="1" /> -->Do something
<!-- status: active -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].tagName).toBe('author');
      expect(result[1].elementType).toBe(InstructionElementTypes.DO);
      expect(result[1].id).toBe('1');
      expect(result[2].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[2].tagName).toBe('status');
    });

    it('should not treat flow elements as tags', () => {
      const input = '<!-- <flow-do id="1" /> -->Content';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.DO);
      expect(result[0].elementType).not.toBe(InstructionElementTypes.TAG);
    });

    it('should serialize tag without value back to HTML comment', () => {
      const input = '<!-- my-tag -->';

      const result = parser.parse(input);
      const serialized = result[0].toAmdString();

      expect(serialized).toBe('<!-- my-tag -->');
    });

    it('should serialize tag with value back to HTML comment', () => {
      const input = '<!-- version: 1.0.0 -->';

      const result = parser.parse(input);
      const serialized = result[0].toAmdString();

      expect(serialized).toBe('<!-- version: 1.0.0 -->');
    });

    it('should handle roundtrip serialization for mixed tags and flow elements', () => {
      const input = `<!-- author: Test -->
<!-- <flow-do id="1" /> -->Content
<!-- status: done -->`;

      const result = parser.parse(input);
      const serialized = result.map((el) => el.toAmdString()).join('\n');

      expect(serialized).toContain('<!-- author: Test -->');
      expect(serialized).toContain('<!-- <flow-do id="1" /> -->');
      expect(serialized).toContain('<!-- status: done -->');
    });

    it('should parse tag with colon in value', () => {
      const input = '<!-- url: https://example.com:8080/path -->';

      const result = parser.parse(input);

      expect(result[0].tagName).toBe('url');
      expect(result[0].tagValue).toBe('https://example.com:8080/path');
    });

    it('should handle tag with empty value after colon', () => {
      const input = '<!-- tag: -->';

      const result = parser.parse(input);

      expect(result[0].tagName).toBe('tag');
      expect(result[0].tagValue).toBeNull();
    });

    it('should parse tags inside block elements', () => {
      const input = `<!-- <flow-if test="$x > 0"> -->
<!-- note: This runs when x is positive -->
Do something
<!-- </flow-if> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].children[0].tagName).toBe('note');
    });
  });

  describe('HTML-commented block tags', () => {
    it('should parse a simple HTML-commented block tag', () => {
      const input = '<!-- <flowpad-human> -->This is human content<!-- </flowpad-human> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].tagName).toBe('flowpad-human');
      expect(result[0].content).toBe('This is human content');
      expect(result[0].isSelfClosing).toBe(false);
      expect(result[0].attributes['block-style']).toBe('true');
    });

    it('should parse multiple HTML-commented block tags', () => {
      const input = `<!-- <flowpad-human> -->Human content 1<!-- </flowpad-human> -->
<!-- <flowpad-ai> -->AI response content<!-- </flowpad-ai> -->
<!-- <flowpad-human> -->Human content 2<!-- </flowpad-human> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].tagName).toBe('flowpad-human');
      expect(result[0].content).toBe('Human content 1');
      expect(result[1].tagName).toBe('flowpad-ai');
      expect(result[1].content).toBe('AI response content');
      expect(result[2].tagName).toBe('flowpad-human');
      expect(result[2].content).toBe('Human content 2');
    });

    it('should parse nested HTML-commented block tags', () => {
      const input = `<!-- <flowpad-conversation> -->
<!-- <flowpad-human> -->What is 2+2?<!-- </flowpad-human> -->
<!-- <flowpad-ai> -->The answer is 4<!-- </flowpad-ai> -->
<!-- </flowpad-conversation> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].tagName).toBe('flowpad-conversation');
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].tagName).toBe('flowpad-human');
      expect(result[0].children[0].content).toBe('What is 2+2?');
      expect(result[0].children[1].tagName).toBe('flowpad-ai');
      expect(result[0].children[1].content).toBe('The answer is 4');
    });

    it('should handle multiline content in HTML-commented block tags', () => {
      const input = `<!-- <flowpad-human> -->
Line 1
Line 2
Line 3
<!-- </flowpad-human> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('Line 1');
      expect(result[0].content).toContain('Line 2');
      expect(result[0].content).toContain('Line 3');
    });

    it('should handle HTML-commented block tags with hyphens and underscores', () => {
      const input1 = '<!-- <my-custom-tag> -->content<!-- </my-custom-tag> -->';
      const input2 = '<!-- <my_custom_tag> -->content<!-- </my_custom_tag> -->';

      const result1 = parser.parse(input1);
      const result2 = parser.parse(input2);

      expect(result1[0].tagName).toBe('my-custom-tag');
      expect(result2[0].tagName).toBe('my_custom_tag');
    });

    it('should handle HTML-commented block tags with whitespace variations', () => {
      const input1 = '<!--<flowpad-human>-->content<!--</flowpad-human>-->';
      const input2 = '<!--  <flowpad-human>  -->content<!--  </flowpad-human>  -->';
      const input3 = '<!-- \n <flowpad-human> \n -->content<!-- \n </flowpad-human> \n -->';

      const result1 = parser.parse(input1);
      const result2 = parser.parse(input2);
      const result3 = parser.parse(input3);

      expect(result1[0].tagName).toBe('flowpad-human');
      expect(result2[0].tagName).toBe('flowpad-human');
      expect(result3[0].tagName).toBe('flowpad-human');
    });

    it('should throw on unclosed HTML-commented block tag', () => {
      const input = '<!-- <flowpad-human> -->content';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Unclosed tags/);
    });

    it('should throw on mismatched HTML-commented block tag', () => {
      const input = '<!-- <flowpad-human> -->content<!-- </flowpad-ai> -->';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Mismatched closing tag/);
    });

    it('should throw on unexpected closing HTML-commented block tag', () => {
      const input = '<!-- </flowpad-human> -->';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Unexpected closing tag/);
    });

    it('should serialize HTML-commented block tag back correctly', () => {
      const input = '<!-- <flowpad-human> -->This is human content<!-- </flowpad-human> -->';

      const result = parser.parse(input);
      const serialized = result[0].toAmdString();

      expect(serialized).toContain('<!-- <flowpad-human> -->');
      expect(serialized).toContain('This is human content');
      expect(serialized).toContain('<!-- </flowpad-human> -->');
    });

    it('should handle roundtrip serialization for nested HTML-commented block tags', () => {
      const input = `<!-- <flowpad-conversation> -->
<!-- <flowpad-human> -->Question<!-- </flowpad-human> -->
<!-- <flowpad-ai> -->Answer<!-- </flowpad-ai> -->
<!-- </flowpad-conversation> -->`;

      const result = parser.parse(input);
      const serialized = result[0].toAmdString();

      expect(serialized).toContain('<!-- <flowpad-conversation> -->');
      expect(serialized).toContain('<!-- <flowpad-human> -->');
      expect(serialized).toContain('Question');
      expect(serialized).toContain('<!-- </flowpad-human> -->');
      expect(serialized).toContain('<!-- <flowpad-ai> -->');
      expect(serialized).toContain('Answer');
      expect(serialized).toContain('<!-- </flowpad-ai> -->');
      expect(serialized).toContain('<!-- </flowpad-conversation> -->');
    });

    it('should not confuse HTML-commented block tags with simple tags', () => {
      const input = `<!-- simple-tag -->
<!-- <block-tag> -->content<!-- </block-tag> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(2);
      expect(result[0].tagName).toBe('simple-tag');
      expect(result[0].isSelfClosing).toBe(true);
      expect(result[0].attributes['block-style']).toBeUndefined();
      expect(result[1].tagName).toBe('block-tag');
      expect(result[1].isSelfClosing).toBe(false);
      expect(result[1].attributes['block-style']).toBe('true');
    });

    it('should mix HTML-commented block tags with flow elements', () => {
      const input = `<!-- <flowpad-human> -->Request<!-- </flowpad-human> -->
<!-- <flow-do id="1" /> -->Process the request
<!-- <flowpad-ai> -->Response<!-- </flowpad-ai> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].tagName).toBe('flowpad-human');
      expect(result[1].elementType).toBe(InstructionElementTypes.DO);
      expect(result[1].id).toBe('1');
      expect(result[2].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[2].tagName).toBe('flowpad-ai');
    });

    it('should handle empty content in HTML-commented block tags', () => {
      const input = '<!-- <flowpad-human> --><!-- </flowpad-human> -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].tagName).toBe('flowpad-human');
      expect(result[0].content).toBe('');
    });

    it('should handle HTML-commented block tags inside flow elements', () => {
      const input = `<!-- <flow-if test="$enabled"> -->
<!-- <flowpad-message> -->This is enabled<!-- </flowpad-message> -->
<!-- </flow-if> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].children[0].tagName).toBe('flowpad-message');
      expect(result[0].children[0].content).toBe('This is enabled');
    });
  });

  describe('Hash-prefixed tags', () => {
    it('should parse a simple hash-prefixed tag', () => {
      const input = '<!-- #human -->This is human content<!-- /human -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].tagName).toBe('human');
      expect(result[0].content).toBe('This is human content');
      expect(result[0].isSelfClosing).toBe(false);
      expect(result[0].attributes['hash-style']).toBe('true');
    });

    it('should parse multiple hash-prefixed tags', () => {
      const input = `<!-- #human -->Human content 1<!-- /human -->
<!-- #ai -->AI response content<!-- /ai -->
<!-- #human -->Human content 2<!-- /human -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].tagName).toBe('human');
      expect(result[0].content).toBe('Human content 1');
      expect(result[1].tagName).toBe('ai');
      expect(result[1].content).toBe('AI response content');
      expect(result[2].tagName).toBe('human');
      expect(result[2].content).toBe('Human content 2');
    });

    it('should parse nested hash-prefixed tags', () => {
      const input = `<!-- #conversation -->
<!-- #human -->What is 2+2?<!-- /human -->
<!-- #ai -->The answer is 4<!-- /ai -->
<!-- /conversation -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].tagName).toBe('conversation');
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].tagName).toBe('human');
      expect(result[0].children[0].content).toBe('What is 2+2?');
      expect(result[0].children[1].tagName).toBe('ai');
      expect(result[0].children[1].content).toBe('The answer is 4');
    });

    it('should handle multiline content in hash-prefixed tags', () => {
      const input = `<!-- #human -->
Line 1
Line 2
Line 3
<!-- /human -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('Line 1');
      expect(result[0].content).toContain('Line 2');
      expect(result[0].content).toContain('Line 3');
    });

    it('should handle hash-prefixed tags with hyphens and underscores', () => {
      const input1 = '<!-- #my-custom-tag -->content<!-- /my-custom-tag -->';
      const input2 = '<!-- #my_custom_tag -->content<!-- /my_custom_tag -->';

      const result1 = parser.parse(input1);
      const result2 = parser.parse(input2);

      expect(result1[0].tagName).toBe('my-custom-tag');
      expect(result2[0].tagName).toBe('my_custom_tag');
    });

    it('should handle hash-prefixed tags with whitespace variations', () => {
      const input1 = '<!--#human-->content<!--/human-->';
      const input2 = '<!--  #human  -->content<!--  /human  -->';
      const input3 = '<!-- \n #human \n -->content<!-- \n /human \n -->';

      const result1 = parser.parse(input1);
      const result2 = parser.parse(input2);
      const result3 = parser.parse(input3);

      expect(result1[0].tagName).toBe('human');
      expect(result2[0].tagName).toBe('human');
      expect(result3[0].tagName).toBe('human');
    });

    it('should throw on unclosed hash-prefixed tag', () => {
      const input = '<!-- #human -->content';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Unclosed tags/);
    });

    it('should throw on mismatched hash-prefixed tag', () => {
      const input = '<!-- #human -->content<!-- /ai -->';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Mismatched closing tag/);
    });

    it('should throw on unexpected closing hash-prefixed tag', () => {
      const input = '<!-- /human -->';

      expect(() => parser.parse(input)).toThrow(ParseError);
      expect(() => parser.parse(input)).toThrow(/Unexpected closing tag/);
    });

    it('should serialize hash-prefixed tag back correctly', () => {
      const input = '<!-- #human -->This is human content<!-- /human -->';

      const result = parser.parse(input);
      const serialized = result[0].toAmdString();

      expect(serialized).toContain('<!-- #human -->');
      expect(serialized).toContain('This is human content');
      expect(serialized).toContain('<!-- /human -->');
    });

    it('should handle roundtrip serialization for nested hash-prefixed tags', () => {
      const input = `<!-- #conversation -->
<!-- #human -->Question<!-- /human -->
<!-- #ai -->Answer<!-- /ai -->
<!-- /conversation -->`;

      const result = parser.parse(input);
      const serialized = result[0].toAmdString();

      expect(serialized).toContain('<!-- #conversation -->');
      expect(serialized).toContain('<!-- #human -->');
      expect(serialized).toContain('Question');
      expect(serialized).toContain('<!-- /human -->');
      expect(serialized).toContain('<!-- #ai -->');
      expect(serialized).toContain('Answer');
      expect(serialized).toContain('<!-- /ai -->');
      expect(serialized).toContain('<!-- /conversation -->');
    });

    it('should not confuse hash-prefixed tags with simple tags', () => {
      const input = `<!-- simple-tag -->
<!-- #block-tag -->content<!-- /block-tag -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(2);
      expect(result[0].tagName).toBe('simple-tag');
      expect(result[0].isSelfClosing).toBe(true);
      expect(result[0].attributes['hash-style']).toBeUndefined();
      expect(result[1].tagName).toBe('block-tag');
      expect(result[1].isSelfClosing).toBe(false);
      expect(result[1].attributes['hash-style']).toBe('true');
    });

    it('should not confuse hash-prefixed tags with HTML-commented block tags', () => {
      const input = `<!-- <html-tag> -->content<!-- </html-tag> -->
<!-- #hash-tag -->content<!-- /hash-tag -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(2);
      expect(result[0].tagName).toBe('html-tag');
      expect(result[0].attributes['block-style']).toBe('true');
      expect(result[0].attributes['hash-style']).toBeUndefined();
      expect(result[1].tagName).toBe('hash-tag');
      expect(result[1].attributes['hash-style']).toBe('true');
      expect(result[1].attributes['block-style']).toBeUndefined();
    });

    it('should mix hash-prefixed tags with flow elements', () => {
      const input = `<!-- #human -->Request<!-- /human -->
<!-- <flow-do id="1" /> -->Process the request
<!-- #ai -->Response<!-- /ai -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(3);
      expect(result[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].tagName).toBe('human');
      expect(result[1].elementType).toBe(InstructionElementTypes.DO);
      expect(result[1].id).toBe('1');
      expect(result[2].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[2].tagName).toBe('ai');
    });

    it('should handle empty content in hash-prefixed tags', () => {
      const input = '<!-- #human --><!-- /human -->';

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].tagName).toBe('human');
      expect(result[0].content).toBe('');
    });

    it('should handle hash-prefixed tags inside flow elements', () => {
      const input = `<!-- <flow-if test="$enabled"> -->
<!-- #message -->This is enabled<!-- /message -->
<!-- </flow-if> -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].elementType).toBe(InstructionElementTypes.IF);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].elementType).toBe(InstructionElementTypes.TAG);
      expect(result[0].children[0].tagName).toBe('message');
      expect(result[0].children[0].content).toBe('This is enabled');
    });

    it('should handle deeply nested hash-prefixed tags', () => {
      const input = `<!-- #conversation -->
<!-- #turn -->
<!-- #human -->Question 1<!-- /human -->
<!-- #ai -->Answer 1<!-- /ai -->
<!-- /turn -->
<!-- #turn -->
<!-- #human -->Question 2<!-- /human -->
<!-- #ai -->Answer 2<!-- /ai -->
<!-- /turn -->
<!-- /conversation -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(1);
      expect(result[0].tagName).toBe('conversation');
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].tagName).toBe('turn');
      expect(result[0].children[0].children).toHaveLength(2);
      expect(result[0].children[0].children[0].tagName).toBe('human');
      expect(result[0].children[0].children[0].content).toBe('Question 1');
      expect(result[0].children[0].children[1].tagName).toBe('ai');
      expect(result[0].children[0].children[1].content).toBe('Answer 1');
      expect(result[0].children[1].tagName).toBe('turn');
      expect(result[0].children[1].children).toHaveLength(2);
      expect(result[0].children[1].children[0].tagName).toBe('human');
      expect(result[0].children[1].children[0].content).toBe('Question 2');
      expect(result[0].children[1].children[1].tagName).toBe('ai');
      expect(result[0].children[1].children[1].content).toBe('Answer 2');
    });

    it('should handle mixed tag styles in same document', () => {
      const input = `<!-- simple-tag -->
<!-- <html-tag> -->content 1<!-- </html-tag> -->
<!-- #hash-tag -->content 2<!-- /hash-tag -->
<!-- another-simple: value -->`;

      const result = parser.parse(input);

      expect(result).toHaveLength(4);
      expect(result[0].tagName).toBe('simple-tag');
      expect(result[0].isSelfClosing).toBe(true);
      expect(result[1].tagName).toBe('html-tag');
      expect(result[1].attributes['block-style']).toBe('true');
      expect(result[2].tagName).toBe('hash-tag');
      expect(result[2].attributes['hash-style']).toBe('true');
      expect(result[3].tagName).toBe('another-simple');
      expect(result[3].tagValue).toBe('value');
    });
  });
});
