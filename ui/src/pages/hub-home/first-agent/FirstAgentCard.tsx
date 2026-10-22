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
import { workspaceServiceUrl } from '@src/hooks/use-sandboxes';

/** One way to connect a channel: Flowpad's own bot/number/app, or the person's own. */
type Option = { id: string; method: OnboardingMethod; title: string; hint: string };

const OPTIONS: Record<OnboardingChannel, Option[]> = {
  whatsapp: [
    { id: 'flowpad_bot', method: 'flowpad', title: 'Flow bot', hint: 'Message our number from your phone.' },
    { id: 'meta_api', method: 'own', title: 'Your own number', hint: 'Meta Cloud API, or any Meta-compatible API.' },
  ],
  telegram: [
    { id: 'flowpad_bot', method: 'flowpad', title: 'Flow bot', hint: 'Open our bot and press Start.' },
    { id: 'own_bot', method: 'own', title: 'Your own bot', hint: 'Paste the token BotFather gave you.' },
  ],
  slack: [
    { id: 'flowpad_app', method: 'flowpad', title: 'Flowpad app', hint: 'Add Flowpad to Slack and link yourself.' },
    { id: 'own_app', method: 'own', title: 'Your own Slack', hint: 'Connect Slack, pick a channel.' },
  ],
};

const CHANNEL_TITLE: Record<OnboardingChannel, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', slack: 'Slack' };
/** Throws unless the channel set-up's last step (verify) reports the channel ready. */
const assertReady = (answer: ChannelSetupResult) => {
  const last = answer.results.at(-1);
  const verdict = last?.data as { ready?: boolean; detail?: string } | undefined;
  if (!answer.ok || !verdict?.ready) throw new Error(verdict?.detail || last?.message || 'not ready');
};
const EXAMPLES = [
  'Answer like a pirate.',
  'Remind me of my tasks every morning.',
  'Answer questions about our opening hours.',
];
const POLL_MS = 3000;

type Step = 'describe' | 'connect' | 'live';
type LiveMessage = {
  id: string;
  author_external_id?: string | null;
  body?: string | null;
  occurred_at?: string | null;
};

/** The hub home's first-agent card: describe it → its own sandbox + connect a channel → talk to it. */
export function FirstAgentCard() {
  const { t } = useLingui();
  const [step, setStep] = useState<Step>('describe');
  const [prompt, setPrompt] = useState('');
  const [channel, setChannel] = useState<OnboardingChannel>('whatsapp');
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

  // Your own Slack: the person's Slack connection (once, on the hub), used by this agent's sandbox in one channel.
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
        config: { channel: slackChannel.trim() },
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
    setStep('describe');
    setOption(null);
    setMade(null);
    setDeployed(null);
    setClaim(null);
    setStarted(0);
    setError(null);
    deploying.current = null;
  };

  const elapsed = started ? ((step === 'live' ? (phases.linked ?? now) : now) - started) / 1000 : 0;

  return (
    <section data-testid="first-agent-card" className="w-full rounded-xl border bg-card p-5 text-left shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">
          {step === 'describe' && <Trans>Make an agent in 60 seconds</Trans>}
          {step === 'connect' && <Trans>Connect {CHANNEL_TITLE[channel]}</Trans>}
          {step === 'live' && <Trans>Your agent is live</Trans>}
        </h2>
        {started > 0 && (
          <span data-testid="first-agent-timer" className="font-mono text-xs text-muted-foreground">
            {elapsed.toFixed(1)}s
          </span>
        )}
      </div>

      {step === 'describe' && (
        <div className="flex flex-col gap-3">
          <Textarea
            data-testid="first-agent-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t`What should your agent do? One line is enough.`}
            rows={2}
          />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Trans>Try:</Trans>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="underline" onClick={() => setPrompt(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              <Trans>Talk to it on</Trans>
            </span>
            {(Object.keys(OPTIONS) as OnboardingChannel[]).map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`first-agent-channel-${c}`}
                onClick={() => {
                  setChannel(c);
                  setOption(null);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm',
                  channel === c
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground',
                )}
              >
                <FlowIcon icon={`brands.${c}`} className="h-4 w-4 shrink-0" />
                {CHANNEL_TITLE[c]}
              </button>
            ))}
          </div>
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
                <span className={cn('text-sm font-semibold', option?.id === o.id ? 'text-primary' : 'text-foreground')}>
                  {o.title}
                </span>
                <span className="text-xs text-muted-foreground">{o.hint}</span>
              </button>
            ))}
          </div>
          <div>
            <Button
              data-testid="first-agent-create"
              disabled={!prompt.trim() || !option || busy}
              onClick={() => void create()}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Trans>Create</Trans>
            </Button>
          </div>
        </div>
      )}

      {step !== 'describe' && (
        <ol
          data-testid="first-agent-phases"
          className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          <Phase done={!!phases.saved} label={t`Saved to My project`} at={secs(phases.saved)} />
          <Phase done={!!phases.sandbox} label={t`Sandbox ready`} at={secs(phases.sandbox)} />
          <Phase done={!!phases.linked} label={t`${CHANNEL_TITLE[channel]} connected`} at={secs(phases.linked)} />
        </ol>
      )}

      {step === 'connect' && option && (
        <div className="flex flex-col gap-3 text-sm">
          {option.method === 'flowpad' && (
            <>
              {!claim ? (
                <div>
                  <Button data-testid="first-agent-get-code" disabled={busy} onClick={() => void startLink()}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {deployed ? <Trans>Get my link code</Trans> : <Trans>Get my link code (sandbox starting…)</Trans>}
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
              <Input
                data-testid="first-agent-api-url"
                placeholder={t`API URL (Meta-compatible servers only)`}
                value={graphUrl}
                onChange={(e) => setGraphUrl(e.target.value)}
              />
              <div>
                <Button
                  data-testid="first-agent-connect"
                  disabled={
                    busy || !phoneId.trim() || !token.trim() || !wabaId.trim() || !appId.trim() || !appSecret.trim()
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

          {channel === 'slack' && option.method === 'own' && (
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
                  <Trans>Slack connected.</Trans>
                </p>
              )}
              <Input
                data-testid="first-agent-slack-channel"
                placeholder={t`Channel ID (C0123456789)`}
                value={slackChannel}
                onChange={(e) => setSlackChannel(e.target.value)}
              />
              <div>
                <Button
                  data-testid="first-agent-connect"
                  disabled={busy || !slackConnected || !slackChannel.trim()}
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
                  <Trans>Open bot</Trans>
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

function Phase({ done, label, at }: { done: boolean; label: string; at: string }) {
  return (
    <li className={cn('flex items-center gap-1', done && 'text-foreground')}>
      {done ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
      {at && <span className="font-mono">{at}</span>}
    </li>
  );
}
