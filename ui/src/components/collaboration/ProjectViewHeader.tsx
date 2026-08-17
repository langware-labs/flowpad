import { Copy, Menu, PackageSearch, RotateCcw, Users } from 'lucide-react';
import { notify } from '@src/notifications';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import type { Project, ProjectMember } from '@sdk';
import { systemTools } from '@sdk';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface Props {
  project: Project;
  localMemberId: string | null;
}

function onlineWithin(member: ProjectMember, windowMs: number): boolean {
  if (!member.last_seen_at) return false;
  const t = Date.parse(member.last_seen_at);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < windowMs;
}

export function ProjectViewHeader({ project, localMemberId }: Props) {
  const { t } = useLingui();
  const { busy } = useSystemTools();
  const members = project.presence ?? [];
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(project.displayName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const copy = () => {
    if (!project.session_code) return;
    void navigator.clipboard.writeText(project.session_code);
    notify.success({ title: t`Code copied`, message: project.session_code });
  };

  const startEdit = () => {
    setDraftName(project.name ?? project.displayName);
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = draftName.trim();
    setEditing(false);
    const next = trimmed || null;
    if ((project.name ?? null) === next) return;
    try {
      project.name = next ?? undefined;
      await project.save();
      project.markEdit();
      notify.success({ title: t`Project renamed`, message: trimmed || t`(cleared)` });
    } catch (err) {
      console.error('[ProjectViewHeader] rename failed', err);
      notify.info({ title: t`Rename failed`, message: String((err as Error).message ?? err) });
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      setDraftName(project.displayName);
    }
  };

  return (
    <div className="flex h-[52px] flex-shrink-0 items-center gap-3 border-b px-3">
      <Users className="h-4 w-4 text-muted-foreground" />
      {editing ? (
        <input
          ref={inputRef}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => void commit()}
          className="min-w-[160px] max-w-[360px] rounded border border-primary/40 bg-background px-2 py-0.5 text-sm font-medium outline-none focus:border-primary"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="rounded px-1 text-sm font-medium hover:bg-muted"
          title={t`Click to rename`}
        >
          {project.displayName}
        </button>
      )}
      {project.session_code && (
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground hover:bg-muted"
          title={t`Copy join code`}
        >
          <span>{project.session_code}</span>
          <Copy className="h-3 w-3" />
        </button>
      )}
      <div className="ms-auto flex items-center gap-1.5">
        {members.map((m) => {
          const online = onlineWithin(m, 30_000);
          const isHost = m.member_id === project.host_member_id;
          const isSelf = m.member_id === localMemberId;
          return (
            <div
              key={m.member_id}
              title={`${m.name}${isHost ? ' (host)' : ''}${isSelf ? ' (you)' : ''}${online ? ' · online' : ''}`}
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white ${
                isHost ? 'bg-amber-500' : 'bg-sky-500'
              } ${online ? '' : 'opacity-50'}`}
            >
              {m.name.slice(0, 1).toUpperCase()}
            </div>
          );
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => void systemTools.fastScanProject(project.id)}
              disabled={busy}
              data-testid="project-fast-scan"
            >
              <PackageSearch className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <Trans>Refresh project index</Trans>
          </TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              data-testid="project-actions-menu"
              aria-label={t`Project actions`}
            >
              <Menu className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => void systemTools.hardRefreshProject(project.id)}
              disabled={busy}
              data-testid="project-actions-hard-refresh"
            >
              <Trans>
                <RotateCcw className="me-2 h-4 w-4" />
                Hard refresh
              </Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
