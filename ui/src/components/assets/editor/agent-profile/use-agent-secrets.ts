import { useCallback, useEffect, useMemo, useState } from 'react';
import { credentialsService, Project, type Agent } from '@sdk';
import { isHubOnly } from '@sdk/utils/hub-runtime';

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
 * The agent's credentials joined with the project's Credentials and the project's hub store — names only.
 * The project's own declarations are read on this computer; the hub page cannot, so nothing reads as undeclared there.
 */
export function useAgentSecrets(agent: Agent): AgentSecrets {
  const projectId = agent.project_id ?? null;
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
      isHubOnly()
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
