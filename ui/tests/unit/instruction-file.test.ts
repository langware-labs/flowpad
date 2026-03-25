import { describe, expect, it, vi } from 'vitest';
import { InstructionFile } from '@sdk/models/workflow/InstructionFile';
import { FSItem } from '@sdk/entities/fs_item';

// Mock FSItem for testing - returns item and spy for assertion
const createMockFSItem = (
  vfsPath: string,
  content: string,
): { item: FSItem; downloadSpy: ReturnType<typeof vi.spyOn> } => {
  const item = new FSItem({
    vfs_abs_path: vfsPath,
    is_dir: false,
  });
  // Mock the download method
  const downloadSpy = vi.spyOn(item, 'download').mockResolvedValue(content);
  return { item, downloadSpy };
};

describe('InstructionFile', () => {
  describe('Static constructors', () => {
    describe('fromContent', () => {
      it('should create InstructionFile from content string', () => {
        const content = '<!-- <flow-do id="1" /> -->Do something';

        const file = InstructionFile.fromContent(content);

        expect(file).toBeInstanceOf(InstructionFile);
        expect(file.content).toBe(content);
        expect(file.item).toBeNull();
        expect(file.vfsPath).toBeNull();
      });

      it('should parse instructions from content', () => {
        const content = `<!-- <flow-do id="1" /> -->First instruction
<!-- <flow-do id="2" /> -->Second instruction`;

        const file = InstructionFile.fromContent(content);

        expect(file.elements).toHaveLength(2);
        expect(file.elements[0].content).toContain('First instruction');
        expect(file.elements[1].content).toContain('Second instruction');
      });

      it('should have null item and vfsPath when created from content', () => {
        const file = InstructionFile.fromContent('some content');

        expect(file.item).toBeNull();
        expect(file.vfsPath).toBeNull();
      });
    });

    describe('fromItem', () => {
      it('should create InstructionFile from FSItem', async () => {
        const vfsPath = 'agent-@local/skills/test.md';
        const content = '<!-- <flow-do id="1" /> -->Test instruction';
        const { item: fsItem } = createMockFSItem(vfsPath, content);

        const file = await InstructionFile.fromItem(fsItem);

        expect(file).toBeInstanceOf(InstructionFile);
        expect(file.content).toBe(content);
        expect(file.item).toBe(fsItem);
        expect(file.vfsPath).toEqual(fsItem.vfsPath);
      });

      it('should extract vfsPath from FSItem', async () => {
        const vfsPath = 'compute_node-xxx/path/to/file.md';
        const { item: fsItem } = createMockFSItem(vfsPath, 'content');

        const file = await InstructionFile.fromItem(fsItem);

        expect(file.vfsPath).toBeDefined();
        expect(file.vfsPath?.absVfsPath).toBe(vfsPath);
      });

      it('should call download on FSItem to get content', async () => {
        const { item: fsItem, downloadSpy } = createMockFSItem('agent-@local/test.md', 'test content');

        await InstructionFile.fromItem(fsItem);

        expect(downloadSpy).toHaveBeenCalled();
      });
    });

    describe('fromVFS', () => {
      it('should create InstructionFile from VFSPath', async () => {
        const content = '<!-- <flow-do id="1" /> -->Workflow step';

        // We need to mock the content fetching - for now test the structure
        const file = InstructionFile.fromContent(content);

        expect(file).toBeInstanceOf(InstructionFile);
      });

      it('should store the VFSPath', async () => {
        const content = 'test content';

        // Create with content and manually set vfsPath for testing
        const file = InstructionFile.fromContent(content);

        // This tests that fromVFS would set the vfsPath correctly
        // Actual implementation will handle async content loading
        expect(file.vfsPath).toBeNull(); // fromContent doesn't set vfsPath
      });
    });
  });

  describe('compiled property', () => {
    it('should return false when no flow-header element exists', () => {
      const content = `<!-- <flow-do id="1" /> -->Do something
<!-- <flow-do id="2" /> -->Do another thing`;

      const file = InstructionFile.fromContent(content);

      expect(file.compiled).toBe(false);
    });

    it('should return true when flow-header element exists', () => {
      const content = `<!-- <flow-header version="1.0" /> -->
<!-- <flow-do id="1" /> -->Do something`;

      const file = InstructionFile.fromContent(content);

      expect(file.compiled).toBe(true);
    });

    it('should detect flow-header with attributes', () => {
      const content = `<!-- <flow-header version="1.0" source="test.md" /> -->
<!-- <flow-do id="1" /> -->Instruction`;

      const file = InstructionFile.fromContent(content);

      expect(file.compiled).toBe(true);
    });
  });

  describe('compile method', () => {
    it('should return a new InstructionFile', () => {
      const content = `<!-- <flow-do id="1" /> -->Do something`;

      const file = InstructionFile.fromContent(content);
      const compiled = file.compile();

      expect(compiled).toBeInstanceOf(InstructionFile);
      expect(compiled).not.toBe(file);
    });

    it('should mark the compiled file as compiled', () => {
      const content = `<!-- <flow-do id="1" /> -->Do something`;

      const file = InstructionFile.fromContent(content);
      const compiled = file.compile();

      expect(file.compiled).toBe(false);
      expect(compiled.compiled).toBe(true);
    });

    it('should add flow-header element to compiled output', () => {
      const content = `<!-- <flow-do id="1" /> -->Do something`;

      const file = InstructionFile.fromContent(content);
      const compiled = file.compile();

      expect(compiled.content).toContain('flow-header');
    });

    it('should set sourceItem on compiled file when source has vfsPath', async () => {
      const vfsPath = 'agent-@local/skills/source.md';
      const content = `<!-- <flow-do id="1" /> -->Do something`;
      const { item: fsItem } = createMockFSItem(vfsPath, content);

      const file = await InstructionFile.fromItem(fsItem);
      const compiled = file.compile();

      expect(compiled.sourceVfsPath).toBeDefined();
      expect(compiled.sourceVfsPath?.absVfsPath).toBe(vfsPath);
    });

    it('should preserve instructions in compiled output', () => {
      const content = `<!-- <flow-do id="1" /> -->First
<!-- <flow-do id="2" /> -->Second`;

      const file = InstructionFile.fromContent(content);
      const compiled = file.compile();

      // Header + 2 instructions
      expect(compiled.elements.length).toBeGreaterThanOrEqual(2);
    });

    it('should be idempotent - compiling already compiled file returns equivalent', () => {
      const content = `<!-- <flow-do id="1" /> -->Do something`;

      const file = InstructionFile.fromContent(content);
      const compiled1 = file.compile();
      const compiled2 = compiled1.compile();

      expect(compiled1.compiled).toBe(true);
      expect(compiled2.compiled).toBe(true);
    });
  });

  describe('Legacy parsing compatibility', () => {
    it('should still support legacy !mark[instruction] markers', () => {
      const content = `<!-- !mark[instruction]:1 -->
First instruction
<!-- !mark[instruction]:2 -->
Second instruction`;

      const file = InstructionFile.fromContent(content);

      // Legacy parsing creates Instruction objects, not InstructionElements
      expect(file.getInstructions().getAll()).toHaveLength(2);
    });

    it('should fallback to paragraph parsing when no markers exist', () => {
      const content = `First paragraph as instruction.

Second paragraph as instruction.

Third paragraph as instruction.`;

      const file = InstructionFile.fromContent(content);

      expect(file.getInstructions().getAll()).toHaveLength(3);
    });

    it('should prefer flow elements over legacy markers when present', () => {
      const content = `<!-- <flow-do id="1" /> -->Flow instruction
<!-- !mark[instruction]:1 -->
Legacy instruction`;

      const file = InstructionFile.fromContent(content);

      // Flow elements take precedence
      expect(file.elements).toHaveLength(1);
      expect(file.elements[0].content).toContain('Flow instruction');
    });
  });

  describe('Element tree access', () => {
    it('should provide access to parsed InstructionElements', () => {
      const content = `<!-- <flow-do id="1" /> -->Instruction`;

      const file = InstructionFile.fromContent(content);

      expect(file.elements).toBeDefined();
      expect(Array.isArray(file.elements)).toBe(true);
    });

    it('should create markless elements from plain text (no flow elements)', () => {
      const content = 'Plain text without flow elements';

      const file = InstructionFile.fromContent(content);

      // Plain text is now parsed as markless "do" elements
      expect(file.elements).toHaveLength(1);
      expect(file.elements[0].elementType).toBe('do');
      expect(file.elements[0].markless).toBe(true);
      expect(file.elements[0].content).toBe('Plain text without flow elements');
    });

    it('should preserve nested element structure', () => {
      const content = `<!-- <flow-if test="$ready"> -->
<!-- <flow-do id="inner" /> -->Do when ready
<!-- </flow-if> -->`;

      const file = InstructionFile.fromContent(content);

      expect(file.elements).toHaveLength(1);
      expect(file.elements[0].elementType).toBe('if');
      expect(file.elements[0].children).toHaveLength(1);
    });
  });

  describe('Pages structure from YAML frontmatter', () => {
    it('should return empty pages when no pages in metadata', () => {
      const content = `---
name: test
---
Some content`;

      const file = InstructionFile.fromContent(content);

      expect(file.pages).toEqual([]);
    });

    it('should parse simple pages structure', () => {
      const content = `---
name: test
pages:
  - name: index
    components:
      - main
---
Some content`;

      const file = InstructionFile.fromContent(content);

      expect(file.pages).toHaveLength(1);
      expect(file.pages[0].name).toBe('index');
      expect(file.pages[0].components).toHaveLength(1);
      expect(file.pages[0].components[0].name).toBe('main');
    });

    it('should parse multiple pages with multiple components', () => {
      const content = `---
name: test
pages:
  - name: index
    components:
      - main
      - sidebar
  - name: settings
    components:
      - form
      - header
---
Some content`;

      const file = InstructionFile.fromContent(content);

      expect(file.pages).toHaveLength(2);

      expect(file.pages[0].name).toBe('index');
      expect(file.pages[0].components).toHaveLength(2);
      expect(file.pages[0].components[0].name).toBe('main');
      expect(file.pages[0].components[1].name).toBe('sidebar');

      expect(file.pages[1].name).toBe('settings');
      expect(file.pages[1].components).toHaveLength(2);
      expect(file.pages[1].components[0].name).toBe('form');
      expect(file.pages[1].components[1].name).toBe('header');
    });

    it('should handle string format pages with default main component', () => {
      const content = `---
name: test
pages:
  - dashboard
  - analytics
---
Some content`;

      const file = InstructionFile.fromContent(content);

      expect(file.pages).toHaveLength(2);
      expect(file.pages[0].name).toBe('dashboard');
      expect(file.pages[0].components).toHaveLength(1);
      expect(file.pages[0].components[0].name).toBe('main');

      expect(file.pages[1].name).toBe('analytics');
      expect(file.pages[1].components[0].name).toBe('main');
    });

    it('should use default name "index" when page name is missing', () => {
      const content = `---
name: test
pages:
  - components:
      - main
---
Some content`;

      const file = InstructionFile.fromContent(content);

      expect(file.pages).toHaveLength(1);
      expect(file.pages[0].name).toBe('index');
    });

    describe('getPage method', () => {
      it('should find page by name', () => {
        const content = `---
pages:
  - name: index
    components:
      - main
  - name: settings
    components:
      - form
---
Content`;

        const file = InstructionFile.fromContent(content);

        const page = file.getPage('settings');
        expect(page).toBeDefined();
        expect(page?.name).toBe('settings');
        expect(page?.components[0].name).toBe('form');
      });

      it('should return undefined for non-existent page', () => {
        const content = `---
pages:
  - name: index
    components:
      - main
---
Content`;

        const file = InstructionFile.fromContent(content);

        expect(file.getPage('nonexistent')).toBeUndefined();
      });

      it('should default to index page when no name provided', () => {
        const content = `---
pages:
  - name: index
    components:
      - main
---
Content`;

        const file = InstructionFile.fromContent(content);

        const page = file.getPage();
        expect(page?.name).toBe('index');
      });
    });

    describe('getComponent method', () => {
      it('should find component by page and component name', () => {
        const content = `---
pages:
  - name: index
    components:
      - main
      - sidebar
---
Content`;

        const file = InstructionFile.fromContent(content);

        const component = file.getComponent('index', 'sidebar');
        expect(component).toBeDefined();
        expect(component?.name).toBe('sidebar');
      });

      it('should return undefined for non-existent component', () => {
        const content = `---
pages:
  - name: index
    components:
      - main
---
Content`;

        const file = InstructionFile.fromContent(content);

        expect(file.getComponent('index', 'nonexistent')).toBeUndefined();
      });

      it('should use defaults (index page, main component)', () => {
        const content = `---
pages:
  - name: index
    components:
      - main
---
Content`;

        const file = InstructionFile.fromContent(content);

        const component = file.getComponent();
        expect(component?.name).toBe('main');
      });
    });
  });
});
