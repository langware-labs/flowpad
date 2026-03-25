import { describe, expect, it } from 'vitest';
import { getArtifactPaths, TaskType } from '@src/components/task-bar/task-utils';

describe('getArtifactPaths for skill_creation tasks', () => {
  it('returns SKILL.md artifact when output_dir and folderName are in metadata', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
      metadata: {
        output_dir: '/home/user/.flow/sessions/abc123',
        folderName: 'my-new-skill',
        skillScope: 'user',
      },
    } as any;

    const artifacts = getArtifactPaths(task);
    const skillArtifact = artifacts.find((a) => a.label === 'SKILL.md');
    expect(skillArtifact).toBeDefined();
    expect(skillArtifact!.path).toBe('/home/user/.flow/sessions/abc123/my-new-skill/SKILL.md');
    expect(skillArtifact!.skillDockPath).toContain('my-new-skill');
  });

  it('returns SKILL.md artifact when skillPath is explicitly set', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
      metadata: {
        skillPath: '/home/user/.flow/sessions/abc123/my-skill/SKILL.md',
        folderName: 'my-skill',
        skillScope: 'user',
      },
    } as any;

    const artifacts = getArtifactPaths(task);
    const skillArtifact = artifacts.find((a) => a.label === 'SKILL.md');
    expect(skillArtifact).toBeDefined();
    expect(skillArtifact!.path).toBe('/home/user/.flow/sessions/abc123/my-skill/SKILL.md');
  });

  it('returns no SKILL.md when output_dir is missing and no skillPath', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
      metadata: {
        processId: 'p1',
        sessionId: 's1',
        command: 'create-skill',
      },
    } as any;

    const artifacts = getArtifactPaths(task);
    const skillArtifact = artifacts.find((a) => a.label === 'SKILL.md');
    expect(skillArtifact).toBeUndefined();
  });

  it('returns analysis artifacts from output_dir', () => {
    const task = {
      task_type: TaskType.SKILL_CREATION,
      status: 'done',
      metadata: {
        output_dir: '/home/user/.flow/sessions/abc123',
        folderName: 'test-skill',
        skillScope: 'user',
      },
    } as any;

    const artifacts = getArtifactPaths(task);
    const analysisMd = artifacts.find((a) => a.label === 'analysis.md');
    const analysisJson = artifacts.find((a) => a.label === 'analysis.json');
    expect(analysisMd).toBeDefined();
    expect(analysisJson).toBeDefined();
  });

  it('returns classification.json for classification tasks', () => {
    const task = {
      task_type: TaskType.CLASSIFICATION,
      status: 'done',
      metadata: {
        classificationPath: '/home/user/.flow/sessions/abc/classification.json',
      },
    } as any;

    const artifacts = getArtifactPaths(task);
    const classificationArtifact = artifacts.find((a) => a.label === 'classification.json');
    expect(classificationArtifact).toBeDefined();
    expect(classificationArtifact!.path).toBe('/home/user/.flow/sessions/abc/classification.json');
  });
});
