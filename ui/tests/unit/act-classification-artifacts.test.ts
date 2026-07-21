import { describe, expect, it } from 'vitest';
import { getArtifactPaths, TaskType } from '@src/components/task-bar/task-utils';

describe('getArtifactPaths for skill_creation tasks', () => {
  it('returns SKILL.md artifact when output_dir and folder_name are set', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
      output_dir: '/home/user/.flow/sessions/abc123',
      folder_name: 'my-new-skill',
      skill_scope: 'user',
    } as any;

    const artifacts = getArtifactPaths(task);
    const skillArtifact = artifacts.find((a) => a.label === 'SKILL.md');
    expect(skillArtifact).toBeDefined();
    expect(skillArtifact!.path).toBe('/home/user/.flow/sessions/abc123/my-new-skill/SKILL.md');
    expect(skillArtifact!.skillDockPath).toContain('my-new-skill');
  });

  it('returns SKILL.md artifact when skill_path is explicitly set', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
      skill_path: '/home/user/.flow/sessions/abc123/my-skill/SKILL.md',
      folder_name: 'my-skill',
      skill_scope: 'user',
    } as any;

    const artifacts = getArtifactPaths(task);
    const skillArtifact = artifacts.find((a) => a.label === 'SKILL.md');
    expect(skillArtifact).toBeDefined();
    expect(skillArtifact!.path).toBe('/home/user/.flow/sessions/abc123/my-skill/SKILL.md');
  });

  it('returns no SKILL.md when output_dir is missing and no skill_path', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
    } as any;

    const artifacts = getArtifactPaths(task);
    const skillArtifact = artifacts.find((a) => a.label === 'SKILL.md');
    expect(skillArtifact).toBeUndefined();
  });

  it('returns analysis artifacts from output_dir', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
      output_dir: '/home/user/.flow/sessions/abc123',
      folder_name: 'test-skill',
      skill_scope: 'user',
    } as any;

    const artifacts = getArtifactPaths(task);
    // The analysis report artifact is an .html report (see task-utils
    // getArtifactPaths / openAnalysisReport — "reports are .html").
    const analysisHtml = artifacts.find((a) => a.label === 'analysis.html');
    const analysisJson = artifacts.find((a) => a.label === 'analysis.json');
    expect(analysisHtml).toBeDefined();
    expect(analysisJson).toBeDefined();
  });

  it('returns classification.json for classification tasks', () => {
    const task = {
      task_type: TaskType.CLASSIFICATION,
      status: 'done',
      classification_path: '/home/user/.flow/sessions/abc/classification.json',
    } as any;

    const artifacts = getArtifactPaths(task);
    const classificationArtifact = artifacts.find((a) => a.label === 'classification.json');
    expect(classificationArtifact).toBeDefined();
    expect(classificationArtifact!.path).toBe('/home/user/.flow/sessions/abc/classification.json');
  });
});
