// DocsGraphView — the docs knowledge browser (ViewType.K_BROWSER).
//
// Thin route-level wrapper: resolves the docs root from the dock pointer
// (/dock/k-browser/<vfs|typeid>/<value>) and renders the Knowledge Atlas
// canvas (the Claude Design "The Atlas" handoff) for it.

import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { KnowledgeAtlas } from '@src/components/knowledge-atlas/KnowledgeAtlas';

export function DocsGraphView() {
  const { currentDock } = useDockNavigation();

  const root = useMemo(() => {
    const parsed = DockPointer.parseKnowledgeBrowserPointer(currentDock?.pointer);
    return parsed?.value ?? '';
  }, [currentDock?.pointer]);

  if (!root) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        <Trans>No docs root in the URL — open the knowledge browser from a docs vault.</Trans>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <KnowledgeAtlas key={root} root={root} />
    </div>
  );
}
