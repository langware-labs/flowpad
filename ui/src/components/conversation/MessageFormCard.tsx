import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ClipboardList } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import {
  FORM_EDIT_EVENT,
  initialValues,
  leftToFill,
  submitFormAnswers,
  type AnswersEntry,
  type FormField,
  type FormValue,
  type MessageForm,
} from './message-form';

const BOX = 'mt-2 max-w-[640px] rounded-lg border border-border bg-muted/30 p-3 text-sm';
const INPUT =
  'w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-70';
const PILL =
  'rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const pill = (on: boolean) =>
  cn(PILL, on ? 'border-primary bg-primary/15 text-foreground' : 'border-border bg-background hover:bg-muted');
const BADGE = 'ms-1.5 inline-block rounded-full px-1.5 py-px text-[10px] leading-4';

interface MessageFormCardProps {
  form: MessageForm;
  messageId: string;
  conversationId: string;
  /** I sent it — I see it read-only until it is answered. */
  isMine: boolean;
  /** Its answers, oldest → newest. */
  answers: AnswersEntry[];
  /** Who answers it (the sender's view) / who asked (the receiver's view). */
  otherName: string;
}

/** A form inside a message: every field pre-filled with the sender's default or left to fill,
 *  one Submit that posts the answers as a reply. Once answered it closes to one line; the
 *  receiver reopens it from "Change answers" on their answers card. */
export function MessageFormCard({ form, messageId, conversationId, isMine, answers, otherName }: MessageFormCardProps) {
  const { t } = useLingui();
  const latest = answers.at(-1) ?? null;
  const [editing, setEditing] = useState(false);
  // Re-seed only when the answer it opens from changes — the thread refreshes rebuild `form` and
  // `answers` as new objects, and re-seeding on identity wiped what the person was typing.
  const latestId = latest?.messageId ?? '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const opened = useMemo(() => initialValues(form, latest?.answers ?? null), [form.form_id, latestId]);
  const [values, setValues] = useState<Record<string, FormValue>>(opened);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => setValues(opened), [opened]);
  // After a send the big form collapses to one line; keep it on screen, or the thread is left
  // scrolled past its content (blank until the person scrolls).
  const rootRef = useRef<HTMLDivElement>(null);
  const sentRef = useRef(false);
  useEffect(() => {
    if (!sentRef.current || !latestId) return;
    sentRef.current = false;
    rootRef.current?.scrollIntoView({ block: 'nearest' });
  }, [latestId]);
  useEffect(() => {
    const open = (e: Event) => {
      if ((e as CustomEvent<string>).detail === form.form_id && !isMine) {
        setValues(opened);
        setEditing(true);
      }
    };
    window.addEventListener(FORM_EDIT_EVENT, open);
    return () => window.removeEventListener(FORM_EDIT_EVENT, open);
  }, [form.form_id, isMine, opened]);

  if (latest && !editing) {
    const time = latest.at ? new Date(latest.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const who = isMine ? otherName : t`you`;
    return (
      <div
        ref={rootRef}
        className="mt-2 flex max-w-[640px] items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm"
        data-testid="message-form-closed"
      >
        <ClipboardList className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{form.title}</span>
        <span className="text-xs text-muted-foreground">
          · <Check className="inline h-3 w-3 text-emerald-500" /> {t`answered by ${who}`}
          {time ? ` · ${time}` : ''}
        </span>
      </div>
    );
  }

  const readOnly = isMine;
  const missing = leftToFill(form, values);
  const toFill = form.fields.filter((f) => f.default == null && !f.optional).length;
  const set = (id: string, v: FormValue | undefined) =>
    setValues((prev) => {
      const next = { ...prev };
      if (v === undefined) delete next[id];
      else next[id] = v;
      return next;
    });

  const submit = async () => {
    setSending(true);
    try {
      await submitFormAnswers(conversationId, messageId, values, files);
      sentRef.current = true;
      setEditing(false);
      setFiles([]);
    } catch (e) {
      notify.error({ title: t`Could not send your answers`, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  const badge = (f: FormField) => {
    const v = values[f.id];
    const base = editing ? latest?.answers.values[f.id] : f.default;
    if (f.default == null && !f.optional && (v === undefined || v === '' || (Array.isArray(v) && !v.length)))
      return <span className={cn(BADGE, 'bg-destructive/15 text-destructive')}>{t`No default — fill in`}</span>;
    if (base != null && JSON.stringify(v) !== JSON.stringify(base))
      return <span className={cn(BADGE, 'bg-amber-500/15 text-amber-600 dark:text-amber-400')}>{t`Changed`}</span>;
    if (!editing && f.default != null)
      return <span className={cn(BADGE, 'bg-primary/15 text-primary')}>{t`Default`}</span>;
    return null;
  };

  return (
    <div className={BOX} data-testid="message-form" data-form-id={form.form_id}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="flex items-center gap-1.5 font-semibold">
          <ClipboardList className="h-3.5 w-3.5" />
          {editing ? t`Change your answers` : form.title}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {editing
            ? t`reopened with what you sent`
            : toFill
              ? t`${form.fields.length - toFill} set by default · ${toFill} to fill`
              : t`all set by default`}
        </span>
      </div>
      {form.fields.map((f) => (
        <div
          key={f.id}
          className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-2 border-t border-border/50 py-1.5 first-of-type:border-t-0"
          data-testid={`form-field-${f.id}`}
          data-field-type={f.type}
        >
          <label className="pt-1 text-foreground/85" htmlFor={`${messageId}-${f.id}`} title={f.hint ?? undefined}>
            {f.label}
            {f.optional && <span className="ms-1 text-[10px] text-muted-foreground">{t`optional`}</span>}
          </label>
          <div className="flex flex-wrap items-center gap-1">
            <FieldControl
              field={f}
              id={`${messageId}-${f.id}`}
              value={values[f.id]}
              disabled={readOnly || sending}
              onChange={(v) => set(f.id, v)}
              onFile={(file) => {
                setFiles(file ? [file] : []);
                set(f.id, file ? file.name : undefined);
              }}
            />
            {!readOnly && badge(f)}
          </div>
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {readOnly ? (
          <span className="text-xs text-muted-foreground" data-testid="message-form-waiting">
            <Trans>Waiting for {otherName} to answer</Trans>
          </span>
        ) : (
          <>
            <button
              type="button"
              className="rounded-md bg-primary px-3.5 py-1.5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45"
              disabled={missing.length > 0 || sending}
              onClick={() => void submit()}
              data-testid="message-form-submit"
            >
              {editing ? t`Send updated answers` : t`Submit`}
            </button>
            {editing && (
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                onClick={() => setEditing(false)}
              >
                <Trans>Cancel</Trans>
              </button>
            )}
            <span
              className={cn('text-xs', missing.length ? 'text-destructive' : 'text-muted-foreground')}
              data-testid="message-form-status"
            >
              {missing.length
                ? t`${missing.length} left to fill: ${missing.join(', ')}`
                : editing
                  ? t`Sent as a new reply; the first stays in the thread.`
                  : t`Sends your answers to ${otherName} as a reply.`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function FieldControl({
  field: f,
  id,
  value,
  disabled,
  onChange,
  onFile,
}: {
  field: FormField;
  id: string;
  value: FormValue | undefined;
  disabled: boolean;
  onChange: (v: FormValue | undefined) => void;
  onFile: (f: File | null) => void;
}) {
  const { t } = useLingui();
  const options = f.options ?? [];
  switch (f.type) {
    case 'long_text':
      return (
        <textarea
          id={id}
          rows={2}
          className={INPUT}
          value={(value as string) ?? ''}
          disabled={disabled}
          placeholder={f.optional ? t`Optional` : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
    case 'number':
      return (
        <>
          <input
            id={id}
            type="number"
            className={cn(INPUT, 'w-24')}
            value={value === undefined ? '' : String(value)}
            min={f.min ?? undefined}
            max={f.max ?? undefined}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {(f.min != null || f.max != null) && (
            <span className="text-[11px] text-muted-foreground">
              {f.min ?? ''}–{f.max ?? ''}
            </span>
          )}
        </>
      );
    case 'date':
      return (
        <input
          id={id}
          type="date"
          className={cn(INPUT, 'w-40')}
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
    case 'yesno':
      return (
        <span className="inline-flex overflow-hidden rounded-md border border-border" role="radiogroup">
          {[true, false].map((b) => (
            <button
              key={String(b)}
              type="button"
              role="radio"
              aria-checked={value === b}
              disabled={disabled}
              className={cn(
                'px-3 py-1 text-xs',
                value === b ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
              )}
              onClick={() => onChange(b)}
            >
              {b ? t`Yes` : t`No`}
            </button>
          ))}
        </span>
      );
    case 'one':
    case 'buttons':
      return (
        <span className="flex flex-wrap gap-1" role="radiogroup">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={value === o}
              disabled={disabled}
              className={pill(value === o)}
              onClick={() => onChange(o)}
            >
              {f.type === 'one' ? (value === o ? '◉ ' : '◯ ') : ''}
              {o}
            </button>
          ))}
        </span>
      );
    case 'many': {
      const picked = Array.isArray(value) ? value : [];
      return (
        <span className="flex flex-wrap gap-1">
          {options.map((o) => {
            const on = picked.includes(o);
            return (
              <button
                key={o}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={disabled}
                className={pill(on)}
                onClick={() => onChange(on ? picked.filter((x) => x !== o) : options.filter((x) => x === o || picked.includes(x)))}
              >
                {on ? '☑ ' : '☐ '}
                {o}
              </button>
            );
          })}
        </span>
      );
    }
    case 'select':
      return (
        <select
          id={id}
          className={cn(INPUT, 'w-auto min-w-40')}
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">{t`Pick one`}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'file':
      return value ? (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs">
          {String(value)}
          {!disabled && (
            <button type="button" aria-label={t`Remove`} onClick={() => onFile(null)}>
              ✕
            </button>
          )}
        </span>
      ) : (
        <input
          id={id}
          type="file"
          disabled={disabled}
          className="text-xs text-muted-foreground file:me-2 file:rounded file:border file:border-border file:bg-background file:px-2 file:py-0.5"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      );
    default:
      return (
        <input
          id={id}
          type="text"
          className={INPUT}
          value={(value as string) ?? ''}
          disabled={disabled}
          placeholder={f.optional ? t`Optional` : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
  }
}
