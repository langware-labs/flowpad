import { useCallback, useEffect, useMemo, useRef } from 'react';
import { CredentialSpec, QueryRequest, type Project } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useProjectSecretOrigins } from '@src/hooks/use-project-secret-origins';
import { useProjectEnvLocal } from '@src/hooks/use-project-env-local';
import { buildCredentialRows, type CredentialRow } from '@src/components/credentials-view/credential-rows';

/**
 * The installed credential definitions.
 *
 * Global by construction (`scope: []`) for the same reason `DataSourceSpec` is:
 * a definition is a property of the instance, not of a project, and switching
 * project must not change which providers exist. This is what replaces a
 * hardcoded provider catalog — adding one is an asset, not a frontend release.
 */
const credentialSpecsQuery = new QueryRequest({
  type: CredentialSpec.type,
  scope: [],
  name: 'connections:credential-specs',
});

/**
 * A credential's variables as declaration payloads.
 *
 * Shared by the explicit "add" and by auto-adoption so the two can never
 * declare the same credential differently.
 *
 * The definition's store is a DEFAULT; the declaration owns the real choice and
 * can be repointed later. Asking the SPEC rather than assuming `.env.local` is
 * what lets an LLM provider key land in the encrypted store under the name the
 * funding resolver reads (`lm_api.<provider>`) instead of in a file it never
 * consults.
 */
function pointersFor(spec: CredentialSpec) {
  return spec.varNames.map((envVar) => ({
    name: envVar,
    envVar,
    locator: spec.locatorFor(envVar),
    sodStore: spec.sodStore,
    scope: 'private' as const,
    description: spec.vars?.[envVar]?.label || undefined,
  }));
}

/** Stable while loading — a fresh `[]` per render would churn the memo below. */
const NO_SPECS: CredentialSpec[] = [];

/**
 * The credential half of the Connections table.
 *
 * Reads the two project actions the fold needs and nothing else: the merge
 * itself lives in `credential-rows.ts`, which is pure and tested. A backend
 * `credential-status` action would have duplicated the
 * `env-local ∪ sodot ∪ driver` union that `_where_is_secret_value` already
 * owns, and the two would have drifted.
 *
 * Both inputs matter. `secret-resolve-status` only knows DECLARATIONS, so a
 * value sitting undeclared in `.env.local` is invisible to it — folding on that
 * alone reports "0 of 2" on a machine where both values are in the file.
 */
export function useCredentialConnections(project: Project | null | undefined) {
  const { data: specs = NO_SPECS } = useEntitiesQuery<CredentialSpec>(credentialSpecsQuery);
  const { secretOrigins, status, addMany, provide, removeMany } = useProjectSecretOrigins(project ?? null);
  // `useProjectEnvLocal` returns the already-unwrapped fields, not the raw
  // status object — `keys` is names + line numbers only, never a value.
  const { keys: envLocalKeys, blocked, blockReason } = useProjectEnvLocal(project ?? null);

  const rows: CredentialRow[] = useMemo(
    () => buildCredentialRows({ specs, secretOrigins, status, envLocalKeys }),
    [specs, secretOrigins, status, envLocalKeys],
  );

  /**
   * Declare every variable a credential is made of — in ONE call.
   *
   * Not a loop over `add`: each `add-secret-pointer` saves the whole project,
   * so N calls give N windows in which a write from a stale copy drops an
   * earlier link. That is not theoretical — declaring Gmail this way silently
   * unlinked a Twilio declared moments before, leaving its rows alive and the
   * project no longer pointing at them.
   */
  const declareCredential = useCallback(
    async (spec: CredentialSpec) => {
      await addMany(pointersFor(spec));
    },
    [addMany],
  );

  /**
   * A known credential whose every required variable is already in `.env.local`
   * IS connected — declaring it is our bookkeeping, not the user's chore. So
   * adopt it silently rather than showing an "Add" button for a key they can
   * already see in their own file.
   *
   * Two guards make this safe to do automatically:
   *
   * * **All-or-nothing.** Only when every REQUIRED member is present, so a
   *   stray `GMAIL_ADDRESS` on its own cannot conjure a Gmail connection.
   * * **Once per spec per mount** (`adopted`), because `declareCredential`
   *   refreshes resolve-status and would otherwise re-enter on the render it
   *   causes.
   *
   * This is deliberately an EFFECT, not part of the fold: `credential-rows.ts`
   * writes nothing on read, and that rule is what keeps it pure and testable.
   * `mint_for` is idempotent, so a repeat is an update in place, not a twin.
   */
  // Keyed by project: `ConnectionsManager` stays mounted while the project
  // selector changes underneath it, so a mount-wide set would silently skip
  // adoption for every project after the first.
  const adopted = useRef(new Set<string>());
  useEffect(() => {
    adopted.current = new Set<string>();
  }, [project?.id]);
  useEffect(() => {
    // Every emitted row already has all its required values present, so
    // "nothing declares it yet" is the whole test — the other clauses this
    // used to carry were tautologies under that invariant.
    const ready = rows.filter((r) => !r.adHoc && r.declaredCount === 0);
    const pending = ready.filter((r) => !adopted.current.has(r.key));
    if (!pending.length) return;
    pending.forEach((r) => adopted.current.add(r.key));

    // ONE call for every pending spec, not one per spec. Each declaration saves
    // the project, so a loop here would reopen the very lost-update window the
    // batch action was written to close — across credentials this time.
    void (async () => {
      const entries = pending.flatMap((row) => {
        const spec = specs.find((c) => String(c.name ?? '') === row.key);
        return spec ? pointersFor(spec) : [];
      });
      try {
        if (entries.length) await addMany(entries);
      } catch {
        // Let a failed adoption be retried rather than latching it off for the
        // life of the mount.
        pending.forEach((r) => adopted.current.delete(r.key));
      }
    })();
  }, [rows, specs, addMany]);

  /** The env vars already sitting in `.env.local` — names only, never values.
   *  The Add form asks for a variable only when this does not already have it. */
  const envLocalPresent = useMemo(
    () => new Set(envLocalKeys.map((k) => k.key)),
    [envLocalKeys],
  );

  /**
   * Stop declaring every variable of one credential.
   *
   * The declaration is the only thing the app can withdraw: `.env.local` is
   * append-only by policy, so the VALUE stays where the user put it and only
   * this project's pointer to it goes. Without this there is no way to
   * un-declare anything at all — the row would be permanent, and so would its
   * entry in the machine's attachable-secrets list.
   */
  const stopDeclaring = useCallback(
    async (row: CredentialRow) => {
      await removeMany(row.members.map((m) => m.typeid).filter((id): id is string => !!id));
    },
    [removeMany],
  );

  return {
    rows,
    specs,
    envLocalBlocked: blocked,
    envLocalBlockReason: blockReason,
    envLocalPresent,
    declareCredential,
    provide,
    stopDeclaring,
  };
}
