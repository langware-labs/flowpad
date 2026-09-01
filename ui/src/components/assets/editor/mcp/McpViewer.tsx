import { useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { FSRef, isRemoteTransport, type Mcp } from '@sdk';
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
type McpSpecDoc = Pick<Mcp, 'name' | 'transport' | 'command' | 'args' | 'env' | 'url'>;

const TRANSPORTS = ['stdio', 'http', 'sse'] as const;
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
    </div>
  );
}

export function McpViewer({ fsRef, mcp }: { fsRef: FSRef; mcp: Mcp }) {
  const mainRef = fsRef.child(MAIN_FILE);
  const { doc, error, loading } = useJsonDoc<McpSpecDoc>(mainRef);

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
      {doc && <McpForm key={mainRef.path} initial={doc} mainRef={mainRef} mcp={mcp} />}
    </ReportAssetShell>
  );
}
