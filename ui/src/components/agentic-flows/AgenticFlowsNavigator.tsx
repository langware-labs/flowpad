/**
 * Agentic Flows left-menu (Zone B) — NavigatorPanel descriptor, ChatsNavigator
 * idiom: header title + count + ScopeFilterIconBar, search over agentic_flow
 * records, customBody list. Clicking a flow opens its per-flow dock tab
 * (`agentic_flow-<id>` pointer — URL-first; the view loads from the pointer).
 */
import { useCallback, useMemo, useState } from 'react';
import { AgenticFlow, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { useProject } from '@src/hooks/useProject';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { DockPointer, useDockNavigation } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import './agentic-flows.css';

const flowsQuery = new QueryRequest({
  type: AgenticFlow.type,
  scope: [],
  name: 'useAgenticFlows:all',
});

export function AgenticFlowsNavigator() {
  const { data: flows = [] } = useEntitiesQuery<AgenticFlow>(flowsQuery);
  const { project } = useProject();
  const { navigation, currentDock } = useDockNavigation();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? defaultScopeFilter(project?.id ?? null),
    [currentDock, project?.id],
  );

  const activePointer = currentDock?.viewType === ViewType.AGENTIC_FLOWS ? currentDock.pointer : undefined;

  const openFlow = useCallback(
    (id: string) => {
      navigation.openDock(new DockPointer(ViewType.AGENTIC_FLOWS, `${AgenticFlow.type}-${id}`));
    },
    [navigation],
  );

  const handleScopeChange = useCallback(
    (scope: ScopeFilter) => {
      const base = currentDock ?? DockPointer.forTab(ViewType.AGENTIC_FLOWS);
      navigation.openDock(base.withScopeFilter(scope));
    },
    [currentDock, navigation],
  );

  const createFlow = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(false);
    setNewName('');
    try {
      const flow = new AgenticFlow({ name });
      await flow.save();
      if (flow.id) openFlow(flow.id);
    } catch (e) {
      console.error('create flow failed', e);
    }
  }, [newName, openFlow]);

  const sorted = useMemo(
    () => [...flows].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [flows],
  );

  const descriptor: NavigatorDescriptor = useMemo(
    () => ({
      id: 'agentic-flows',
      search: { recordTypes: [AgenticFlow.type], scope: urlScope, placeholder: 'Search flows…' },
      header: {
        title: 'Agentic Flows',
        countBadge: flows.length,
        headerRight: (
          <ScopeFilterIconBar
            scope={urlScope}
            currentProjectId={project?.id ?? null}
            currentProjectName={project?.getDisplayName() ?? project?.name ?? null}
            onScopeChange={handleScopeChange}
          />
        ),
        filterBar: (
          <div className="afl-nav-filter">
            {creating ? (
              <input
                autoFocus
                value={newName}
                placeholder="flow name…"
                onChange={(e) => setNewName(e.target.value)}
                onBlur={() => setCreating(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFlow();
                  if (e.key === 'Escape') setCreating(false);
                }}
              />
            ) : (
              <button className="afl-nav-new" onClick={() => setCreating(true)}>
                + New flow
              </button>
            )}
          </div>
        ),
      },
      customBody: (
        <div className="afl-nav-list">
          {sorted.map((f) => {
            const active = activePointer === `${AgenticFlow.type}-${f.id}`;
            return (
              <button
                key={f.id}
                className={`afl-nav-row ${active ? 'on' : ''}`}
                onClick={() => f.id && openFlow(f.id)}
                title={f.description || f.name}
              >
                <span className={`dot ${f.enabled ? 'ok' : ''}`} />
                <span className="name">{f.name || '(unnamed flow)'}</span>
                {(f as { scope?: string }).scope === 'system' && <span className="sys">sys</span>}
              </button>
            );
          })}
          {!sorted.length && <div className="afl-note" style={{ padding: 12 }}>No flows yet.</div>}
        </div>
      ),
    }),
    [flows.length, sorted, urlScope, project, handleScopeChange, creating, newName, createFlow, activePointer, openFlow],
  );

  return <NavigatorPanel descriptor={descriptor} />;
}
