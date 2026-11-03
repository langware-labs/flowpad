import { type ReactNode, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type Agent,
  type ChannelRouteTarget,
  type InboundApi,
  type InboundClaim,
  InboundWebhooks,
  accountChainBody,
  isHubOnly,
  linkChainBody,
} from '@sdk';
import { Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { CopyButton } from '@src/components/ui/copy-button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';
import { Chip } from './Chip';
import { provisionMailboxOnHub } from './use-inbound-mailboxes';
import { useAllocateAgentMailbox } from '@src/hooks/use-allocate-agent-mailbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import {
  type DestinationOption,
  INBOUND_PROVIDERS,
  type InboundProvider,
  type OwnRoute,
  PROVIDER_TITLE,
  VENDOR,
} from './inbound-model';

type Step = 'choose' | 'link' | 'own' | 'connected' | 'email';

/** How often a pending claim (a code waiting to be sent, a URL waiting for its first delivery) is re-read. */
const WAIT_POLL_MS = 3000;

/** The own-account form: the account's key at the vendor, its credential, and how deliveries are signed. */
const EMPTY_FORM = { key: '', token: '', graphUrl: '', appSecret: '' };

/**
 * Connect a number or bot: through Flowpad's own account on the vendor (a code proves the caller's account), or the
 * caller's own account by one of the vendor's routes (`VENDOR`). The hub proves the account and answers its URL.
 */
export function ConnectNumberDialog({
  open,
  onOpenChange,
  optionsFor,
  agents,
  onDone,
  api = InboundWebhooks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where a number of `provider` can send what no rule matches (no "default": a number has no parent place).
   *  On a desktop the first "This computer" place is preselected. */
  optionsFor: (provider: string) => DestinationOption[];
  /** The person's own agents — whom an inbox can belong to (the screen already read them). */
  agents: Agent[];
  onDone: () => void;
  api?: InboundApi;
}) {
  const { t } = useLingui();
  const [step, setStep] = useState<Step>('choose');
  const [tab, setTab] = useState<InboundProvider | 'email'>('whatsapp');
  const email = tab === 'email';
  const provider: InboundProvider = email ? 'whatsapp' : tab;
  const [route, setRoute] = useState<OwnRoute | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const field = (name: keyof typeof EMPTY_FORM) => (value: string) => setForm((f) => ({ ...f, [name]: value }));
  const [fallback, setFallback] = useState<ChannelRouteTarget | null>(null);
  const [made, setMade] = useState<InboundClaim | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inbox, setInbox] = useState({ agentId: '', username: '', displayName: '' });
  const [verifyToken, setVerifyToken] = useState('');
  const allocateMailbox = useAllocateAgentMailbox();
  const inboxAgent = agents.find((a) => String(a.id) === inbox.agentId) ?? agents[0] ?? null;

  /** One inbox per agent, minted by the hub (billable, permanent). A desktop allocates through the one shared path
   *  (sign-in gate, the hub's "no agent email" answer); the hub page asks the hub directly. */
  const createInbox = async () => {
    if (!inboxAgent) return;
    const body = { username: inbox.username.trim() || undefined, display_name: inbox.displayName.trim() || undefined };
    setBusy(true);
    setError(null);
    try {
      if (isHubOnly()) await provisionMailboxOnHub(inboxAgent, body);
      else if (!(await allocateMailbox(inboxAgent, body))) return; // the hook already told the person why
      onDone();
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, String(e)));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setTab('whatsapp');
    setInbox({ agentId: '', username: '', displayName: '' });
    setVerifyToken('');
    setMade(null);
    setError(null);
    setForm(EMPTY_FORM);
  }, [open]);

  const options = optionsFor(provider);
  useEffect(() => {
    if (open) setFallback(options.find((o) => o.target.kind === 'desktop')?.target ?? null);
  }, [open, options]);

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
      setError(errorMessage(e, String(e)));
    } finally {
      setBusy(false);
    }
  };

  const linkAgent = () => void run(linkChainBody(provider, fallback ?? undefined), 'link');
  const connectOwn = () => {
    // The verify token is ours to invent: generated here, shown on the next step to paste beside the URL.
    const token = route?.verifyToken ? verifyToken || newVerifyToken() : '';
    setVerifyToken(token);
    void run(
      accountChainBody({
        provider,
        phoneNumberId: form.key,
        credential: form.token,
        appSecret: form.appSecret,
        graphUrl: route?.ownServer ? form.graphUrl : '',
        verifyToken: token,
        // No fallback asked: anything no rule matches is ignored until a rule says otherwise.
      }),
      'connected',
    );
  };

  const title = PROVIDER_TITLE[provider];
  /** The words for one own-account route: what the vendor calls the account, its credential and its signing secret. */
  const ownText = (route: string) => {
    if (route === 'bot') {
      return {
        choice: t`Your own bot`,
        choiceDetail: t`A bot you made with @BotFather. Telegram calls the hub's webhook URL; replies go out as your bot.`,
        prove: t`1. The hub proves the bot is yours: it calls Telegram's getMe with the bot token. Only an answer naming the same bot id passes.`,
        deliver: t`2. You get a webhook URL. Register it with setWebhook and the secret token below — deliveries without it are refused.`,
        key: t`Bot id`,
        keyHint: t`The number before the colon in the bot token.`,
        credential: t`Bot token`,
        credentialHint: t`Proves the bot (getMe). Stored write-only.`,
        secret: t`Secret token`,
        secretHint: t`The secret_token you pass to setWebhook; Telegram sends it with every delivery. Stored write-only.`,
      };
    }
    const generic = route === 'generic';
    return {
      choice: generic ? t`Generic Meta-API webhook` : t`Meta official Cloud API`,
      choiceDetail: generic
        ? t`Any server that speaks Meta's ${title} API and webhook format. The hub proves the number on that server and replies through it.`
        : t`Your business number in your own Meta app. Meta calls the hub's webhook URL.`,
      prove: t`1. The hub proves the number is yours: it asks your server for this phone number ID using the access token. Only an answer naming the same ID passes.`,
      deliver: t`2. You get a webhook URL. Your server sends every message there, signed with the app secret — unsigned messages are refused.`,
      key: t`Phone number ID`,
      keyHint: generic
        ? t`The id your server's API uses for the number (not the phone number itself).`
        : t`Meta app › WhatsApp › API Setup — the number's id, not the phone number itself.`,
      credential: t`Access token`,
      credentialHint: generic
        ? t`Proves the number on your server. Stored write-only.`
        : t`Business Settings › System users › Generate token — never expires, with whatsapp_business_messaging. Stored write-only.`,
      secret: t`App secret`,
      secretHint: generic
        ? t`Signs every delivery. Stored write-only.`
        : t`Meta app › App settings › Basic. Checks every delivery came from Meta. Stored write-only.`,
    };
  };

  const ownReady = !!route && !!form.key.trim() && !!form.token.trim() && (!route.ownServer || !!form.graphUrl.trim());
  const text = route ? ownText(route.id) : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        data-testid="inbound-connect-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-base font-normal text-muted-foreground">
            <Trans>Add channel</Trans> ›{' '}
            <b className="text-foreground">
              {step === 'choose'
                ? email
                  ? t`Email`
                  : title
                : {
                    email: t`Email › Flowpad inbox`,
                    link: t`${title} › Flowpad's number`,
                    own: t`${title} › Your own number`,
                    connected: t`${title} › Connected`,
                  }[step]}
            </b>
          </DialogTitle>
        </DialogHeader>

        {step === 'choose' && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex gap-2">
              {INBOUND_PROVIDERS.map((p) => (
                <Chip key={p} active={tab === p} testId={`inbound-provider-${p}`} onClick={() => setTab(p)}>
                  {PROVIDER_TITLE[p]}
                </Chip>
              ))}
              <Chip active={email} testId="inbound-provider-email" onClick={() => setTab('email')}>
                <Trans>Email</Trans>
              </Chip>
            </div>
            {email && (
              <Choice
                testId="inbound-choice-inbox"
                title={t`Flowpad inbox`}
                detail={t`A real email address the hub creates for one of your agents. Nothing to set up.`}
                onClick={() => setStep('email')}
              />
            )}
            {!email && (
              <>
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
                {VENDOR[provider].own.map((r) => {
                  const c = ownText(r.id);
                  return (
                    <Choice
                      key={r.id}
                      testId={`inbound-choice-${r.id}`}
                      title={c.choice}
                      detail={c.choiceDetail}
                      onClick={() => {
                        setRoute(r);
                        setStep('own');
                      }}
                    />
                  );
                })}
              </>
            )}
          </div>
        )}

        {step === 'own' && route && text && (
          <div className="flex flex-col gap-3 text-sm">
            <Field
              testId="inbound-field-phone-id"
              label={text.key}
              value={form.key}
              onChange={field('key')}
              hint={text.keyHint}
            />
            <Field
              testId="inbound-field-token"
              label={text.credential}
              value={form.token}
              onChange={field('token')}
              secret
              hint={text.credentialHint}
            />
            {route.ownServer && (
              <Field
                testId="inbound-field-graph-url"
                label={t`Graph server`}
                value={form.graphUrl}
                onChange={field('graphUrl')}
                placeholder="https://graph.example.com/v23.0"
                hint={t`Where your server answers Meta's API. https only.`}
              />
            )}
            <Field
              testId="inbound-field-app-secret"
              label={text.secret}
              value={form.appSecret}
              onChange={field('appSecret')}
              secret
              hint={text.secretHint}
            />
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
              {route?.id === 'meta' ? (
                <Trans>
                  Last step, in your Meta app: WhatsApp › Configuration › Webhook — paste the Callback URL and Verify
                  token below, Verify and save, then subscribe the messages field.
                </Trans>
              ) : (
                <Trans>Now send your messages to the hub. Paste these into your server's webhook settings:</Trans>
              )}
            </p>
            <CopyRow testId="inbound-connected-url" value={made.url} />
            {verifyToken && <CopyRow testId="inbound-connected-verify-token" value={verifyToken} />}
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

        {step === 'email' && (
          <div className="flex flex-col gap-3 text-sm" data-testid="inbound-email-step">
            <label className="flex flex-col gap-1">
              <span className="font-medium">
                <Trans>Agent</Trans>
              </span>
              <Select
                value={inboxAgent ? String(inboxAgent.id) : undefined}
                onValueChange={(agentId) => setInbox((b) => ({ ...b, agentId }))}
              >
                <SelectTrigger data-testid="inbound-email-agent">
                  <SelectValue placeholder={t`No agents yet`} />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={String(a.id)} value={String(a.id)}>
                      {a.name || String(a.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground" data-testid="inbound-email-agent-hint">
                {agents.length ? (
                  <Trans>One inbox per agent; it answers the senders you allow.</Trans>
                ) : (
                  <Trans>No agents yet — an inbox belongs to an agent, so create one first.</Trans>
                )}
              </span>
            </label>
            <Field
              testId="inbound-email-name"
              label={t`Name`}
              value={inbox.username}
              onChange={(v) => setInbox((b) => ({ ...b, username: v }))}
              hint={t`The part before the @. Permanent once created.`}
            />
            <Field
              testId="inbound-email-display"
              label={t`Display name`}
              value={inbox.displayName}
              onChange={(v) => setInbox((b) => ({ ...b, displayName: v }))}
              hint={t`What people see in their mail app.`}
            />
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
          {step === 'email' && (
            <>
              <Button variant="ghost" onClick={() => setStep('choose')}>
                <Trans>Back</Trans>
              </Button>
              <Button
                data-testid="inbound-email-create"
                disabled={!inboxAgent || busy}
                onClick={() => void createInbox()}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                <Trans>Create inbox</Trans>
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

/** A verify token for a webhook handshake: ours to invent, never typed by the person. */
function newVerifyToken(): string {
  return `fp-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
