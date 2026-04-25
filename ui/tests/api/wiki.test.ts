/**
 * Wiki link layer — API integration test.
 *
 * Mirrors the python north-star test
 * (tests/wiki/test_skill_links_to_agentic_process.py): a real Skill body
 * wikilinks to a real AgenticProcess; both directions of the edge are
 * queryable via APIEntity.getLinks() / getBacklinks().
 *
 * Uses production SDK only — no mocks, no hand-rolled HTTP.
 */

import { AgenticProcess, ActionInfo, ClaudeCliOptions, dataManager } from '@sdk';
import { Skill } from '@sdk/entities/skill';
import { describe, it, expect, beforeEach } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

describe('wiki: skill body links to agentic process', () => {
  const signupInfo = getTestSignupInfo();
  const stamp = () => Date.now().toString(36);

  beforeEach(async (ctx: any) => {
    await apiTestSetup(signupInfo, ctx.task.name);
  });

  it('records the outgoing edge after the body wikilinks an agentic process', async () => {
    const procName = `wiki-proc-${stamp()}`;
    const skillName = `wiki-skill-${stamp()}`;

    // Real AgenticProcess persisted via the production SDK.
    const cliConfig = new ClaudeCliOptions({ permission_mode: 'bypassPermissions' });
    const process = await new AgenticProcess({
      name: procName,
      cli_config: cliConfig.toJson(),
      context_data: {},
    }).save();

    // Real Skill — body lives in SKILL.md, written via FrontMatterFsRef.
    const skill = await Skill.create(skillName);
    expect(skill.doc).not.toBeNull();
    await skill.doc!.write(`See [[${procName}]] for details.`);

    // Re-extract edges from the now-populated body. The reindex sub-action
    // exists for this exact case (out-of-band body writes via FsRef).
    const reindex = new ActionInfo('wiki', skill.typeId.type, skill.typeId.id, 'POST');
    reindex.subpath = 'reindex';
    reindex.bodyParameters = { body: `See [[${procName}]] for details.` };
    await dataManager.callAction(reindex);

    // Outgoing edge from the skill resolves to the agentic process.
    const outgoing = await skill.getLinks();
    expect(outgoing).toHaveLength(1);
    const edge = outgoing[0];
    expect(edge.src_type).toBe('skill');
    expect(edge.src_id).toBe(skill.id);
    expect(edge.target_type).toBe('agentic_process');
    expect(edge.target_id).toBe(process.id);
    expect(edge.raw).toBe(procName);
    expect(edge.line).toBe(1);

    // And: the reverse query sees the same edge from the target side.
    const backlinks = await process.getBacklinks();
    expect(backlinks.some((b) => b.src_id === skill.id)).toBe(true);
  }, 20000);

  it('unresolved wikilink is stored with null target', async () => {
    const skillName = `wiki-orphan-${stamp()}`;
    const skill = await Skill.create(skillName);
    expect(skill.doc).not.toBeNull();
    await skill.doc!.write(`Pointing to [[ghost-target-${stamp()}]].`);

    const ghost = `ghost-target-${stamp()}`;
    const reindex = new ActionInfo('wiki', skill.typeId.type, skill.typeId.id, 'POST');
    reindex.subpath = 'reindex';
    reindex.bodyParameters = { body: `Pointing to [[${ghost}]].` };
    await dataManager.callAction(reindex);

    const outgoing = await skill.getLinks();
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].raw).toBe(ghost);
    expect(outgoing[0].target_type).toBeNull();
    expect(outgoing[0].target_id).toBeNull();
  }, 20000);

  it('record without a body returns empty link lists', async () => {
    const cliConfig = new ClaudeCliOptions({ permission_mode: 'bypassPermissions' });
    const process = await new AgenticProcess({
      name: `wiki-emptyproc-${stamp()}`,
      cli_config: cliConfig.toJson(),
      context_data: {},
    }).save();

    expect(await process.getLinks()).toEqual([]);
    expect(await process.getBacklinks()).toEqual([]);
  }, 20000);
});
