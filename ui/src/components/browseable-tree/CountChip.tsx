import React from 'react';

/**
 * The tree-row count pill (`999+`-capped). One presentational chip shared by
 * every badge in the browseable tree (type counts, markdown folder counts,
 * tag observation counts) — previously copy-pasted per adapter.
 */
export function CountChip({ count, title }: { count: number; title?: string }) {
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title={title}>
      {count > 999 ? '999+' : count}
    </span>
  );
}
