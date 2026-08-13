import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { Plus, Trash2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';

export interface HookTableRow {
  id: string;
  eventName: string;
  matcher: string;
  hookType: 'command' | 'prompt';
  content: string;
  timeout?: number;
  eventConfigIndex: number;
  hookIndex: number;
}

const HOOK_EVENTS = {
  PreToolUse: { title: 'Pre Tool Use', icon: '⚡' },
  PostToolUse: { title: 'Post Tool Use', icon: '✅' },
  PermissionRequest: { title: 'Permission Request', icon: '🔐' },
  UserPromptSubmit: { title: 'User Prompt Submit', icon: '💬' },
  Stop: { title: 'Stop', icon: '🛑' },
  SubagentStop: { title: 'Subagent Stop', icon: '🤖' },
  SessionStart: { title: 'Session Start', icon: '🚀' },
  SessionEnd: { title: 'Session End', icon: '🏁' },
  Notification: { title: 'Notification', icon: '🔔' },
  PreCompact: { title: 'Pre Compact', icon: '📦' },
} as const;

interface HooksTableProps {
  rows: HookTableRow[];
  selectedRowId: string | null;
  onRowClick: (row: HookTableRow) => void;
  onAddClick: () => void;
  onDeleteClick: (row: HookTableRow) => void;
}

export function HooksTable({ rows, selectedRowId, onRowClick, onAddClick, onDeleteClick }: HooksTableProps) {
  if (rows.length === 0) {
    // Compact empty state
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed p-4">
        <p className="text-sm text-muted-foreground">
          <Trans>No hooks configured</Trans>
        </p>
        <Button onClick={onAddClick} size="sm">
          <Plus className="me-2 h-4 w-4" />
          <Trans>Add Hook</Trans>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {rows.length} hook{rows.length !== 1 ? 's' : ''} configured
        </p>
        <Button onClick={onAddClick} size="sm">
          <Plus className="me-2 h-4 w-4" />
          <Trans>Add Hook</Trans>
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">
                <Trans>Event</Trans>
              </TableHead>
              <TableHead className="w-[120px]">
                <Trans>Matcher</Trans>
              </TableHead>
              <TableHead className="w-[100px]">
                <Trans>Type</Trans>
              </TableHead>
              <TableHead>
                <Trans>Content</Trans>
              </TableHead>
              <TableHead className="w-[80px]">
                <Trans>Timeout</Trans>
              </TableHead>
              <TableHead className="w-[80px] text-end">
                <Trans>Actions</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className={`cursor-pointer ${selectedRowId === row.id ? 'bg-muted' : ''}`}
                onClick={() => onRowClick(row)}
              >
                <TableCell className="font-medium">
                  {HOOK_EVENTS[row.eventName as keyof typeof HOOK_EVENTS]?.icon}{' '}
                  {HOOK_EVENTS[row.eventName as keyof typeof HOOK_EVENTS]?.title || row.eventName}
                </TableCell>
                <TableCell>
                  <code className="text-xs">{row.matcher}</code>
                </TableCell>
                <TableCell>
                  <Badge variant={row.hookType === 'command' ? 'default' : 'secondary'}>
                    {row.hookType === 'command' ? <Trans>🔧 Command</Trans> : <Trans>🤖 Prompt</Trans>}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="max-w-md truncate font-mono text-xs text-muted-foreground">{row.content}</div>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{row.timeout || 60}s</span>
                </TableCell>
                <TableCell className="text-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteClick(row);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
