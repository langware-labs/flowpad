import type { ClaudeSessionStatus } from '@sdk/resource_management/fs_records/claude/claude-session';

interface SessionStatusDotProps {
  status: ClaudeSessionStatus;
}

export function SessionStatusDot({ status }: SessionStatusDotProps) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        status === 'running'
          ? 'animate-pulse bg-green-500'
          : status === 'complete'
            ? 'bg-blue-500'
            : 'bg-muted-foreground/40'
      }`}
      title={status}
    />
  );
}
