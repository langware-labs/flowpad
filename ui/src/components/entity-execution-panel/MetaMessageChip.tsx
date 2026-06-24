import { dataManager, FlowData, Skill, systemTools } from '@sdk';
import { useDockNavigation } from '@src/navigation';
import { notify } from '@src/notifications/notify';
import { ExternalLink, Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';

/**
 * Framework-injected (`isMeta`) user lines — skill bodies, command expansions,
 * system reminders — are not human messages. Instead of dumping the whole doc
 * into the chat, collapse it to a compact breadcrumb chip. When the injection is
 * a skill, the chip opens that skill's page in a tab (resolved lazily on click
 * from the "Base directory for this skill: …" path) — the chat stays clean, but
 * the user can still inspect the skill.
 */
export function MetaMessageChip({ flowData }: { flowData: FlowData }) {
  const content = flowData.content ?? '';
  const skillDir = parseSkillDir(content);
  const skillName = skillDir ? skillDir.replace(/\/+$/, '').split('/').pop() : null;
  const label = skillName ? `Skill: ${skillName}` : 'System note';
  const { navigation } = useDockNavigation();
  const [opening, setOpening] = useState(false);

  const open = async () => {
    if (!skillDir || opening) return;
    setOpening(true);
    try {
      const row = await systemTools.discoverByPath(Skill.type, skillDir);
      if (!row) {
        notify.error({ title: 'Skill not found', message: skillName ?? skillDir });
        return;
      }
      const rowT = row as Record<string, unknown> & { type?: string };
      if (!rowT.type) rowT.type = Skill.type;
      const skill = dataManager.updateEntityFromJson<Skill>(rowT as never);
      if (skill) navigation.openDock(skill.editorDockPointer);
    } catch (err) {
      notify.error({ title: 'Could not open skill', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="my-1" data-testid="meta-message-chip">
      <button
        type="button"
        disabled={!skillDir || opening}
        onClick={() => void open()}
        title={skillDir ? `Open ${label} in a tab` : label}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-70 disabled:hover:bg-muted/40 disabled:hover:text-muted-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate font-medium">{label}</span>
        {skillDir &&
          (opening ? (
            <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
          ) : (
            <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-60" />
          ))}
      </button>
    </div>
  );
}

/** Skill injections carry "Base directory for this skill: …/skills/<name>". */
function parseSkillDir(content: string): string | null {
  const m = content.match(/Base directory for this skill:\s*(\S+)/);
  return m ? m[1] : null;
}
