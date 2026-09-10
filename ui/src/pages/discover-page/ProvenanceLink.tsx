import { useLingui } from '@lingui/react/macro';
import { GitBranch, Github, Monitor } from 'lucide-react';
import { provenanceOf } from './discover-model';

/**
 * Where a row's bytes come from: `owner/name@branch` linking to the repository
 * page for a git origin, "this machine" for a local one. The provider glyph is
 * the one exception to the type-icon rule — a git host is not an entity type.
 */
export function ProvenanceLink({ origin, className = '' }: { origin: Record<string, unknown> | null | undefined; className?: string }) {
  const { t } = useLingui();
  const p = provenanceOf(origin);
  const base = `inline-flex min-w-0 items-center gap-1 font-mono text-[11px] ${className}`;
  if (!p) {
    return <span className={`${base} text-muted-foreground/60`}>—</span>;
  }
  if (p.kind === 'local') {
    return (
      <span className={`${base} text-muted-foreground`} title={t`Published from a folder on the publisher's machine`}>
        <Monitor className="h-3 w-3 shrink-0" />
        <span className="truncate">{t`this machine`}</span>
      </span>
    );
  }
  const Glyph = p.provider === 'github' ? Github : GitBranch;
  const inner = (
    <>
      <Glyph className="h-3 w-3 shrink-0" />
      <span className="truncate">{p.label}</span>
    </>
  );
  return p.href ? (
    <a
      href={p.href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`${base} text-muted-foreground hover:text-foreground hover:underline`}
      title={t`Open the repository`}
      data-testid="discover-provenance"
    >
      {inner}
    </a>
  ) : (
    <span className={`${base} text-muted-foreground`} data-testid="discover-provenance">
      {inner}
    </span>
  );
}
