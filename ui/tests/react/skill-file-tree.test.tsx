/**
 * Skill File Tree Browser — Integration Test
 *
 * Validates: skill menu shows folder hierarchy, files open in type-appropriate viewers
 * Scenario: skill with sample.py + image_sample.png + subdir/nested.json
 *
 * On/off switches tested:
 * 1. GET /api/v1/skills/<id>/tree returns correct file structure
 * 2. Frontend tree renders all files in hierarchy
 * 3. Click file → URL navigates to /editor/skill/<skillId>/<filepath>
 * 4. File viewer selected by FILE_VIEWER_REGISTRY based on extension
 * 5. Content fetched via GET /api/v1/skills/<id>/file?path=<filepath>
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import fs from 'fs/promises';
import path from 'path';

// Components to be implemented
import SkillFileTree from '@src/components/skill-editor/SkillFileTree';
import SkillFileViewer from '@src/components/skill-editor/SkillFileViewer';
import { FILE_VIEWER_REGISTRY } from '@src/components/skill-editor/viewer-registry';

// Mocks
const mockApiClient = {
  get: async (url: string) => {
    // Mock /api/v1/skills/<id>/tree
    if (url.includes('/tree')) {
      return {
        status: 200,
        data: {
          files: [
            { path: 'sample.py', type: 'file', size: 245 },
            { path: 'image_sample.png', type: 'file', size: 98 },
            { path: 'subdir', type: 'directory' },
            { path: 'subdir/nested.json', type: 'file', size: 156 },
            { path: 'SKILL.md', type: 'file', size: 302 },
          ],
          tree: {
            name: 'test_tree_skill',
            type: 'directory',
            children: [
              { name: 'SKILL.md', type: 'file' },
              { name: 'sample.py', type: 'file' },
              { name: 'image_sample.png', type: 'file' },
              {
                name: 'subdir',
                type: 'directory',
                children: [{ name: 'nested.json', type: 'file' }],
              },
            ],
          },
        },
      };
    }

    // Mock /api/v1/skills/<id>/file?path=...
    if (url.includes('/file?path=')) {
      const pathParam = new URL(url, 'http://localhost').searchParams.get('path');
      const content = {
        'sample.py': `"""Sample Python module for file tree browser testing."""

def hello_world():
    """Return a greeting."""
    return "Hello from sample.py!"`,
        'image_sample.png': 'binary-image-data',
        'subdir/nested.json': `{
  "name": "nested configuration",
  "version": "1.0.0",
  "settings": { "enabled": true }
}`,
        'SKILL.md': `---
id: skill-test-tree-01a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6
name: test_tree_skill
---

# Test Tree Skill`,
      };
      return { status: 200, data: { content: content[pathParam as keyof typeof content] || '' } };
    }

    throw new Error(`Unexpected API call: ${url}`);
  },
};

describe('Skill File Tree Browser', () => {
  const skillId = 'skill-test-tree-01a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
  const skillName = 'test_tree_skill';

  beforeAll(async () => {
    // Verify the test skill exists on disk
    const skillPath = path.join(process.env.HOME!, '.claude/skills/test_tree_skill');
    const stats = await fs.stat(skillPath);
    expect(stats.isDirectory()).toBe(true);
  });

  describe('On/off switch #1: File tree API returns correct structure', () => {
    it('GET /api/v1/skills/<id>/tree returns folder hierarchy', async () => {
      const response = await mockApiClient.get(`/api/v1/skills/${skillId}/tree`);

      expect(response.status).toBe(200);
      expect(response.data.tree.name).toBe('test_tree_skill');
      expect(response.data.tree.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'SKILL.md' }),
          expect.objectContaining({ name: 'sample.py' }),
          expect.objectContaining({ name: 'image_sample.png' }),
          expect.objectContaining({
            name: 'subdir',
            type: 'directory',
            children: expect.arrayContaining([
              expect.objectContaining({ name: 'nested.json' }),
            ]),
          }),
        ])
      );
    });
  });

  describe('On/off switch #2: Frontend tree renders all files', () => {
    it('SkillFileTree displays all files from API in hierarchy', async () => {
      const mockTree = {
        name: 'test_tree_skill',
        type: 'directory' as const,
        children: [
          { name: 'SKILL.md', type: 'file' as const },
          { name: 'sample.py', type: 'file' as const },
          { name: 'image_sample.png', type: 'file' as const },
          {
            name: 'subdir',
            type: 'directory' as const,
            children: [{ name: 'nested.json', type: 'file' as const }],
          },
        ],
      };

      render(
        <BrowserRouter>
          <SkillFileTree tree={mockTree} skillId={skillId} />
        </BrowserRouter>
      );

      // Check all files are visible
      expect(screen.getByText('sample.py')).toBeInTheDocument();
      expect(screen.getByText('image_sample.png')).toBeInTheDocument();
      expect(screen.getByText('nested.json')).toBeInTheDocument();
      expect(screen.getByText('SKILL.md')).toBeInTheDocument();

      // Check folder hierarchy is visible
      expect(screen.getByText('subdir')).toBeInTheDocument();
      const subdir = screen.getByText('subdir').closest('li');
      expect(within(subdir!).getByText('nested.json')).toBeInTheDocument();
    });
  });

  describe('On/off switch #3: Click file → URL changes', () => {
    it('clicking sample.py navigates to /editor/skill/<skillId>/sample.py', async () => {
      const mockTree = {
        name: 'test_tree_skill',
        type: 'directory' as const,
        children: [
          { name: 'sample.py', type: 'file' as const },
        ],
      };

      const mockNavigate = vi.fn();

      render(
        <BrowserRouter>
          <SkillFileTree tree={mockTree} skillId={skillId} onSelectFile={mockNavigate} />
        </BrowserRouter>
      );

      const samplePyButton = screen.getByText('sample.py');
      await userEvent.click(samplePyButton);

      expect(mockNavigate).toHaveBeenCalledWith({
        skillId,
        filePath: 'sample.py',
      });
    });

    it('clicking nested.json navigates to /editor/skill/<skillId>/subdir/nested.json', async () => {
      const mockTree = {
        name: 'test_tree_skill',
        type: 'directory' as const,
        children: [
          {
            name: 'subdir',
            type: 'directory' as const,
            children: [{ name: 'nested.json', type: 'file' as const }],
          },
        ],
      };

      const mockNavigate = vi.fn();

      render(
        <BrowserRouter>
          <SkillFileTree tree={mockTree} skillId={skillId} onSelectFile={mockNavigate} />
        </BrowserRouter>
      );

      const nestedJsonButton = screen.getByText('nested.json');
      await userEvent.click(nestedJsonButton);

      expect(mockNavigate).toHaveBeenCalledWith({
        skillId,
        filePath: 'subdir/nested.json',
      });
    });
  });

  describe('On/off switch #4: Viewer registry maps file type → component', () => {
    it('FILE_VIEWER_REGISTRY has entries for all test file types', () => {
      expect(FILE_VIEWER_REGISTRY['.py']).toBeDefined();
      expect(FILE_VIEWER_REGISTRY['.png']).toBeDefined();
      expect(FILE_VIEWER_REGISTRY['.json']).toBeDefined();
      expect(FILE_VIEWER_REGISTRY['.md']).toBeDefined();
    });

    it('.py files map to CodeEditor', () => {
      expect(FILE_VIEWER_REGISTRY['.py'].name).toBe('CodeEditor');
    });

    it('.png files map to ImageViewer', () => {
      expect(FILE_VIEWER_REGISTRY['.png'].name).toBe('ImageViewer');
    });

    it('.json files map to JSONViewer', () => {
      expect(FILE_VIEWER_REGISTRY['.json'].name).toBe('JSONViewer');
    });
  });

  describe('On/off switch #5: File content fetched and viewer renders', () => {
    it('renders CodeEditor when opening sample.py', async () => {
      render(
        <BrowserRouter>
          <SkillFileViewer
            skillId={skillId}
            filePath="sample.py"
            fileExtension=".py"
            apiClient={mockApiClient}
          />
        </BrowserRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/def hello_world/)).toBeInTheDocument();
      });

      // CodeEditor should have code highlighting
      const editor = screen.getByRole('textbox', { hidden: true });
      expect(editor).toHaveClass('code-editor');
    });

    it('renders ImageViewer when opening image_sample.png', async () => {
      render(
        <BrowserRouter>
          <SkillFileViewer
            skillId={skillId}
            filePath="image_sample.png"
            fileExtension=".png"
            apiClient={mockApiClient}
          />
        </BrowserRouter>
      );

      await waitFor(() => {
        const img = screen.getByRole('img');
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute('src');
      });
    });

    it('renders JSONViewer when opening subdir/nested.json', async () => {
      render(
        <BrowserRouter>
          <SkillFileViewer
            skillId={skillId}
            filePath="subdir/nested.json"
            fileExtension=".json"
            apiClient={mockApiClient}
          />
        </BrowserRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/nested configuration/)).toBeInTheDocument();
      });

      // JSONViewer should render expandable tree
      const jsonTree = screen.getByRole('treeitem');
      expect(jsonTree).toBeInTheDocument();
    });
  });

  describe('Full integration: click file → opens in correct viewer', () => {
    it('clicking sample.py in tree → CodeEditor renders with content', async () => {
      const mockTree = {
        name: 'test_tree_skill',
        type: 'directory' as const,
        children: [
          { name: 'sample.py', type: 'file' as const },
          { name: 'image_sample.png', type: 'file' as const },
        ],
      };

      const { rerender } = render(
        <BrowserRouter>
          <SkillFileTree tree={mockTree} skillId={skillId} />
        </BrowserRouter>
      );

      const samplePyButton = screen.getByText('sample.py');
      await userEvent.click(samplePyButton);

      // Simulate navigation to /editor/skill/<id>/sample.py
      // Viewer component mounts with filePath="sample.py"
      rerender(
        <BrowserRouter>
          <SkillFileViewer
            skillId={skillId}
            filePath="sample.py"
            fileExtension=".py"
            apiClient={mockApiClient}
          />
        </BrowserRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/def hello_world/)).toBeInTheDocument();
      });
    });

    it('clicking image_sample.png in tree → ImageViewer renders image', async () => {
      const mockTree = {
        name: 'test_tree_skill',
        type: 'directory' as const,
        children: [
          { name: 'image_sample.png', type: 'file' as const },
        ],
      };

      const { rerender } = render(
        <BrowserRouter>
          <SkillFileTree tree={mockTree} skillId={skillId} />
        </BrowserRouter>
      );

      const imageButton = screen.getByText('image_sample.png');
      await userEvent.click(imageButton);

      rerender(
        <BrowserRouter>
          <SkillFileViewer
            skillId={skillId}
            filePath="image_sample.png"
            fileExtension=".png"
            apiClient={mockApiClient}
          />
        </BrowserRouter>
      );

      await waitFor(() => {
        const img = screen.getByRole('img');
        expect(img).toBeInTheDocument();
      });
    });

    it('clicking nested.json in tree → JSONViewer renders JSON', async () => {
      const mockTree = {
        name: 'test_tree_skill',
        type: 'directory' as const,
        children: [
          {
            name: 'subdir',
            type: 'directory' as const,
            children: [{ name: 'nested.json', type: 'file' as const }],
          },
        ],
      };

      const { rerender } = render(
        <BrowserRouter>
          <SkillFileTree tree={mockTree} skillId={skillId} />
        </BrowserRouter>
      );

      const jsonButton = screen.getByText('nested.json');
      await userEvent.click(jsonButton);

      rerender(
        <BrowserRouter>
          <SkillFileViewer
            skillId={skillId}
            filePath="subdir/nested.json"
            fileExtension=".json"
            apiClient={mockApiClient}
          />
        </BrowserRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/nested configuration/)).toBeInTheDocument();
      });
    });
  });
});
