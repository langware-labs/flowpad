import { AgenticProcess, Tab } from '@sdk';
import { isToolUse, type GenericEntry } from '@sdk';
import { launchSkillEval, loadSkillsByName } from '@src/components/assets/editor/skill/skill-eval-analysis';
import { DockPointer } from '@src/navigation/DockPointer';
import { registerTabContentAdapter, type TabContentAdapter } from '@src/tabs/tab-content-lifecycle';
import { ViewType } from '@src/types/ViewType';

/**
 * On closing an agentic-process tab, evaluate the run: extract which skills it
 * used from the (post-mortem) transcript, and for EACH used skill flagged
 * `eval: true` launch a skillit analysis keyed to that skill. One analysis per
 * flagged skill; the analysis surfaces in that skill editor's eval side panel
 * (both key to the skill's TypeId).
 */

/** Skill names invoked in a run (Claude/Copilot native Skill tool). */
function usedSkillNames(transcript: { entries: unknown[] }): Set<string> {
  const names = new Set<string>();
  for (const raw of transcript.entries) {
    const e = raw as GenericEntry;
    if (!isToolUse(e)) continue;
    if ((e.tool_name ?? '').toLowerCase() !== 'skill') continue;
    const skill = e.tool_input?.skill;
    if (typeof skill === 'string' && skill) names.add(skill);
  }
  return names;
}

async function evaluateClosedRun(processId: string): Promise<void> {
  const proc = await AgenticProcess.getById(processId).catch(() => null);
  if (!proc) return;

  const transcript = await proc.getTranscript().catch(() => null);
  if (!transcript) return;
  const names = usedSkillNames(transcript);
  if (names.size === 0) return;

  const byName = await loadSkillsByName().catch(() => null);
  if (!byName) return;

  for (const name of names) {
    const targetSkill = byName.get(name);
    if (!targetSkill?.isEval) continue;
    // Fire-and-forget; never block tab close on the analysis.
    void launchSkillEval({
      targetSkill,
      sourceProcessId: proc.id,
      sessionId: proc.session_id,
    });
  }
}

const adapter: TabContentAdapter = {
  setupTab: () => Promise.resolve({ tab: null }),
  // Kick off detection asynchronously and resolve immediately — closing a tab
  // must not wait on a transcript fetch + skill lookups. All errors swallowed.
  cleanupTab: (_dock: DockPointer, tab: Tab) => {
    if (tab.target_type === AgenticProcess.type && tab.target_id) {
      void evaluateClosedRun(tab.target_id);
    }
    return Promise.resolve();
  },
};

registerTabContentAdapter(ViewType.AGENTIC_PROCESS, adapter);
