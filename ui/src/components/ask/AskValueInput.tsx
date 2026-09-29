import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { FileUp } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';

/** A picked file's content, through `FileReader` — `Blob.text()` is missing from older webviews. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * The one field a question's value is typed into — wherever the question is drawn (`AskForm`,
 * `AskModal`, `AskView`).
 *
 * A text answer is a line, masked when it is a secret. A FILE answer (a key file: a service-account
 * JSON) is picked from disk — or pasted — and its content is the answer; the content is never shown
 * back, only its name and size.
 */
export function AskValueInput({
  id,
  testId,
  secret,
  file,
  value,
  onChange,
  onEnter,
}: {
  id: string;
  testId: string;
  secret?: boolean;
  file?: boolean;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
}) {
  const { t } = useLingui();
  const [picked, setPicked] = useState('');
  const [pasting, setPasting] = useState(false);

  if (!file) {
    return (
      <Input
        id={id}
        data-testid={testId}
        autoFocus
        type={secret ? 'password' : 'text'}
        autoComplete={secret ? 'off' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`${testId}-file`}>
      <div className="flex items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border px-3 py-1.5 text-sm hover:bg-muted">
          <FileUp className="size-4" />
          <Trans>Choose file</Trans>
          <input
            id={id}
            type="file"
            className="sr-only"
            data-testid={testId}
            onChange={async (e) => {
              const chosen = e.target.files?.[0];
              if (!chosen) return;
              onChange(await readText(chosen));
              setPicked(`${chosen.name} · ${Math.max(1, Math.round(chosen.size / 1024))} KB`);
              setPasting(false);
            }}
          />
        </label>
        <Button variant="ghost" size="sm" onClick={() => setPasting((on) => !on)} data-testid={`${testId}-paste`}>
          {pasting ? t`Choose a file instead` : t`Paste instead`}
        </Button>
      </div>
      {picked && !pasting ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-picked`}>
          {picked}
        </p>
      ) : null}
      {pasting ? (
        <textarea
          aria-label={t`File content`}
          data-testid={`${testId}-text`}
          className="min-h-28 rounded border bg-background p-2 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
          // Masked like a password field: the content is a secret, and a screen share must not show it.
          style={secret ? ({ WebkitTextSecurity: 'disc' } as React.CSSProperties) : undefined}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setPicked('');
          }}
        />
      ) : null}
    </div>
  );
}
