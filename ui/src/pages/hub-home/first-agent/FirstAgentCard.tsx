import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type ChannelSetupResult,
  type CreatedAgent,
  type DeployedAgent,
  type InboundClaim,
  InboundWebhooks,
  Onboarding,
  type OnboardingChannel,
  type OnboardingMethod,
  accountChainBody,
  linkChainBody,
  TypeId,
} from '@sdk';
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { FlowIcon } from '@sdk/react/FlowIcon';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import flowpadIcon from '@src/assets/flowpad-icon.png';
import { workspaceServiceUrl } from '@src/hooks/use-sandboxes';

/** One way to connect a channel: Flowpad's own bot/number/app, or the person's own. */
type Option = { id: string; method: OnboardingMethod; title: string; hint: string };

const OPTIONS: Record<OnboardingChannel, Option[]> = {
  slack: [
    {
      id: 'flowpad_app',
      method: 'flowpad',
      title: 'Flow Slack bot',
      hint: 'Add the Flowpad bot to Slack. It replies as the bot.',
    },
    { id: 'own_bot', method: 'own', title: 'Your own bot', hint: 'A Slack app you create. It replies as your bot.' },
    {
      id: 'own_app',
      method: 'own',
      title: 'Me agent',
      hint: 'It replies as you, with your Slack login, in one channel.',
    },
  ],
  whatsapp: [
    { id: 'flowpad_bot', method: 'flowpad', title: 'Flow WhatsApp bot', hint: 'Message our number from your phone.' },
    { id: 'meta_api', method: 'own', title: 'Meta API', hint: 'Your own WhatsApp Business number on Meta Cloud API.' },
    { id: 'custom_api', method: 'own', title: 'Custom API', hint: 'Any Meta-compatible API, e.g. WAHA.' },
  ],
  telegram: [
    { id: 'flowpad_bot', method: 'flowpad', title: 'Flow bot', hint: 'Open our bot and press Start.' },
    { id: 'own_bot', method: 'own', title: 'Your own bot', hint: 'Paste the token BotFather gave you.' },
  ],
};

const CHANNEL_TITLE: Record<OnboardingChannel, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', slack: 'Slack' };
const CHANNEL_HINT: Record<OnboardingChannel, string> = {
  whatsapp: 'Chat with it from your phone.',
  telegram: 'A bot you message on Telegram.',
  slack: 'It answers in your workspace.',
};
/** Throws unless the channel set-up's last step (verify) reports the channel ready. */
const assertReady = (answer: ChannelSetupResult) => {
  const last = answer.results.at(-1);
  const verdict = last?.data as { ready?: boolean; detail?: string } | undefined;
  if (!answer.ok || !verdict?.ready) throw new Error(verdict?.detail || last?.message || 'not ready');
};
const EXAMPLES = [
  'Summarize the last 24 hours on Slack.',
  'Answer like a pirate.',
  'Remind me of my tasks every morning.',
  'Answer questions about our opening hours.',
];
const POLL_MS = 3000;

const WIZARD = ['channel', 'instructions', 'type'] as const;
type WizardStep = (typeof WIZARD)[number];
type Step = WizardStep | 'connect' | 'live';
type LiveMessage = {
  id: string;
  author_external_id?: string | null;
  body?: string | null;
  occurred_at?: string | null;
};

/** The hub home's first-agent card: pick a channel → say what it does → pick how it connects → its own sandbox + connect a channel → talk to it. */
export function FirstAgentCard() {
  const { t } = useLingui();
  const [step, setStep] = useState<Step>('channel');
  const [prompt, setPrompt] = useState('');
  const [channel, setChannel] = useState<OnboardingChannel>('slack');
  const [option, setOption] = useState<Option | null>(null);
  const [made, setMade] = useState<CreatedAgent | null>(null);
  const [deployed, setDeployed] = useState<DeployedAgent | null>(null);
  const [phases, setPhases] = useState<Record<string, number>>({});
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Option fields.
  const [claim, setClaim] = useState<InboundClaim | null>(null);
  const [phoneId, setPhoneId] = useState('');
  const [token, setToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [graphUrl, setGraphUrl] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [appId, setAppId] = useState('');
  const [slackChannel, setSlackChannel] = useState('');
  // Me agent: the person names and creates a private channel, then pastes its link (the link carries its id).
  const [slackName, setSlackName] = useState('#flow-test');
  const [slackLink, setSlackLink] = useState('');
  const slackLinkId = /(?:\/archives\/|\/client\/T[A-Z0-9]+\/|^\s*)([CG][A-Z0-9]{8,})/.exec(slackLink)?.[1] ?? '';
  const [slackConnected, setSlackConnected] = useState(false);
  const deploying = useRef<Promise<DeployedAgent> | null>(null);

  useEffect(() => {
    if (!started || step === 'live') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [started, step]);

  const mark = (name: string) => setPhases((p) => ({ ...p, [name]: Date.now() }));
  const secs = (at?: number) => (at && started ? `${((at - started) / 1000).toFixed(1)}s` : '');

  const create = async () => {
    setBusy(true);
    setError(null);
    const t0 = Date.now();
    setStarted(t0);
    setPhases({});
    try {
      const agent = await Onboarding.createAgent(prompt.trim(), channel, option?.method ?? 'flowpad');
      setMade(agent);
      mark('saved');
      setStep('connect');
      deploying.current = Onboarding.deploy(agent.agent.id).then((d) => {
        setDeployed(d);
        mark('sandbox');
        return d;
      });
      deploying.current.catch((e) => setError(errorMessage(e, 'failed')));
    } catch (e) {
      setError(errorMessage(e, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  const sandbox = async () => deployed ?? (await deploying.current!);
  const target = (d: DeployedAgent) =>
    ({ kind: 'node', node_typeid: d.node_typeid, data_source_id: made!.data_source_id ?? undefined }) as const;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  const linked = () => {
    mark('linked');
    setStep('live');
  };

  // Flowpad bot: a pending code claim pointed at the agent's sandbox; proven when the person sends the code.
  const startLink = () =>
    run(async () => {
      const d = await sandbox();
      setClaim(await InboundWebhooks.chain(linkChainBody(channel, target(d))));
    });

  useEffect(() => {
    if (!claim || claim.status === 'active' || step !== 'connect') return;
    const id = setInterval(() => {
      void InboundWebhooks.mine().then((all) => {
        const fresh = all.find((c) => c.id === claim.id);
        if (fresh) setClaim(fresh);
        if (fresh?.status === 'active') linked();
      });
    }, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim, step]);

  const connectOwnNumber = () =>
    run(async () => {
      const d = await sandbox();
      // The webhook handshake secret between the vendor and the hub: the person never needs to see it.
      const verifyToken = crypto.randomUUID().replace(/-/g, '');
      const baseUrl = graphUrl.trim().replace(/\/+$/, '');
      // The hub proves the number and routes its deliveries to the agent's sandbox …
      await InboundWebhooks.chain(
        accountChainBody({
          provider: 'whatsapp',
          phoneNumberId: phoneId,
          credential: token,
          appSecret,
          verifyToken,
          graphUrl: baseUrl ? `${baseUrl}/v23.0` : '',
          target: target(d),
        }),
      );
      // … and the sandbox's channel source sends the answers from that number.
      const answer = await Onboarding.channelSetup(d.node_typeid, {
        source: made!.data_source_id!,
        config: { base_url: baseUrl, verify_token: verifyToken },
        access: { open_to_all: true },
        steps: [
          { step: 'app', values: { app_id: appId.trim(), app_secret: appSecret.trim() } },
          {
            step: 'number',
            values: { phone_number_id: phoneId.trim(), waba_id: wabaId.trim(), access_token: token.trim() },
          },
        ],
        verify: true,
      });
      assertReady(answer);
      linked();
    });

  const connectOwnBot = () =>
    run(async () => {
      const d = await sandbox();
      const answer = await Onboarding.channelSetup(d.node_typeid, {
        source: made!.data_source_id!,
        credential: { name: 'telegram', values: { TELEGRAM_BOT_TOKEN: token.trim() } },
        access: { open_to_all: true },
        exclusive: true,
        verify: true,
      });
      assertReady(answer);
      linked();
    });

  // Your own Slack bot: its bot token on the agent's sandbox, reading and replying in one channel as the bot.
  const connectSlackBot = () =>
    run(async () => {
      const d = await sandbox();
      const answer = await Onboarding.channelSetup(d.node_typeid, {
        source: made!.data_source_id!,
        config: { channel: slackChannel.trim() },
        credential: { name: 'slack', values: { SLACK_BOT_TOKEN: token.trim() } },
        access: { open_to_all: true },
        exclusive: true,
        verify: true,
      });
      assertReady(answer);
      linked();
    });

  // Me agent: the person's Slack connection (once, on the hub), used by this agent's sandbox in one channel.
  const refreshSlack = async () => {
    if (!made) return false;
    const s = await Onboarding.connectionStatus(made.project.id, 'slack');
    setSlackConnected(!!s.has_token);
    return !!s.has_token;
  };
  useEffect(() => {
    if (option?.id !== 'own_app' || slackConnected || step !== 'connect') return;
    void refreshSlack();
    const id = setInterval(() => void refreshSlack(), POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option, slackConnected, step, made]);

  const openSlackConsent = () => run(async () => void window.open(await Onboarding.startConnection('slack'), '_blank'));

  const connectOwnSlack = () =>
    run(async () => {
      const d = await sandbox();
      await Onboarding.attachConnection(made!.project.id, 'slack');
      if (d.deployment?.id) await Onboarding.authorize(d.deployment.id, 'slack');
      const answer = await Onboarding.channelSetup(d.node_typeid, {
        source: made!.data_source_id!,
        config: { channel: { id: slackLinkId, name: slackName.replace(/^#/, '').trim() } },
        access: { open_to_all: true },
        exclusive: true,
        verify: true,
      });
      assertReady(answer);
      linked();
    });

  // Live: the channel's latest messages, read from the sandbox through the hub every few seconds. Held in this page
  // only — nothing here is stored.
  const [live, setLive] = useState<LiveMessage[]>([]);
  useEffect(() => {
    if (step !== 'live' || !deployed || !made?.data_source_id) return;
    const read = () =>
      void Onboarding.channelSetup(deployed.node_typeid, { source: made.data_source_id!, items: true })
        .then((answer) => {
          const items = (answer.results.at(-1)?.data as { items?: LiveMessage[] } | undefined)?.items ?? [];
          setLive(
            [...items]
              // Since the agent took the channel: older history is not this conversation.
              .filter((i) => i.body && (!i.occurred_at || Date.parse(i.occurred_at) >= (phases.linked ?? 0) - 5000))
              .reverse()
              .slice(-8),
          );
        })
        .catch(() => undefined);
    read();
    const id = setInterval(read, POLL_MS);
    return () => clearInterval(id);
  }, [step, deployed, made, phases.linked]);

  const reset = () => {
    setLive([]);
    setStep('channel');
    setOption(null);
    setMade(null);
    setDeployed(null);
    setClaim(null);
    setStarted(0);
    setError(null);
    deploying.current = null;
  };

  const at = WIZARD.indexOf(step as WizardStep);
  const inWizard = at >= 0;
  const elapsed = started ? ((step === 'live' ? (phases.linked ?? now) : now) - started) / 1000 : 0;

  return (
    <section data-testid="first-agent-card" className="w-full rounded-xl border bg-card p-5 text-left shadow-sm">
      {inWizard && (
        <nav data-testid="first-agent-crumbs" className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
          {WIZARD.map((s, i) => {
            const label = [t`Channel`, t`Instructions`, t`Launch bot`][i];
            return (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground">›</span>}
                {i < at ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                    onClick={() => setStep(s)}
                  >
                    ✓ {label}:{s === 'channel' && <FlowIcon icon={`brands.${channel}`} className="h-3 w-3 shrink-0" />}
                    <span className="text-foreground">{s === 'channel' ? CHANNEL_TITLE[channel] : prompt.trim()}</span>
                  </button>
                ) : (
                  <span className={i === at ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
                    {i + 1}. {label}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
      )}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">
          {step === 'channel' && <Trans>Make an agent in 60 seconds — where will you talk to it?</Trans>}
          {step === 'instructions' && <Trans>What should it do?</Trans>}
          {step === 'type' && <Trans>How should it connect to {CHANNEL_TITLE[channel]}?</Trans>}
          {step === 'connect' && <Trans>Connect {CHANNEL_TITLE[channel]}</Trans>}
          {step === 'live' && <Trans>Your agent is live</Trans>}
        </h2>
        {inWizard && (
          <span className="text-xs text-muted-foreground">
            <Trans>Step {at + 1} of {WIZARD.length}</Trans>
          </span>
        )}
        {started > 0 && (
          <span data-testid="first-agent-timer" className="font-mono text-xs text-muted-foreground">
            {elapsed.toFixed(1)}s
          </span>
        )}
      </div>

      {step === 'channel' && (
        <div className="flex gap-3">
          {(Object.keys(OPTIONS) as OnboardingChannel[]).map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`first-agent-channel-${c}`}
              onClick={() => {
                if (c !== channel) setOption(null);
                setChannel(c);
                setStep('instructions');
              }}
              className="flex flex-1 flex-col items-start gap-2 rounded-lg border border-border bg-background p-4 text-left hover:bg-accent"
            >
              <FlowIcon icon={`brands.${c}`} className="h-7 w-7 shrink-0" />
              <span className="text-sm font-semibold text-foreground">{CHANNEL_TITLE[c]}</span>
              <span className="text-xs text-muted-foreground">{CHANNEL_HINT[c]}</span>
            </button>
          ))}
        </div>
      )}

      {step === 'instructions' && (
        <div className="flex flex-col gap-3">
          <Textarea
            data-testid="first-agent-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t`What should your agent do? One line is enough.`}
            rows={3}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Trans>Try:</Trans>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  prompt === ex
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border bg-secondary text-foreground hover:bg-accent',
                )}
                onClick={() => setPrompt(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setStep('channel')}>
              ← <Trans>Back</Trans>
            </Button>
            <Button data-testid="first-agent-next" disabled={!prompt.trim()} onClick={() => setStep('type')}>
              <Trans>Next</Trans>
            </Button>
          </div>
        </div>
      )}

      {step === 'type' && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            {OPTIONS[channel].map((o) => (
              <button
                key={o.id}
                type="button"
                data-testid={`first-agent-option-${o.id}`}
                onClick={() => setOption(o)}
                className={cn(
                  'flex flex-1 flex-col gap-1 rounded-lg border p-3 text-left',
                  option?.id === o.id
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-border bg-background hover:bg-accent',
                )}
              >
                <span className="flex items-center gap-2">
                  {o.method === 'flowpad' ? (
                    // Flowpad's own bot: the Flow logo with the channel as a sub icon.
                    <span className="relative h-6 w-6 shrink-0">
                      <img src={flowpadIcon} alt="" className="h-6 w-6 rounded-sm" />
                      <FlowIcon
                        icon={`brands.${channel}`}
                        className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-card"
                      />
                    </span>
                  ) : (
                    <FlowIcon icon={`brands.${channel}`} className="h-6 w-6 shrink-0" />
                  )}
                  <span
                    className={cn('text-sm font-semibold', option?.id === o.id ? 'text-primary' : 'text-foreground')}
                  >
                    {o.title}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{o.hint}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setStep('instructions')}>
              ← <Trans>Back</Trans>
            </Button>
            <Button
              data-testid="first-agent-create"
              disabled={!prompt.trim() || !option || busy}
              onClick={() => void create()}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Trans>Try it</Trans>
            </Button>
          </div>
        </div>
      )}

      {(step === 'connect' || step === 'live') && (
        <ol
          data-testid="first-agent-phases"
          className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          <Phase state={phases.saved ? 'done' : 'now'} label={t`Saved to My project`} at={secs(phases.saved)} />
          <Phase
            state={phases.sandbox ? 'done' : phases.saved ? 'now' : 'later'}
            label={phases.sandbox ? t`Agent machine ready` : t`Preparing the agent machine`}
            at={secs(phases.sandbox)}
          />
          <Phase
            state={phases.linked ? 'done' : 'later'}
            label={t`${CHANNEL_TITLE[channel]} connected`}
            at={secs(phases.linked)}
          />
        </ol>
      )}

      {step === 'connect' && option && (
        <div className="flex flex-col gap-3 text-sm">
          {option.method === 'flowpad' && (
            <>
              {!claim ? (
                <div>
                  <Button data-testid="first-agent-get-code" disabled={busy} onClick={() => void startLink()}>
                    {busy && deployed && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {busy && !deployed ? (
                      <Trans>Your code comes once the machine is ready</Trans>
                    ) : (
                      <Trans>Get my link code</Trans>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <ol className="list-decimal pl-5">
                    <li>
                      {claim.deep_link ? (
                        <a
                          data-testid="first-agent-deep-link"
                          className="text-primary underline"
                          href={claim.deep_link}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Trans>Open {CHANNEL_TITLE[channel]}</Trans> <ExternalLink className="inline h-3 w-3" />
                        </a>
                      ) : (
                        <Trans>Open Flowpad on {CHANNEL_TITLE[channel]}</Trans>
                      )}
                    </li>
                    <li>
                      <Trans>Send</Trans>{' '}
                      <code data-testid="first-agent-code" className="rounded bg-muted px-1">
                        link {claim.code}
                      </code>{' '}
                      <CopyButton value={`link ${claim.code}`} />
                    </li>
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                    <Trans>Waiting for your message…</Trans>
                  </p>
                </div>
              )}
            </>
          )}

          {channel === 'whatsapp' && option.method === 'own' && (
            <div className="grid gap-2">
              <Input
                data-testid="first-agent-phone-id"
                placeholder={t`Phone number ID`}
                value={phoneId}
                onChange={(e) => setPhoneId(e.target.value)}
              />
              <Input
                data-testid="first-agent-token"
                placeholder={t`Access token`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Input
                data-testid="first-agent-waba-id"
                placeholder={t`WhatsApp Business account ID`}
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
              />
              <Input
                data-testid="first-agent-app-id"
                placeholder={t`App ID`}
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
              />
              <Input
                data-testid="first-agent-app-secret"
                placeholder={t`App secret`}
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />
              {option.id === 'custom_api' && (
                <Input
                  data-testid="first-agent-api-url"
                  placeholder={t`API URL`}
                  value={graphUrl}
                  onChange={(e) => setGraphUrl(e.target.value)}
                />
              )}
              <div>
                <Button
                  data-testid="first-agent-connect"
                  disabled={
                    busy ||
                    !phoneId.trim() ||
                    !token.trim() ||
                    !wabaId.trim() ||
                    !appId.trim() ||
                    !appSecret.trim() ||
                    (option.id === 'custom_api' && !graphUrl.trim())
                  }
                  onClick={() => void connectOwnNumber()}
                >
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Trans>Connect</Trans>
                </Button>
              </div>
            </div>
          )}

          {channel === 'telegram' && option.method === 'own' && (
            <div className="grid gap-2">
              <ol className="list-decimal pl-5 text-xs text-muted-foreground">
                <li>
                  <Trans>In Telegram, message @BotFather and send /newbot.</Trans>
                </li>
                <li>
                  <Trans>Paste the token it gives you here.</Trans>
                </li>
              </ol>
              <Input
                data-testid="first-agent-token"
                type="password"
                placeholder={t`Bot token`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <div>
                <Button
                  data-testid="first-agent-connect"
                  disabled={busy || !token.trim()}
                  onClick={() => void connectOwnBot()}
                >
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Trans>Connect</Trans>
                </Button>
              </div>
            </div>
          )}

          {channel === 'slack' && option.id === 'own_bot' && (
            <div className="grid gap-2">
              <ol className="list-decimal pl-5 text-xs text-muted-foreground">
                <li>
                  <Trans>
                    At{' '}
                    <a
                      className="text-primary underline"
                      href="https://api.slack.com/apps"
                      target="_blank"
                      rel="noreferrer"
                    >
                      api.slack.com/apps
                    </a>{' '}
                    create an app from scratch.
                  </Trans>
                </li>
                <li>
                  <Trans>
                    Under OAuth &amp; Permissions add the bot scopes channels:history, groups:history, channels:read,
                    chat:write and channels:join, then install it to your workspace.
                  </Trans>
                </li>
                <li>
                  <Trans>Paste its Bot User OAuth Token (xoxb-…) and the channel ID here.</Trans>
                </li>
                <li>
                  <Trans>Invite the bot to a private channel with /invite @your-bot.</Trans>
                </li>
              </ol>
              <Input
                data-testid="first-agent-token"
                type="password"
                placeholder={t`Bot token (xoxb-…)`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Input
                data-testid="first-agent-slack-channel"
                placeholder={t`Channel ID (C0123456789)`}
                value={slackChannel}
                onChange={(e) => setSlackChannel(e.target.value)}
              />
              <div>
                <Button
                  data-testid="first-agent-connect"
                  disabled={busy || !token.trim().startsWith('xoxb-') || !slackChannel.trim()}
                  onClick={() => void connectSlackBot()}
                >
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Trans>Connect</Trans>
                </Button>
              </div>
            </div>
          )}

          {channel === 'slack' && option.id === 'own_app' && (
            <div className="grid gap-2">
              {!slackConnected ? (
                <div>
                  <Button
                    data-testid="first-agent-connect-slack"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void openSlackConsent()}
                  >
                    <Trans>Connect Slack</Trans> <ExternalLink className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  <CheckCircle2 className="mr-1 inline h-3 w-3 text-green-600" />
                  <Trans>Your Slack account is linked. The agent will post as you.</Trans>
                </p>
              )}
              <ol className="ml-4 list-decimal space-y-2 text-xs text-muted-foreground">
                <li>
                  <Trans>In Slack, create a private channel named</Trans>
                  <Input
                    data-testid="first-agent-slack-name"
                    className="mt-1 h-8 w-48"
                    value={slackName}
                    onChange={(e) => setSlackName(e.target.value)}
                  />
                </li>
                <li>
                  <Trans>Right-click the channel → Copy → Copy link, and paste it here:</Trans>
                  <Input
                    data-testid="first-agent-slack-link"
                    className="mt-1 h-8"
                    placeholder="https://your-team.slack.com/archives/C0123456789"
                    value={slackLink}
                    onChange={(e) => setSlackLink(e.target.value)}
                  />
                </li>
                <li>
                  <Trans>Ask a teammate to join it and write there. The agent answers as you.</Trans>
                </li>
              </ol>
              <div>
                <Button
                  data-testid="first-agent-connect"
                  disabled={busy || !slackConnected || !slackLinkId}
                  onClick={() => void connectOwnSlack()}
                >
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Trans>Connect</Trans>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 'live' && (
        <div className="flex flex-col gap-3 text-sm">
          <p data-testid="first-agent-live">
            <Trans>
              Set up in {elapsed.toFixed(0)}s. Message it on {CHANNEL_TITLE[channel]} — it answers there.
            </Trans>
          </p>
          <div data-testid="first-agent-conversation" className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3">
            {live.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                <Trans>Waiting for the first message…</Trans>
              </p>
            ) : (
              live.map((m) => (
                <div key={m.id} data-testid="first-agent-message" className="text-xs">
                  <span className="font-mono text-muted-foreground">{m.author_external_id || t`agent`}</span> {m.body}
                </div>
              ))
            )}
            <p className="text-[10px] text-muted-foreground">
              <Trans>Live only — this page does not store the conversation.</Trans>
            </p>
          </div>
          <div className="flex gap-2">
            {deployed && (
              <Button asChild variant="outline" size="sm">
                <a
                  data-testid="first-agent-open-bot"
                  href={workspaceServiceUrl(new TypeId(deployed.node_typeid).id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Trans>Open admin</Trans>
                </a>
              </Button>
            )}
            {option?.id === 'own_app' && slackLinkId && (
              <Button asChild variant="outline" size="sm">
                <a data-testid="first-agent-open-slack" href={slackLink.trim()} target="_blank" rel="noreferrer">
                  <Trans>Open {slackName.trim()} in Slack</Trans> <ExternalLink className="ml-1 h-3 w-3" />
                </a>
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={reset}>
              <Trans>Make another</Trans>
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p data-testid="first-agent-error" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** One setup stage: done (✓), happening now (the card's ONE spinner), or still ahead (a plain dot). */
function Phase({ state, label, at }: { state: 'done' | 'now' | 'later'; label: string; at: string }) {
  return (
    <li className={cn('flex items-center gap-1', state !== 'later' && 'text-foreground')}>
      {state === 'done' && <CheckCircle2 className="h-3 w-3 text-green-600" />}
      {state === 'now' && <Loader2 className="h-3 w-3 animate-spin" />}
      {state === 'later' && <span className="mx-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />}
      {label}
      {at && <span className="font-mono">{at}</span>}
    </li>
  );
}
