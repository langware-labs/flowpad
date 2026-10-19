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

import { AgenticProcess, ActionInfo, ClaudeAgentOptions, ComputeNode, GRAPH_API_PREFIX, apiClient, dataManager } from '@sdk';
import { Markdown } from '@sdk/entities/markdown';
import { Skill } from '@sdk/entities/skill';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const CN_FS_BASE = `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local/fs-records`;

describe('wiki: skill body links to agentic process', () => {
  const signupInfo = getTestSignupInfo();
  const stamp = () => Date.now().toString(36);

  // Every fixture this suite creates is real: skills materialize folders in
  // the user's global ~/.claude/skills/, and entity rows land in the asset
  // list. DELETE /fs-records/<type>/<id> is the full purge (entity row + FTS
  // + shadow dir + live source folder) — without it every run leaks
  // wiki-skill/orphan/resrc-* skills and wiki-*proc processes.
  const cleanup: Array<{ type: string; id: string }> = [];
  const track = <T extends { typeId: { type: string; id: string } }>(e: T): T => {
    cleanup.push({ type: e.typeId.type, id: e.typeId.id });
    return e;
  };

  beforeEach(async (ctx: any) => {
    await apiTestSetup(signupInfo, ctx.task.name);
  });

  afterEach(async () => {
    while (cleanup.length) {
      const { type, id } = cleanup.pop()!;
      try {
        await apiClient.delete(`${CN_FS_BASE}/${type}/${id}`);
      } catch { /* best effort — some fixtures are deleted in-test */ }
    }
  });

  it('records the outgoing edge after the body wikilinks an agentic process', async () => {
    const procName = `wiki-proc-${stamp()}`;
    const skillName = `wiki-skill-${stamp()}`;

    // Real AgenticProcess persisted via the production SDK.
    const cliConfig = new ClaudeAgentOptions({ permission_mode: 'bypassPermissions' });
    const process = track(await new AgenticProcess({
      name: procName,
      cli_config: cliConfig.toJson(),
      context_data: {},
    }).save());

    // Real Skill — body lives in SKILL.md, written via FrontMatterFsRef.
    const skill = track(await Skill.create(skillName));
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
    const skill = track(await Skill.create(skillName));
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

  it('entity.reindex(body) returns the resolved edges', async () => {
    const procName = `wiki-reproc-${stamp()}`;
    const cliConfig = new ClaudeAgentOptions({ permission_mode: 'bypassPermissions' });
    const process = track(await new AgenticProcess({
      name: procName,
      cli_config: cliConfig.toJson(),
      context_data: {},
    }).save());

    const skill = track(await Skill.create(`wiki-resrc-${stamp()}`));
    expect(skill.doc).not.toBeNull();
    await skill.doc!.write(`See [[${procName}]] for details.`);

    // Direct SDK call — no toolbar, no UI. Mirrors Python Entity.reindex(body).
    const edges = await skill.reindex(`See [[${procName}]] for details.`);

    expect(edges).toHaveLength(1);
    expect(edges[0].target_type).toBe('agentic_process');
    expect(edges[0].target_id).toBe(process.id);

    // The same edges show up via getLinks().
    const outgoing = await skill.getLinks();
    expect(outgoing).toEqual(edges);
  }, 20000);

  it('record without a body returns empty link lists', async () => {
    const cliConfig = new ClaudeAgentOptions({ permission_mode: 'bypassPermissions' });
    const process = track(await new AgenticProcess({
      name: `wiki-emptyproc-${stamp()}`,
      cli_config: cliConfig.toJson(),
      context_data: {},
    }).save());

    expect(await process.getLinks()).toEqual([]);
    expect(await process.getBacklinks()).toEqual([]);
  }, 20000);

  /**
   * Lifecycle test — mirrors tests/wiki/test_backlink_count_lifecycle.py.
   * Walks the 8 steps that drive cleanup-on-delete:
   *   1-2. Create target + 3 markdown sources linking to it    → 3 backlinks
   *   3-4. Delete one source                                    → 2 backlinks
   *   5-6. Edit another source's body to remove the wikilink    → 1 backlink
   *   7-8. Delete the target                                    → surviving
   *                                                              source's
   *                                                              outgoing edge
   *                                                              cleaned
   */
  it('backlink count tracks source delete, body edit, and target delete', async () => {
    const targetName = `bl-target-${stamp()}`;
    const cliConfig = new ClaudeAgentOptions({ permission_mode: 'bypassPermissions' });
    const target = track(await new AgenticProcess({
      name: targetName,
      cli_config: cliConfig.toJson(),
      context_data: {},
    }).save());

    const sources: Markdown[] = [];
    for (let i = 0; i < 3; i++) {
      const md = track(await new Markdown({ name: `bl-src-${i}-${stamp()}` }).save());
      // Body lives in the wiki layer only — reindex with explicit body avoids
      // the fs round-trip and writes the edges directly. The source's `name`
      // is what the wiki resolver matches; the body is what the parser reads.
      await md.reindex(`See [[${targetName}]] from ${i}.`);
      sources.push(md);
    }

    // 1-2. Initial: 3 backlinks
    expect((await target.getBacklinks()).length).toBe(3);

    // 3-4. Delete one source
    await sources[0].delete();
    expect((await target.getBacklinks()).length).toBe(2);

    // 5-6. Strip wikilink from another source's body
    await sources[1].reindex('No more wiki link here.');
    expect((await target.getBacklinks()).length).toBe(1);

    // 7-8. Delete the target — surviving source's outgoing edge cleaned
    expect((await sources[2].getLinks()).length).toBe(1);
    await target.delete();
    expect(await sources[2].getLinks()).toEqual([]);
  }, 30000);
});
