import { Agent } from '@sdk';
import apiClient from '@sdk/client';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';

import { RuntimeStrip } from '@src/components/top-nav-bar/RuntimeStrip';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { errorDetail, errorMessage, errorStatus } from '@src/lib/error-message';

import { clientFacts } from './client-facts';
import { useAnonymousAgent } from './launch-target';

interface Opened {
  node_typeid?: string;
  workspace_url?: string;
}

/**
 * `POST agent/<id>/visitor-sandbox`. `anonymous` sends NO cookies (the fetch adapter maps
 * `withCredentials: false` to `credentials: 'omit'`; XHR would send same-origin cookies regardless), so a
 * signed-in browser is still a visitor — the hub refuses a signed-in caller who holds no role on the agent
 * before the action runs. A code is always sent that way. Only link mode needs cookies: it keys the
 * visitor on its `_vid` cookie.
 */
export function openVisitorSandbox(agentId: string, code?: string, anonymous = Boolean(code)): Promise<Opened> {
  const path = `/api/v1/graph/${Agent.type}/${encodeURIComponent(agentId)}/visitor-sandbox`;
  // `client`: what this phone says about itself, for the hub's log only (`client-facts.ts`).
  const body = { ...(code ? { code } : {}), client: clientFacts() };
  return anonymous
    ? apiClient.post<Opened>(path, body, { adapter: 'fetch', withCredentials: false })
    : apiClient.post<Opened>(path, body);
}

/** The hub asks for a code: the agent is in invite-code mode. */
const codeRequired = (e: unknown) => errorStatus(e) === 401 && /code required/i.test(errorDetail(e));

/**
 * `/open-pc/<agent id>` — a visitor's way into an agent's public deployment. Link mode opens straight away;
 * code mode asks for the invite code, and the same code always opens the same sandbox. Signed-out on purpose
 * (`anonymous-entry.ts`): no sign-in is ever offered. The answer is the box's gated url, followed once.
 */
/** The hub's `data.reason` on a refused open (`full` | `not_ready`), if it gave one. */
export function refusalReason(e: unknown): string | null {
  const body = (e as { response?: { data?: { data?: { reason?: unknown } } } } | null)?.response?.data;
  const reason = body?.data?.reason;
  return typeof reason === 'string' ? reason : null;
}

export default function OpenPcLanding() {
  const { t } = useLingui();
  // Trimmed: a copied or clicked link can carry a trailing newline (`%0A`), which the hub reads as another id.
  const agentId = (useParams().agentId ?? '').trim();
  const agent = useAnonymousAgent(agentId || null);
  const name = agent ? agent.getDisplayName() || agent.name : '';
  const [phase, setPhase] = useState<'probing' | 'code' | 'opening' | 'failed'>('probing');
  const [askCode, setAskCode] = useState(false);
  // A code handed over in the link's fragment (`#code=…`, from the owner's Open machine) is already in the box.
  const [code, setCode] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('code') ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const problemOf = (e: unknown, sentCode: boolean): string => {
    const status = errorStatus(e);
    if (status === 404 && sentCode) return t`This code doesn't work. Check it, or ask whoever gave it to you.`;
    if (status === 409) {
      // The hub says which 409 it is: only "full" passes by waiting; anything else the owner has to fix.
      if (refusalReason(e) === 'full')
        return t`All sandboxes for this agent are in use right now. Try again in a few minutes.`;
      const why = errorDetail(e);
      return why
        ? t`This agent isn't ready to open yet: ${why} Tell whoever gave you the code.`
        : t`This agent isn't ready to open yet. Tell whoever gave you the code.`;
    }
    if (status === 429) return t`Too many tries. Try again later.`;
    if (status === 403) return t`This link is for visitors. Open it in a private window.`;
    return errorMessage(e, t`Couldn't open a sandbox.`);
  };

  const go = (opened: Opened) => {
    if (!opened?.workspace_url) throw new Error(t`Couldn't open a sandbox.`);
    window.location.assign(opened.workspace_url);
  };

  // Once per page: a second probe would only wake the same box.
  const probed = useRef(false);
  useEffect(() => {
    if (!agentId || probed.current) return;
    probed.current = true;
    void (async () => {
      try {
        // First without cookies: a code-mode agent answers "code required" whoever is signed in here.
        // Link mode answers "visitor cookie not set" to that, so it is asked again with the cookie.
        try {
          go(await openVisitorSandbox(agentId, undefined, true));
        } catch (anonymous) {
          if (codeRequired(anonymous) || errorStatus(anonymous) !== 401) throw anonymous;
          go(await openVisitorSandbox(agentId));
        }
        setPhase('opening');
      } catch (e) {
        if (codeRequired(e)) {
          setAskCode(true);
          setPhase('code');
        } else {
          setProblem(problemOf(e, false));
          setPhase('failed');
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page, on the link's id
  }, [agentId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const typed = code.trim();
    if (!typed) return;
    setProblem(null);
    setPhase('opening');
    try {
      go(await openVisitorSandbox(agentId, typed));
    } catch (err) {
      setProblem(problemOf(err, true));
      setPhase('code');
    }
  };

  const opening = phase === 'opening' || phase === 'probing';
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <RuntimeStrip />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border p-5 text-start" data-testid="open-pc-panel">
          <p className="text-sm font-medium" data-testid="open-pc-title">
            {name || <Trans>Open your sandbox</Trans>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            <Trans>A sandbox of your own, ready in about a minute.</Trans>
          </p>

          {askCode && (
            <form className="mt-4 flex flex-col gap-2" onSubmit={(e) => void submit(e)} data-testid="open-pc-form">
              <label htmlFor="open-pc-code" className="text-xs font-medium">
                <Trans>Invite code</Trans>
              </label>
              <Input
                id="open-pc-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                autoFocus
                disabled={phase === 'opening'}
                className="font-mono"
                data-testid="open-pc-code"
              />
              <Button type="submit" disabled={phase === 'opening' || !code.trim()} data-testid="open-pc-open">
                {phase === 'opening' ? (
                  <>
                    <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                    <Trans>Opening…</Trans>
                  </>
                ) : (
                  <Trans>Open</Trans>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                <Trans>No sign-in. The same code always opens the same sandbox.</Trans>
              </p>
            </form>
          )}

          {!askCode && opening && (
            <p className="mt-4 flex items-center gap-2 text-sm" data-testid="open-pc-opening">
              <Loader2 className="h-4 w-4 animate-spin" />
              <Trans>Opening…</Trans>
            </p>
          )}

          {problem && (
            <p
              className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
              role="alert"
              data-testid="open-pc-error"
            >
              {problem}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
