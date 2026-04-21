interface BacklinksTabProps {
  /** Serialized attachment key; reserved for the future backlinks lookup. */
  target: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- target reserved for future lookup
export function BacklinksTab({ target: _target }: BacklinksTabProps) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-muted-foreground" data-testid="md-backlinks-panel">
      No backlinks yet.
    </div>
  );
}
