import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useBackendText } from '@src/components/assets/editor/wizard/wizard-texts';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';

/**
 * Everything a wizard run needs from a person, asked ONCE — before the run starts — instead of
 * one question at a time while it works. Wherever a question is drawn (`AskForm`, `AskModal`,
 * `AskView`), a question that carries `items` is drawn as this list.
 *
 * A row is an approval (a tick, on by default) or one typed value, with what it is and what it is
 * for. The answer is `{item path: its value}`; a row left unticked or empty is left out, which
 * declines it. Declining a REQUIRED row is allowed — it is the person's machine — but it is said,
 * on the row, before they send: the run will end unfinished.
 */

export interface AskItem {
  /** The asking step, from the top wizard down — what its answer is keyed by. */
  path: string;
  prompt: string;
  detail?: string;
  /** The answer's declared kind: `confirm` is an approval, anything else one typed value. */
  kind?: string | null;
  secret?: boolean;
  required?: boolean;
}

const isApproval = (item: AskItem) => item.kind === 'confirm';

export function AskItems({
  items,
  busy,
  onAnswer,
  onCancel,
}: {
  items: AskItem[];
  busy?: boolean;
  onAnswer: (value: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const bt = useBackendText();
  // What the person changed: an approval starts ticked, a value starts empty.
  const [declined, setDeclined] = useState<Record<string, boolean>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  /** The item's answer, or `undefined` when it is left out. */
  const valueOf = (item: AskItem): unknown => {
    if (isApproval(item)) return declined[item.path] ? undefined : {};
    return (typed[item.path] ?? '').trim() || undefined;
  };

  const submit = () =>
    onAnswer(
      Object.fromEntries(items.map((item) => [item.path, valueOf(item)]).filter(([, value]) => value !== undefined)),
    );

  return (
    <div className="flex flex-col gap-3" data-testid="ask-items">
      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const missing = Boolean(item.required) && valueOf(item) === undefined;
          const id = `ask-item-${item.path}`;
          return (
            <li
              key={item.path}
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-3',
                missing && 'border-destructive/60 bg-destructive/10',
              )}
              data-testid={id}
              data-missing={missing ? 'true' : undefined}
            >
              <div className="flex items-start gap-2">
                {isApproval(item) ? (
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={!declined[item.path]}
                    disabled={busy}
                    onCheckedChange={(checked) => setDeclined((prev) => ({ ...prev, [item.path]: checked !== true }))}
                    data-testid={`${id}-tick`}
                  />
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <label className="flex flex-wrap items-center gap-2 text-sm font-medium" htmlFor={id}>
                    <span>{bt(item.prompt)}</span>
                    {item.required ? (
                      <Badge variant="outline" data-testid={`${id}-required`}>
                        <Trans>Required</Trans>
                      </Badge>
                    ) : null}
                  </label>
                  {item.detail ? <p className="text-sm text-muted-foreground">{bt(item.detail)}</p> : null}
                </div>
              </div>
              {isApproval(item) ? null : (
                <Input
                  id={id}
                  type={item.secret ? 'password' : 'text'}
                  autoComplete={item.secret ? 'off' : undefined}
                  disabled={busy}
                  value={typed[item.path] ?? ''}
                  onChange={(e) => setTyped((prev) => ({ ...prev, [item.path]: e.target.value }))}
                  data-testid={`${id}-input`}
                />
              )}
              {missing ? (
                <p className="text-sm text-foreground" data-testid={`${id}-warning`}>
                  <Trans>This one is required. Without it, setup will end unfinished.</Trans>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel} data-testid="ask-items-cancel">
          <Trans>Cancel</Trans>
        </Button>
        <Button disabled={busy} onClick={submit} data-testid="ask-items-submit">
          <Trans>Approve and continue</Trans>
        </Button>
      </div>
    </div>
  );
}
