import { type ReactNode, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type ChannelRouteTarget,
  type InboundApi,
  type InboundClaim,
  InboundWebhooks,
  accountChainBody,
  linkChainBody,
} from '@sdk';
import { Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';
import { DestinationPicker } from './DestinationPicker';
import { type DestinationOption, INBOUND_PROVIDERS, type InboundProvider, PROVIDER_TITLE } from './inbound-model';
import { errorText } from './use-inbound';

type Step = 'choose' | 'link' | 'own' | 'connected';
/** `meta`: the number in the caller's own Meta app; `generic`: any server speaking Meta's API (its own graph URL). */
type Route = 'meta' | 'generic';

/** How often a pending claim (a code waiting to be sent, a URL waiting for its first delivery) is re-read. */
const WAIT_POLL_MS = 3000;

/**
 * Connect a number or bot: through Flowpad's own number (a code proves the caller's phone), or the caller's own
 * number — at Meta, or on any server that speaks Meta's API. The hub proves the number and answers its URL.
 */
export function ConnectNumberDialog({
  open,
  onOpenChange,
  optionsFor,
  onDone,
  api = InboundWebhooks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where a number of `provider` can send what no rule matches (no "default": a number has no parent place).
   *  On a desktop the first "This computer" place is preselected. */
  optionsFor: (provider: string) => DestinationOption[];
  onDone: () => void;
  api?: InboundApi;
}) {
  const { t } = useLingui();
  const [step, setStep] = useState<Step>('choose');
  const [provider, setProvider] = useState<InboundProvider>('whatsapp');
  const [route, setRoute] = useState<Route>('generic');
  const [phoneId, setPhoneId] = useState('');
  const [token, setToken] = useState('');
  const [graphUrl, setGraphUrl] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [fallback, setFallback] = useState<ChannelRouteTarget | null>(null);
  const [made, setMade] = useState<InboundClaim | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setMade(null);
    setError(null);
    setPhoneId('');
    setToken('');
    setGraphUrl('');
    setAppSecret('');
    setVerifyToken('');
  }, [open]);

  const options = optionsFor(provider);
  useEffect(() => {
    if (open) setFallback(options.find((o) => o.target.kind === 'desktop')?.target ?? null);
    // Re-preselect when the vendor (and so its channels) changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider, options.length]);

  // A pending code until the sender proves it; a fresh URL until its first signed delivery.
  const waiting = !!made && (made.status === 'pending' || (step === 'connected' && !made.deliveries));
  const madeId = made?.id;
  useEffect(() => {
    if (!open || !madeId || !waiting) return;
    const tick = async () => {
      try {
        const now = (await api.mine()).find((c) => c.id === madeId);
        if (now)
          setMade((prev) => ({ ...now, code: now.code || prev?.code, deep_link: now.deep_link || prev?.deep_link }));
      } catch {
        // the hub will answer on the next tick
      }
    };
    const timer = setInterval(() => void tick(), WAIT_POLL_MS);
    return () => clearInterval(timer);
  }, [open, madeId, waiting, api]);

  const close = (next: boolean) => {
    if (!next && made) onDone();
    onOpenChange(next);
  };

  const run = async (body: Parameters<InboundApi['chain']>[0], next: Step) => {
    setBusy(true);
    setError(null);
    try {
      setMade(await api.chain(body));
      setStep(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const linkAgent = () => void run(linkChainBody(provider, fallback ?? undefined), 'link');
  const connectOwn = () =>
    void run(
      accountChainBody({
        provider,
        phoneNumberId: phoneId,
        credential: token,
        appSecret,
        verifyToken,
        graphUrl: route === 'generic' ? graphUrl : '',
        target: fallback ?? undefined,
      }),
      'connected',
    );

  const title = PROVIDER_TITLE[provider];
  const ownReady = !!phoneId.trim() && !!token.trim() && (route === 'meta' || !!graphUrl.trim());

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        data-testid="inbound-connect-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-base font-normal text-muted-foreground">
            <Trans>Connect a number</Trans> ›{' '}
            <b className="text-foreground">
              {step === 'link'
                ? t`${title} › Flowpad's number`
                : step === 'own'
                  ? t`${title} › Your own number`
                  : step === 'connected'
                    ? t`${title} › Connected`
                    : title}
            </b>
          </DialogTitle>
        </DialogHeader>

        {step === 'choose' && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex gap-2">
              {INBOUND_PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  data-testid={`inbound-provider-${p}`}
                  onClick={() => setProvider(p)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    provider === p ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {PROVIDER_TITLE[p]}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground">
              <Trans>How do messages reach the hub?</Trans>
            </p>
            <Choice
              testId="inbound-choice-agent"
              title={t`Flowpad agent`}
              detail={t`Message Flowpad's own ${title} account. Nothing to set up — link your phone once with a code.`}
              onClick={linkAgent}
              disabled={busy}
            />
            {provider === 'whatsapp' && (
              <>
                <Choice
                  testId="inbound-choice-meta"
                  title={t`Meta official Cloud API`}
                  detail={t`Your business number in your own Meta app. Meta calls the hub's webhook URL.`}
                  onClick={() => {
                    setRoute('meta');
                    setStep('own');
                  }}
                />
                <Choice
                  testId="inbound-choice-generic"
                  title={t`Generic Meta-API webhook`}
                  detail={t`Any server that speaks Meta's WhatsApp API and webhook format. The hub proves the number on that server and replies through it.`}
                  onClick={() => {
                    setRoute('generic');
                    setStep('own');
                  }}
                />
              </>
            )}
          </div>
        )}

        {step === 'own' && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="space-y-1 rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
              <div className="text-sm font-medium text-foreground">
                <Trans>What happens</Trans>
              </div>
              <div>
                <Trans>
                  1. The hub proves the number is yours: it asks your server for this phone number ID using the access
                  token. Only an answer naming the same ID passes.
                </Trans>
              </div>
              <div>
                <Trans>
                  2. You get a webhook URL. Your server sends every message there, signed with the app secret — unsigned
                  messages are refused.
                </Trans>
              </div>
              <div>
                <Trans>
                  3. Each message goes to the rule that matches it, or to the fallback below. Replies go out through
                  your server with the same token.
                </Trans>
              </div>
              <div>
                <Trans>Secrets are stored write-only on the hub — nobody can read them back.</Trans>
              </div>
            </div>
            <Field
              testId="inbound-field-phone-id"
              label={t`Phone number ID`}
              value={phoneId}
              onChange={setPhoneId}
              hint={t`The id Meta's API uses for the number (not the phone number itself).`}
            />
            <Field
              testId="inbound-field-token"
              label={t`Access token`}
              value={token}
              onChange={setToken}
              secret
              hint={t`Proves the number: the hub calls GET <server>/<phone number id> with it. Stored write-only.`}
            />
            {route === 'generic' && (
              <Field
                testId="inbound-field-graph-url"
                label={t`Graph server`}
                value={graphUrl}
                onChange={setGraphUrl}
                placeholder="https://graph.example.com/v23.0"
                hint={t`Where your server answers Meta's API. https only.`}
              />
            )}
            <Field
              testId="inbound-field-app-secret"
              label={t`App secret`}
              value={appSecret}
              onChange={setAppSecret}
              secret
              hint={t`Signs every delivery (x-hub-signature-256). Stored write-only.`}
            />
            <Field
              testId="inbound-field-verify-token"
              label={t`Verify token`}
              value={verifyToken}
              onChange={setVerifyToken}
              hint={t`A word you choose. When you save the webhook URL on your server, it calls the URL once with this word; the hub answers only if it matches — proof the URL is yours.`}
            />
            <div className="font-medium">
              <Trans>Fallback — everything no rule matches goes to</Trans>
            </div>
            <DestinationPicker options={options} value={fallback} onChange={setFallback} />
          </div>
        )}

        {step === 'link' && made && (
          <div className="flex flex-col gap-3 text-sm" data-testid="inbound-link-step">
            <p>
              <Trans>Send this from your phone to Flowpad's {title} account:</Trans>
            </p>
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <div className="font-mono text-3xl font-bold" data-testid="inbound-link-code">
                {made.code}
              </div>
              {made.deep_link && (
                <a
                  href={made.deep_link}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block text-xs text-muted-foreground underline"
                >
                  <Trans>or open the link on your phone</Trans>
                </a>
              )}
            </div>
            <StatusPill waiting={made.status === 'pending'}>
              {made.status === 'pending' ? <Trans>waiting for your message…</Trans> : <Trans>linked</Trans>}
            </StatusPill>
          </div>
        )}

        {step === 'connected' && made && (
          <div className="flex flex-col gap-3 text-sm" data-testid="inbound-connected-step">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500">
                <Trans>number proven</Trans>
              </span>
              <span className="text-muted-foreground">
                <Trans>the token acts as {made.claim?.key}</Trans>
              </span>
            </div>
            <p>
              <Trans>Now send your messages to the hub. Paste these into your server's webhook settings:</Trans>
            </p>
            <CopyRow testId="inbound-connected-url" value={made.url} />
            {verifyToken.trim() && <CopyRow testId="inbound-connected-verify-token" value={verifyToken.trim()} />}
            <p className="text-xs text-muted-foreground">
              <Trans>
                Verify token: when you save the URL, your server calls it once with this word and the hub echoes back a
                challenge only if the word matches. It proves you own the URL; it is not a password for messages — those
                are checked with the app secret.
              </Trans>
            </p>
            <StatusPill waiting={!made.deliveries}>
              {made.deliveries ? (
                <Trans>first delivery received</Trans>
              ) : (
                <Trans>waiting for the first signed delivery…</Trans>
              )}
            </StatusPill>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" data-testid="inbound-connect-error">
            {error}
          </p>
        )}

        <DialogFooter>
          {step === 'choose' && (
            <Button variant="ghost" onClick={() => close(false)}>
              <Trans>Cancel</Trans>
            </Button>
          )}
          {step === 'own' && (
            <>
              <Button variant="ghost" onClick={() => setStep('choose')}>
                <Trans>Back</Trans>
              </Button>
              <Button data-testid="inbound-connect-submit" disabled={!ownReady || busy} onClick={connectOwn}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                <Trans>Prove and connect</Trans>
              </Button>
            </>
          )}
          {(step === 'link' || step === 'connected') && (
            <Button data-testid="inbound-connect-done" onClick={() => close(false)}>
              <Trans>Done</Trans>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Choice({
  title,
  detail,
  onClick,
  testId,
  disabled,
}: {
  title: string;
  detail: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-xl border border-border bg-card p-4 text-start hover:bg-accent disabled:opacity-60"
    >
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  placeholder,
  secret,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  secret?: boolean;
  testId: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      <Input
        data-testid={testId}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function CopyRow({ value, testId }: { value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-3 font-mono text-xs">
      <span className="truncate" data-testid={testId}>
        {value}
      </span>
      <CopyButton value={value} testId={`${testId}-copy`} />
    </div>
  );
}

function StatusPill({ waiting, children }: { waiting: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium',
          waiting ? 'bg-amber-500/15 text-amber-500' : 'bg-emerald-500/15 text-emerald-500',
        )}
      >
        {children}
      </span>
    </div>
  );
}
