import { useCallback, useEffect, useMemo, useState } from 'react';
import { dataContext } from '@sdk';
import { credentialsService, Project, type Agent } from '@sdk';

import {
  projectCredentials,
  requiredCredentials,
  secretRows,
  type DeclaredCredential,
  type SecretRow,
} from './project-secrets';

export interface AgentSecrets {
  /** The agent's project, or null for an agent in no project (nothing to set then). */
  project: Project | null;
  /** The agent's required credentials; null until the first read lands. */
  rows: SecretRow[] | null;
  /** Variable names the project's hub store holds a value for. */
  setNames: Set<string>;
  reload: () => Promise<void>;
}

/**
 * The agent's project id. On the hub an agent row carries no `project_id`: its `git_origin` names the hosted repo,
 * resolved to the project the same way the page finds it (`Project.forHostedRepo`, see `load-asset.ts`).
 */
function useAgentProjectId(agent: Agent): string | null {
  const own = agent.project_id ?? null;
  const origin = (agent as { git_origin?: { kind?: string; repo?: string } | null }).git_origin;
  const repo = !own && !dataContext.caps.localFiles && origin?.kind === 'hub_repo' ? (origin.repo ?? null) : null;
  const [fromRepo, setFromRepo] = useState<string | null>(null);
  useEffect(() => {
    if (!repo) return;
    let alive = true;
    Project.forHostedRepo(repo)
      .then((p) => alive && setFromRepo(p?.id ?? null))
      .catch(() => alive && setFromRepo(null));
    return () => {
      alive = false;
    };
  }, [repo]);
  return own ?? (repo ? fromRepo : null);
}

/**
 * The agent's credentials joined with the project's Credentials and the project's hub store — names only.
 * The project's own declarations are read on this computer; the hub page cannot, so nothing reads as undeclared there.
 */
export function useAgentSecrets(agent: Agent): AgentSecrets {
  const projectId = useAgentProjectId(agent);
  const project = useMemo(() => (projectId ? new Project({ id: projectId }) : null), [projectId]);
  const required = useMemo(() => requiredCredentials(agent.requirements), [agent.requirements]);
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  const [setNames, setSetNames] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!project || required.length === 0) {
      setRows([]);
      return;
    }
    const [names, declared] = await Promise.all([
      project.secretNames().catch(() => [] as string[]),
      !dataContext.caps.localFiles
        ? Promise.resolve<DeclaredCredential[] | null>(null)
        : credentialsService
            .status(project.id)
            .then(projectCredentials)
            .catch(() => null),
    ]);
    setSetNames(new Set(names));
    setRows(secretRows(required, declared, names));
  }, [project, required]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { project, rows, setNames, reload };
}
