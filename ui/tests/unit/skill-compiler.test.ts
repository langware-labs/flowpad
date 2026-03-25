import { beforeEach, describe, expect, it } from 'vitest';
import { LineBreakCompiler } from '@sdk/models/workflow/compilers/LineBreakCompiler';
import { SkillCompiler } from '@sdk/models/workflow/compilers/SkillCompiler';
import { InstructionFile } from '@sdk/models/workflow/InstructionFile';

describe('SkillCompiler', () => {
  // Reset ID counter before each test to ensure predictable IDs
  beforeEach(() => {
    SkillCompiler.resetIdCounter(500);
  });

  describe('getId()', () => {
    it('should start at 500 and increment', () => {
      expect(SkillCompiler.getIdCounter()).toBe(500);

      const compiler = new LineBreakCompiler();
      const file = InstructionFile.fromContent('A\nB\nC');
      compiler.compile(file);

      // After 3 instructions, counter should be 503
      expect(SkillCompiler.getIdCounter()).toBe(503);
    });

    it('should generate base64 encoded IDs', () => {
      const compiler = new LineBreakCompiler();
      const file = InstructionFile.fromContent('Test');
      const compiled = compiler.compile(file);

      // 500 in base64: AfQ (500 = 0x01F4)
      expect(compiled.content).toContain('id="AfQ"');
    });

    it('should generate sequential unique IDs across multiple compiles', () => {
      const compiler = new LineBreakCompiler();

      const file1 = InstructionFile.fromContent('First');
      compiler.compile(file1); // Uses ID 500

      const file2 = InstructionFile.fromContent('Second');
      const compiled2 = compiler.compile(file2); // Uses ID 501

      // 501 in base64: AfU (501 = 0x01F5)
      expect(compiled2.content).toContain('id="AfU"');
    });

    it('should reset counter with resetIdCounter', () => {
      SkillCompiler.resetIdCounter(1000);
      expect(SkillCompiler.getIdCounter()).toBe(1000);

      const compiler = new LineBreakCompiler();
      const file = InstructionFile.fromContent('Test');
      const compiled = compiler.compile(file);

      // 1000 in base64: A-g (1000 = 0x03E8)
      expect(compiled.content).toContain('id="A-g"');
    });
  });

  describe('LineBreakCompiler', () => {
    it('should be an instance of SkillCompiler', () => {
      const compiler = new LineBreakCompiler();
      expect(compiler).toBeInstanceOf(SkillCompiler);
    });

    it('should compile single line into flow-do', () => {
      const content = 'Say hello';
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      expect(compiled.compiled).toBe(true);
      expect(compiled.content).toContain('flow-header');
      expect(compiled.content).toMatch(/<!-- <flow-do id="[A-Za-z0-9_-]+" \/> -->Say hello/);
    });

    it('should compile multiple lines into multiple flow-do elements', () => {
      const content = `First instruction
Second instruction
Third instruction`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      expect(compiled.elements).toHaveLength(3);
      expect(compiled.content).toContain('First instruction');
      expect(compiled.content).toContain('Second instruction');
      expect(compiled.content).toContain('Third instruction');
      // Verify each has a flow-do with some ID
      expect((compiled.content.match(/<!-- <flow-do id="[^"]+" \/> -->/g) || []).length).toBe(3);
    });

    it('should skip empty lines by default', () => {
      const content = `Line 1

Line 2

Line 3`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      expect(compiled.elements).toHaveLength(3);
    });

    it('should include empty lines when skipEmptyLines is false', () => {
      const content = `Line 1

Line 2`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler({ skipEmptyLines: false });

      const compiled = compiler.compile(file);

      // Line 1, empty line, Line 2
      expect(compiled.elements).toHaveLength(3);
    });

    it('should trim lines by default', () => {
      const content = `  Line with spaces
	Line with tabs	`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      expect(compiled.content).toContain('-->Line with spaces');
      expect(compiled.content).toContain('-->Line with tabs');
    });

    it('should preserve whitespace when trimLines is false', () => {
      const content = `  Line with spaces  `;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler({ trimLines: false });

      const compiled = compiler.compile(file);

      expect(compiled.content).toContain('-->  Line with spaces  ');
    });

    it('should skip markdown headers when skipHeaders is true', () => {
      const content = `# Header
First instruction
## Subheader
Second instruction`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler({ skipHeaders: true });

      const compiled = compiler.compile(file);

      expect(compiled.elements).toHaveLength(2);
      expect(compiled.content).not.toContain('# Header');
      expect(compiled.content).not.toContain('## Subheader');
      expect(compiled.content).toContain('First instruction');
      expect(compiled.content).toContain('Second instruction');
    });

    it('should include headers by default', () => {
      const content = `# Header
Instruction`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      expect(compiled.elements).toHaveLength(2);
      expect(compiled.content).toContain('# Header');
    });

    it('should add flow-header with version', () => {
      const content = 'Test';
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler({ version: '2.0' });

      const compiled = compiler.compile(file);

      expect(compiled.content).toContain('version="2.0"');
    });

    it('should add compiled-at timestamp in ISO format', () => {
      const content = 'Test';
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      // Match ISO timestamp pattern
      expect(compiled.content).toMatch(/compiled-at="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should not recompile already compiled files', () => {
      const content = `<!-- <flow-header version="1.0" compiled-at="2024-01-01T00:00:00Z" /> -->
<!-- <flow-do id="1" /> -->Existing instruction`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      // Should return as-is, not double-compile
      expect(compiled.content).toBe(content);
    });

    it('should produce parseable flow elements', () => {
      const content = `Do this
Then do that
Finally do this`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      // Elements should be properly parsed
      expect(compiled.elements).toHaveLength(3);
      expect(compiled.elements[0].elementType).toBe('do');
      expect(compiled.elements[0].id).toBe('AfQ'); // 500 in base64
      expect(compiled.elements[0].content).toContain('Do this');
    });

    it('should assign unique base64 ids to each instruction', () => {
      const content = `A
B
C
D
E`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      // 500-504 in base64: AfQ, AfU, AfY, Afc, Afg
      expect(compiled.elements[0].id).toBe('AfQ');
      expect(compiled.elements[1].id).toBe('AfU');
      expect(compiled.elements[2].id).toBe('AfY');
      expect(compiled.elements[3].id).toBe('Afc');
      expect(compiled.elements[4].id).toBe('Afg');
    });

    it('should handle special characters in content', () => {
      const content = `Check if x > 0 and y < 10
Use "quotes" and 'apostrophes'`;
      const file = InstructionFile.fromContent(content);
      const compiler = new LineBreakCompiler();

      const compiled = compiler.compile(file);

      expect(compiled.elements).toHaveLength(2);
      expect(compiled.elements[0].content).toContain('x > 0');
      expect(compiled.elements[1].content).toContain('"quotes"');
    });
  });
});
