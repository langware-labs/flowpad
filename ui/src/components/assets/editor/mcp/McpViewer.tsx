import { useRef, useState } from 'react';
import { Check, CircleHelp, Loader2, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { FSRef, isRemoteTransport, type Mcp } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { ReportAssetShell } from '@src/components/assets/editor/ReportAssetShell';
import { useJsonDoc } from '@src/hooks/use-json-doc';

/** The on-disk shape — `McpSpec` (flow_sdk/schema/data_spec/mcp_spec.py). Taken
 *  off the entity so the two cannot drift; the row mirrors the file's fields. */
type McpSpecDoc = {
  [K in 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'entrypoint']-?: NonNullable<Mcp[K]>;
};

const TRANSPORTS = ['stdio', 'http', 'sse'] as const;

/** What `mcp.json` legitimately omits — it is written with
 *  `exclude_defaults=True`, so a server sitting on its defaults has no
 *  `transport`/`env`/`url` key at all and the reader supplies them. */
const DEFAULTS: McpSpecDoc = {
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  entrypoint: '',
};

/**
 * A spread, deliberately — NOT a field-by-field copy.
 *
 * The form writes the WHOLE document back on every commit, so any key it does
 * not carry is erased. A hand-listed normalizer is a second copy of the field
 * list that silently drops whatever it forgets: the first version omitted
 * `entrypoint`, so one edit to a bundled server deleted the very field that
 * made it bundled. Spreading `doc` last keeps every key the file had, known
 * to this form or not.
 */
export function withDefaults(doc: Partial<McpSpecDoc>): McpSpecDoc {
  return { ...DEFAULTS, ...doc };
}

interface TestResult {
  ok: boolean;
  tools: string[];
  detail: string;
}

/** Pass / fail / not-yet-run, following the connections-manager probe. */
function ProbeVerdict({ result }: { result?: TestResult }) {
  if (!result) return <CircleHelp className="h-3.5 w-3.5 text-muted-foreground/70" />;
  return result.ok ? (
    <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-500" />
  ) : (
    <X className="h-3.5 w-3.5 text-destructive" />
  );
}
const MAIN_FILE = 'mcp.json';

function Field({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="grid grid-cols-[7rem_1fr] items-center gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        // A keystroke-level write would rewrite mcp.json on every character.
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
      />
    </label>
  );
}

/**
 * The MCP asset form. Deliberately flat — an MCP server is six fields, and the
 * projector (`mcp_projection.py`) branches on transport exactly the same way,
 * so a richer model here would only have to be flattened again at four vendor
 * boundaries.
 *
 * `fsRef` is the FOLDER on both routing paths (`recordContentRef` normalizes the
 * typeid route), so the file is named here — the same move as DeckViewer and
 * WhiteboardAssetEditor.
 *
 * Writes the file rather than saving the entity, matching AgentProfileEditor:
 * the editor owns the document, and an entity save would round-trip through the
 * indexer to reach the same bytes.
 */
function McpForm({ initial, mainRef, mcp }: { initial: McpSpecDoc; mainRef: FSRef; mcp: Mcp }) {
  const { t } = useLingui();
  const [spec, setSpec] = useState(initial);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The authoritative in-memory document. `commit` merges onto THIS rather than
  // onto a render-captured `spec`, so two blurs inside one render tick compose
  // instead of the second dropping the first's field.
  const current = useRef(initial);
  // Whole-file writes still have to land in order.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [test, setTest] = useState<TestResult | undefined>();
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    setTesting(true);
    setTest(undefined);
    try {
      // Wait for any in-flight blur write: the backend probes the FILE, so
      // testing before the queue drains would probe the previous command.
      await queue.current.catch(() => undefined);
      setTest(await mcp.test());
    } catch (err) {
      setTest({ ok: false, tools: [], detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const commit = (patch: Partial<McpSpecDoc>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setSpec(next);
    setSaveError(null);
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => mainRef.write(`${JSON.stringify(next, null, 2)}\n`))
      .then(() => mcp.markEdit())
      .catch((err) => setSaveError(err instanceof Error ? err.message : String(err)));
  };

  const remote = isRemoteTransport(spec.transport, spec.url, spec.command);

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <Field
        label={t`Name`}
        value={spec.name}
        // A blank name fails McpSpec's NonBlank on the next index and the asset
        // drops out silently, so refuse it here rather than write it.
        onCommit={(v) => v.trim() && commit({ name: v.trim() })}
      />

      <label className="grid grid-cols-[7rem_1fr] items-center gap-3">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          <Trans>Transport</Trans>
        </span>
        <Select
          value={spec.transport}
          // Clear the branch that no longer applies: the projector drops it
          // anyway, and leaving it makes the file misdescribe the server.
          onValueChange={(value) =>
            commit(
              isRemoteTransport(value, spec.url, '')
                ? { transport: value, command: '', args: [] }
                : { transport: value, url: '' },
            )
          }
        >
          <SelectTrigger data-testid="mcp-transport">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSPORTS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {remote ? (
        <Field label={t`URL`} value={spec.url} onCommit={(v) => commit({ url: v })} />
      ) : (
        <>
          <Field label={t`Command`} value={spec.command} onCommit={(v) => commit({ command: v })} />
          <Field
            label={t`Args`}
            value={spec.args.join(' ')}
            placeholder={t`space separated`}
            onCommit={(v) => commit({ args: v.split(/\s+/).filter(Boolean) })}
          />
        </>
      )}

      {/* Read-only: this file travels with its agent over git, so a value typed
          here would be committed and shared. Declaring the variable as a project
          secret (SecretOrigin) is the supported path. */}
      <div className="grid grid-cols-[7rem_1fr] items-start gap-3">
        <span className="pt-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Trans>Env</Trans>
        </span>
        <div className="text-sm text-muted-foreground">
          {Object.keys(spec.env).length ? (
            Object.keys(spec.env).map((key) => (
              <div key={key} className="font-mono text-xs">
                {key}
              </div>
            ))
          ) : (
            <Trans>None</Trans>
          )}
        </div>
      </div>

      <p className="pt-2 text-xs text-muted-foreground">
        <Trans>
          MCP servers are read when a worker starts, so a running process keeps the set it launched
          with — restart it to pick this up.
        </Trans>
      </p>

      {saveError && (
        <p className="text-sm text-destructive" data-testid="mcp-save-error">
          <Trans>Failed to save: {saveError}</Trans>
        </p>
      )}

      <div className="flex items-center gap-3 border-t pt-3">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5"
          disabled={testing}
          data-testid="mcp-test"
          onClick={() => void runTest()}
          title={t`Start this server and list the tools it exposes`}
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ProbeVerdict result={test} />}
          <Trans>Test</Trans>
        </Button>
        {test && (
          <span
            className={test.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}
            data-testid="mcp-test-result"
          >
            {test.detail}
            {test.ok && test.tools.length > 0 && `: ${test.tools.join(', ')}`}
          </span>
        )}
      </div>
    </div>
  );
}

export function McpViewer({ fsRef, mcp }: { fsRef: FSRef; mcp: Mcp }) {
  const mainRef = fsRef.child(MAIN_FILE);
  const { doc, error, loading } = useJsonDoc<Partial<McpSpecDoc>>(mainRef);

  return (
    <ReportAssetShell
      fsRef={mainRef}
      name={doc?.name || mcp.name}
      testId="mcp-viewer"
      loading={loading}
      error={error}
    >
      {/* Keyed on the path so a different asset remounts with its own state
          rather than showing the previous one's fields. */}
      {doc && <McpForm key={mainRef.path} initial={withDefaults(doc)} mainRef={mainRef} mcp={mcp} />}
    </ReportAssetShell>
  );
}
