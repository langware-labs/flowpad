import { ContextEntitiesEnum, dataContext, Skill, TypeId } from '@sdk';
import { afterEach, describe, expect, it } from 'vitest';

// VIBE-007: indexing a skill by its direct SKILL.md path leaves the entity's
// asset_ref pointing at the FILE (`.../<name>/SKILL.md`) rather than the folder
// (`.../<name>/`). `Skill.doc` composes the editor's download path by appending
// `/SKILL.md`, so a file-valued asset_ref yields `.../SKILL.md/SKILL.md`, which
// 404s and renders "Note: File is missing".
const COMPUTE_NODE = new TypeId('compute_node-00000000-0000-4000-8000-000000000001');
const SKILL_DIR = '/tmp/proj/.claude/skills/vibe-qa-greeter';

// `Skill.doc` reads the current compute node off dataContext; arrange it on the
// real singleton (not a mock) so doc resolves a concrete path.
const setComputeNode = (typeId: TypeId | null) =>
  (dataContext as unknown as { _contextEntitiesMap: Map<ContextEntitiesEnum, TypeId | null> })._contextEntitiesMap.set(
    ContextEntitiesEnum.CurrentComputeNodeTypeId,
    typeId,
  );

describe('Skill.doc path composition', () => {
  afterEach(() => setComputeNode(null));

  it('resolves a folder-valued asset_ref to <folder>/SKILL.md', () => {
    setComputeNode(COMPUTE_NODE);
    const skill = new Skill({ asset_ref: SKILL_DIR });
    expect(skill.doc?.path).toBe(`${SKILL_DIR}/SKILL.md`);
  });

  it('does not double-append when asset_ref already points at the main file', () => {
    setComputeNode(COMPUTE_NODE);
    const skill = new Skill({ asset_ref: `${SKILL_DIR}/SKILL.md` });
    expect(skill.doc?.path).toBe(`${SKILL_DIR}/SKILL.md`);
  });
});
