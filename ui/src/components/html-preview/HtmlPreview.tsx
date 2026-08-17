import { t } from '@lingui/core/macro';
import { FSRef } from '@sdk';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useFS } from '@src/hooks/useFS';

/**
 * Render a local self-contained HTML file (a chart, a diagram, a one-file
 * artifact) in a sandboxed iframe. The file is read through the FSRef channel
 * (never a hand-built backend URL) and injected as `srcDoc`; `allow-scripts`
 * without `allow-same-origin` keeps agent-generated markup isolated from the
 * app's origin.
 */
export function HtmlPreview({ path }: { path: string }) {
  const { computeNode } = useAgentContext();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodeKey = computeNode?.typeId?.toString() ?? null;
  const fs = useFS(computeNode?.typeId);
  const revision = fs?.revision(path) ?? 0;
  useEffect(() => {
    if (!nodeKey || !computeNode?.typeId) return;
    let cancelled = false;
    setHtml(null);
    setError(null);
    new FSRef(path.replace(/^\//, ''), computeNode.typeId)
      .read()
      .then((text) => {
        if (!cancelled) setHtml(text);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nodeKey, revision]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading preview…
      </div>
    );
  }
  return (
    <iframe
      title={t`HTML preview`}
      sandbox="allow-scripts"
      srcDoc={html}
      className="h-full w-full border-0 bg-white"
      data-testid="html-preview"
    />
  );
}

export default HtmlPreview;
