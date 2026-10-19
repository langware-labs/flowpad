import { ConnectionStatus, EnvVarType, type EntityEnvVars, type Project } from '@sdk';
import { deriveConnectionStatus, ENTITY_ENV_STALE_MS, entityEnvQueryKey, fetchEntityEnvTable } from '@sdk/react/hooks';
import { useQueries } from '@tanstack/react-query';

/**
 * Above this many projects the usage map stops loading on its own. One fetch per
 * project is cheap at hub/desktop scale (0-12) and buys a column that is correct
 * on arrival; at 50 projects it is a burst nobody asked for, so the cell offers
 * to load instead.
 */
export const USAGE_EAGER_LIMIT = 12;

/** Which projects use a credential: provider name → the projects attached to it. */
export type CredentialUsage = Record<string, Project[]>;

export interface UseCredentialUsageResult {
  /** provider name → attached projects. Empty until loaded. */
  usage: CredentialUsage;
  /** True while any project's table is in flight. */
  isLoading: boolean;
  /** False when there is nothing to fan out over, or the caller gated it. */
  isEnabled: boolean;
}

/**
 * "Where is this credential used?", derived on the client.
 *
 * Neither backend publishes the answer: the consent list (`allowed_to_use`) lives
 * on the user's credential row, and `merge_env_tables` emits only base rows, so
 * it never crosses the wire. What DOES cross is each project's own env table —
 * the same table the Status column is already derived from. So we ask every
 * project the question the table already answers for one, and invert the result.
 *
 * The queries deliberately reuse `entityEnvQueryKey` + `fetchEntityEnvTable`, so
 * each project's table is ONE cache entry shared with `useEntityEnv`,
 * `EnvVarsManager`, and the attach/detach invalidations. A parallel cache would
 * drift the moment somebody attached a credential.
 *
 * Cost is one fetch per project for the WHOLE table, not per provider: a single
 * project table answers for every row at once — and none at all when the user
 * holds no credential, since then there is nothing any project could be using.
 */
export function useCredentialUsage({
  projects,
  userTable,
  enabled = true,
}: {
  projects: Project[] | undefined;
  userTable: EntityEnvVars | undefined;
  enabled?: boolean;
}): UseCredentialUsageResult {
  const list = projects ?? [];
  // No grant, no usage: a user with a dozen projects and no connections would
  // otherwise pay a dozen fetches to populate a column of em-dashes.
  const holdsAnyCredential = !!userTable?.values.some(
    (v) => v.var_type === EnvVarType.OAUTH_PROVIDER_ID && !!v.ref_name,
  );
  const isEnabled = enabled && holdsAnyCredential && list.length > 0;

  // `combine` runs inside react-query, which memoises it against the results —
  // so the map is rebuilt once per settled query rather than on every render of
  // the table, and callers get a stable object. Doing it in a `useMemo` here
  // needed a variable-length dep array (`[...tables]`) and an eslint suppression
  // to say the same thing less safely.
  return useQueries({
    queries: list.map((project) => ({
      queryKey: entityEnvQueryKey(project.typeId),
      queryFn: () => fetchEntityEnvTable(project.typeId),
      enabled: isEnabled,
      staleTime: ENTITY_ENV_STALE_MS,
    })),
    combine: (results) => {
      const usage: CredentialUsage = {};
      for (const provider of userTable?.values ?? []) {
        if (!provider.name) continue;
        const attached: Project[] = [];
        results.forEach((result, i) => {
          // One predicate for "this project uses it", shared with the Status
          // column. A second implementation here is how the two would disagree.
          if (
            userTable &&
            result.data &&
            deriveConnectionStatus(provider.name, userTable, result.data) === ConnectionStatus.CONNECTED
          ) {
            attached.push(list[i]);
          }
        });
        usage[provider.name] = attached;
      }
      return { usage, isLoading: results.some((r) => r.isLoading), isEnabled };
    },
  });
}
