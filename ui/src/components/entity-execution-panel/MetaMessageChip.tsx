import { dataManager, FlowData, Skill, systemTools } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useDockNavigation } from '@src/navigation';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications/notify';
import { Loader2, Pencil, Sparkles } from 'lucide-react';
import { useState } from 'react';

/**
 * Framework-injected (`isMeta`) user lines — skill bodies, command expansions,
 * system reminders — are not human messages. Instead of dumping the whole doc
 * into the chat, collapse it to a compact breadcrumb chip. For a skill, clicking
 * the chip previews the skill in a modal (chat stays clean); the modal's "Open
 * external" button does the full navigation to the skill's page and closes.
 */
export function MetaMessageChip({ flowData }: { flowData: FlowData }) {
  const { t } = useLingui();
  const content = flowData.content ?? '';
  const skillDir = parseSkillDir(content);
  const skillName = skillDir ? skillDir.replace(/\/+$/, '').split('/').pop() : null;
  const label = skillName ? t`Skill: ${skillName}` : t`System note`;
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);

  const openEditor = async () => {
    if (!skillDir || opening) return;
    setOpening(true);
    try {
      const row = await systemTools.discoverByPath(Skill.type, skillDir);
      if (!row) {
        notify.error({ title: t`Skill not found`, message: skillName ?? skillDir });
        return;
      }
      const rowT = row as Record<string, unknown> & { type?: string };
      if (!rowT.type) rowT.type = Skill.type;
      const skill = dataManager.updateEntityFromJson<Skill>(rowT as never);
      if (skill) {
        navigation.openDock(skill.editorDockPointer);
        setOpen(false);
      }
    } catch (err) {
      notify.error({ title: t`Could not open skill`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="my-1" data-testid="meta-message-chip">
      <button
        type="button"
        disabled={!skillDir}
        onClick={() => setOpen(true)}
        title={skillDir ? t`Preview ${label}` : label}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-70 disabled:hover:bg-muted/40 disabled:hover:text-muted-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate font-medium">{label}</span>
      </button>

      {skillDir && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                {label}
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1 text-[14px] leading-7">
              <MarkdownView value={skillBody(content)} compact />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void openEditor()}
                disabled={opening}
                title={t`Open in editor`}
                aria-label={t`Open in editor`}
              >
                {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** Skill injections carry "Base directory for this skill: …/skills/<name>". */
function parseSkillDir(content: string): string | null {
  const m = content.match(/Base directory for this skill:\s*(\S+)/);
  return m ? m[1] : null;
}

/** Strip the injection envelope so the modal shows just the skill doc. */
function skillBody(content: string): string {
  return content
    .replace(/^Base directory for this skill:.*\n?/, '')
    .replace(/\n*ARGUMENTS:.*$/s, '')
    .trim();
}
