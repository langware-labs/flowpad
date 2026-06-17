/**
 * Skill File Tree Browser — Unit Test
 *
 * Validates that SkillFileTree renders files in hierarchy and calls onSelectFile
 * with the correct absolute path when a file is clicked.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SkillFileTree from '@src/components/skill-editor/SkillFileTree';

const TREE = {
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

const SKILL_FOLDER = '/Users/shlom/.claude/skills/test_tree_skill';

describe('SkillFileTree', () => {
  it('renders all files in hierarchy', () => {
    render(<SkillFileTree tree={TREE} skillFolder={SKILL_FOLDER} onSelectFile={vi.fn()} />);

    expect(screen.getByText('sample.py')).toBeInTheDocument();
    expect(screen.getByText('image_sample.png')).toBeInTheDocument();
    expect(screen.getByText('SKILL.md')).toBeInTheDocument();
    expect(screen.getByText('subdir')).toBeInTheDocument();
    expect(screen.getByText('nested.json')).toBeInTheDocument();
  });

  it('nests folders and their children correctly', () => {
    render(<SkillFileTree tree={TREE} skillFolder={SKILL_FOLDER} onSelectFile={vi.fn()} />);

    const subdirElement = screen.getByText('subdir');
    const subdirContainer = subdirElement.closest('li');
    expect(within(subdirContainer!).getByText('nested.json')).toBeInTheDocument();
  });

  it('clicking sample.py calls onSelectFile with absolute path', async () => {
    const onSelect = vi.fn();
    render(<SkillFileTree tree={TREE} skillFolder={SKILL_FOLDER} onSelectFile={onSelect} />);

    const samplePyButton = screen.getByText('sample.py');
    await userEvent.click(samplePyButton);

    expect(onSelect).toHaveBeenCalledWith(`${SKILL_FOLDER}/sample.py`);
  });

  it('clicking image_sample.png calls onSelectFile with absolute path', async () => {
    const onSelect = vi.fn();
    render(<SkillFileTree tree={TREE} skillFolder={SKILL_FOLDER} onSelectFile={onSelect} />);

    const imageButton = screen.getByText('image_sample.png');
    await userEvent.click(imageButton);

    expect(onSelect).toHaveBeenCalledWith(`${SKILL_FOLDER}/image_sample.png`);
  });

  it('clicking nested.json calls onSelectFile with absolute path including subdir', async () => {
    const onSelect = vi.fn();
    render(<SkillFileTree tree={TREE} skillFolder={SKILL_FOLDER} onSelectFile={onSelect} />);

    const nestedJsonButton = screen.getByText('nested.json');
    await userEvent.click(nestedJsonButton);

    expect(onSelect).toHaveBeenCalledWith(`${SKILL_FOLDER}/subdir/nested.json`);
  });
});
