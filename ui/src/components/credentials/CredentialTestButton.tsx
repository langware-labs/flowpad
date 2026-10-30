import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckCircle2, FlaskConical, Loader2, XCircle } from 'lucide-react';
import {
  AgenticProcess,
  Credential,
  credentialsService,
  ProcessKind,
  QueryFilter,
  QueryRequest,
  Skill,
  TypeId,
  type CredentialTestResult,
} from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { Button } from '@src/components/ui/button';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { describeApiError } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';

/** The skill the worker follows when a credential has no test yet (`cred-scan test <name>`). */
const TEST_SKILL = 'cred-scan';

/** The worker's first instruction: write the test, prove it once. */
export function testWorkerPrompt(name: string, title: string, projectId?: string | null): string {
  const project = projectId ? ` --project ${projectId}` : '';
  return (
    `Use the ${TEST_SKILL} skill: \`${TEST_SKILL} test ${name}\`. The credential "${title}" (${name}) has no test. ` +
    `Find the provider's cheapest read-only authenticated request, write it as the credential's \`test\`, ` +
    `run \`flow credentials test ${name}${project}\` and tell me the result in two lines. Never print or quote a value.`
  );
}

/** The one open test worker drawer — kept outside the rows, so a refresh that re-renders them never closes it. */
interface TestDrawer {
  typeid: string;
  title: string;
  projectId: string | null;
  workdir: string | null;
  autoPrompt: { text: string; nonce: number };
}
let openDrawer: TestDrawer | null = null;
const listeners = new Set<() => void>();
function setDrawer(next: TestDrawer | null) {
  openDrawer = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Where the test worker's chat shows: a panel on the end edge, over the page. Mounted ONCE per page that has
 * Test buttons (the Connections table, a credential's page) — outside any row.
 */
export function CredentialTestDrawer() {
  const { t } = useLingui();
  const drawer = useSyncExternalStore(subscribe, () => openDrawer);
  const skillQuery = useMemo(
    () =>
      new QueryRequest({
        type: Skill.type,
        scope: [],
        name: `skill:${TEST_SKILL}`,
        query: new QueryFilter({ match: { name: TEST_SKILL } }),
      }),
    [],
  );
  const { data: skills } = useEntitiesQuery<Skill>(skillQuery, { enabled: !!drawer });
  const skillPath = skills?.[0]?.asset_ref ?? null;
  if (!drawer) return null;
  return createPortal(
    <div className="fixed inset-y-0 end-0 z-40 flex shadow-2xl" data-testid="credential-test-drawer-host">
      <SideDrawer
        open
        onOpenChange={(open) => !open && setDrawer(null)}
        title={t`Test ${drawer.title}`}
        width="w-[380px]"
        data-testid="credential-test-drawer"
      >
        <EntityExecutionPanel
          className="h-full"
          target={drawer.typeid}
          processType={ProcessKind.Analysis}
          autoPrompt={skills ? drawer.autoPrompt : null}
          defaultProjectId={drawer.projectId}
          defaultWorkdir={drawer.workdir}
          dense
          placeholder={t`Answer or ask the agent…`}
          emptyStateText={t`The agent writes this credential's test.`}
          pastSessionsLabel={t`Past test runs`}
          noPastSessionsLabel={t`No test runs yet`}
          newSessionLabel={t`New test run`}
          historyLabel={t`Test runs`}
          onProcessCreated={async (p: AgenticProcess) => {
            if (!skillPath) return;
            try {
              await p.loadEmbeddedSkill(skillPath);
            } catch (err) {
              console.error('[CredentialTestDrawer] loadEmbeddedSkill failed', err);
            }
          }}
        />
      </SideDrawer>
    </div>,
    document.body,
  );
}

/**
 * Test — are this credential's values GOOD, not only present. Fast lane: the credential declares a `test`,
 * run it here (`credentialsService.test`). Slow lane: it declares none, so a context worker opens beside the
 * credential (a chat both ways, like a conversation's) to write one and prove it; the worker's own
 * `flow credentials test` records the answer on the credential row, which this watches — so the result
 * shows the moment it lands, and the next press is the fast lane.
 */
export function CredentialTestButton({
  typeid,
  name,
  title,
  projectId,
  workdir,
  hasTest,
  result,
  onChanged,
  size = 'sm',
  testId,
}: {
  typeid: string;
  name: string;
  title: string;
  projectId: string | null;
  /** The project folder the worker runs in. */
  workdir?: string | null;
  hasTest: boolean;
  result?: CredentialTestResult | null;
  onChanged: () => Promise<void> | void;
  size?: 'sm' | 'xs';
  testId?: string;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  // The row the worker's `flow credentials test` writes its answer onto: a new answer refreshes the page.
  const typeId = useMemo(() => {
    try {
      return new TypeId(typeid);
    } catch {
      return null; // a row without a real id has nothing to watch
    }
  }, [typeid]);
  const { data: watched } = useEntity<Credential>(typeId, { watch: true });
  const seenAt = useRef(result?.at ?? '');
  const landedAt = watched?.test_result?.at ?? '';
  useEffect(() => {
    if (!landedAt || landedAt === seenAt.current) return;
    seenAt.current = landedAt;
    void onChanged();
  }, [landedAt, onChanged]);

  const runFast = async () => {
    if (!projectId && !name) return;
    setBusy(true);
    try {
      const answer = await credentialsService.test(name, projectId ?? '');
      seenAt.current = answer.at;
      if (answer.state === 'ok') notify.success({ title: t`${title}: the provider took the key` });
      else if (answer.state === 'invalid') notify.error({ title: t`${title}: key rejected`, message: answer.detail });
      else notify.error({ title: t`${title}: the test could not run`, message: answer.detail });
      await onChanged();
    } catch (error) {
      notify.error({ title: t`Could not test ${title}`, message: describeApiError(error, t`The test did not run.`).message });
    } finally {
      setBusy(false);
    }
  };

  const press = () => {
    if (hasTest) {
      void runFast();
      return;
    }
    if (openDrawer?.typeid === typeid) return; // its worker is already open
    setDrawer({ typeid, title, projectId, workdir: workdir ?? null, autoPrompt: { text: testWorkerPrompt(name, title, projectId), nonce: Date.now() } });
  };

  const state = result?.state;
  const Verdict = busy ? Loader2 : state === 'ok' ? CheckCircle2 : state === 'invalid' || state === 'error' ? XCircle : FlaskConical;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={cn(size === 'xs' ? 'h-7' : 'h-8', 'gap-1')}
        disabled={busy}
        onClick={press}
        title={
          state === 'ok'
            ? t`The provider took the key (${result?.at})`
            : state
              ? result?.detail || state
              : hasTest
                ? t`Run this credential's test`
                : t`No test yet — an agent writes one`
        }
        data-testid={testId ?? `credential-test-${name}`}
        data-test-state={state ?? (hasTest ? 'untested' : 'none')}
      >
        <Verdict
          className={cn(
            'h-3.5 w-3.5',
            busy && 'animate-spin',
            state === 'ok' && 'text-emerald-600',
            (state === 'invalid' || state === 'error') && 'text-destructive',
          )}
        />
        <Trans>Test</Trans>
      </Button>
    </>
  );
}
