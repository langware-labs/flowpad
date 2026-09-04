/**
 * Agent Email: browser enable -> Gmail -> MessageSource -> Agent -> Gmail.
 *
 * Credential-gated: `.env.local` must contain GMAIL_ADDRESS and
 * GMAIL_APP_PASSWORD. The Python harness uses the same FLOW_INSTANCE as the
 * browser backend, so it is ordinary SDK/REPL usage against the local Hub test
 * instance. No credential is copied into a DataSource or printed here.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'dotenv';

const cwd = process.cwd();
const ROOT = existsSync(path.resolve(cwd, 'ui/package.json')) ? cwd : path.resolve(cwd, '..');
const localEnv = parse(readFileSync(path.resolve(ROOT, '.env.local')));

const PYTHON = String.raw`
import asyncio
import json
import os
import sys
import uuid

import flow_sdk
import flow_sdk.ingest.drivers  # noqa: F401
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.email_inbox import EmailInbox, email_source_for_agent
from flow_sdk.builtin.source_item import EmailMessageSpec
from flow_sdk.ingest.drivers.gmail import GmailDriver

def emit(kind, **data):
    print(json.dumps({"kind": kind, **data}), flush=True)

async def command():
    return (await asyncio.to_thread(sys.stdin.readline)).strip()

async def main():
    address = os.environ["GMAIL_ADDRESS"]
    await flow_sdk.auth.login()

    gmail = await DataSource.find_for_account("gmail", GmailDriver.identity_config_key, address)
    gmail_created = gmail is None
    if gmail is None:
        gmail = DataSource(
            name="gmail",
            provider="gmail",
            config={"address": address},
            account_key=address,
            account_identities=[address],
            poll_interval_seconds=60,
        )
        await gmail.save()

    nonce = f"TREASURE-{uuid.uuid4().hex[:8]}"
    agent = Agent(
        name=f"pirate-email-ui-{uuid.uuid4().hex[:8]}",
        worker_type="claude",
        model="sm",
        system_prompt=(
            "Reply immediately in one short sentence like a pirate. Never use tools, inspect files, "
            "or do any work. Include 'arr' and repeat the request code exactly."
        ),
    )
    await agent.save()
    emit("ready", agent_id=agent.id, gmail_address=address, nonce=nonce, gmail_created="1" if gmail_created else "0")

    send_command = await command()
    verb, inbox_address = send_command.split(" ", 1)
    if verb != "SEND" or not inbox_address:
        raise RuntimeError("expected SEND <address>")
    sent = await gmail.send(
        EmailMessageSpec(
            to=[inbox_address],
            subject=f"Pirate UI {nonce}",
            body=f"Where is the treasure? Request code: {nonce}",
        )
    )
    emit("sent", external_id=sent.external_id)
    reply = await gmail.expect_reply(sent)
    emit("reply", body=reply.body, author=reply.author_external_id)

    if await command() != "CLEANUP":
        raise RuntimeError("expected CLEANUP")
    current = await Agent.get_one({"id": agent.id}) or agent
    try:
        inbox = await EmailInbox.for_agent(current)
        if inbox is not None:
            await inbox.release()
    except Exception:
        pass
    cloud_source = await email_source_for_agent(current.id)
    if cloud_source is not None:
        await cloud_source.delete()
    if current.remote:
        await current.unshare()
    await current.delete()
    if gmail_created:
        await gmail.delete()
    emit("clean")

asyncio.run(main())
`;

type HarnessEvent = Record<string, string> & { kind: string };

class PythonHarness {
  private readonly pending: HarnessEvent[] = [];
  private readonly readers: Array<(event: HarnessEvent) => void> = [];
  private buffer = '';

  constructor(readonly process: ChildProcessWithoutNullStreams) {
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        const event = JSON.parse(line) as HarnessEvent;
        const reader = this.readers.shift();
        if (reader) reader(event);
        else this.pending.push(event);
      }
    });
  }

  send(command: string) {
    this.process.stdin.write(`${command}\n`);
  }

  next(): Promise<HarnessEvent> {
    const event = this.pending.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve, reject) => {
      this.readers.push(resolve);
      this.process.once('exit', (code) => reject(new Error(`Python harness exited ${code}`)));
    });
  }
}

const CLEANUP_PY = String.raw`
import asyncio
import os
import sys
import flow_sdk
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.email_inbox import EmailInbox

async def main():
    await flow_sdk.auth.login()
    agent = await Agent.get_one({"id": sys.argv[1]})
    if agent is not None:
        try:
            inbox = await EmailInbox.for_agent(agent)
            if inbox is not None:
                await inbox.release()
        except Exception:
            pass
        source = await DataSource.find_for_account("cloud_email", "agent_id", agent.id)
        if source is not None:
            await source.delete()
        if agent.remote:
            await agent.unshare()
        await agent.delete()
    if sys.argv[2] == "1":
        gmail = await DataSource.find_for_account("gmail", "address", os.environ["GMAIL_ADDRESS"])
        if gmail is not None:
            await gmail.delete()

asyncio.run(main())
`;
const execFileAsync = promisify(execFile);
let fallbackAgentId = '';
let fallbackGmailCreated = '0';
let fallbackEnv: NodeJS.ProcessEnv = {};

async function cleanup(agentId: string, gmailCreated: string, env: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync('uv', ['run', 'python', '-c', CLEANUP_PY, agentId, gmailCreated], {
    cwd: ROOT,
    env,
  });
}

async function openAgentInbox(page: Page, agentId: string): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
  await page.goto(`/dock/agent/${agentId}/inbox`);
  await expect(page.getByTestId('agent-inbox-view')).toBeVisible();
}

test.afterEach(async () => {
  if (!fallbackAgentId) return;
  await cleanup(fallbackAgentId, fallbackGmailCreated, fallbackEnv);
  fallbackAgentId = '';
});

test('enable email, receive Gmail, and show the pirate reply in UI and Gmail', async ({ page }) => {
  test.skip(!localEnv.GMAIL_ADDRESS || !localEnv.GMAIL_APP_PASSWORD, 'Gmail app-password credentials are not configured');

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...localEnv,
    FLOW_INSTANCE: process.env.FLOW_INSTANCE || localEnv.FLOW_INSTANCE || 'oss',
    FLOWPAD_HUB_URL: process.env.FLOWPAD_HUB_URL || 'http://localhost:8093',
  };
  const child = spawn('uv', ['run', 'python', '-u', '-c', PYTHON], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const harness = new PythonHarness(child);
  const stderr: string[] = [];
  let agentId = '';
  let gmailCreated = '0';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));

  try {
    const ready = await harness.next();
    expect(ready.kind).toBe('ready');
    agentId = ready.agent_id;
    gmailCreated = ready.gmail_created;
    fallbackAgentId = agentId;
    fallbackGmailCreated = gmailCreated;
    fallbackEnv = childEnv;
    await openAgentInbox(page, ready.agent_id);

    await page.getByRole('button', { name: 'Create email for agent', exact: true }).click();
    await expect(page.getByTestId('agent-inbox-address')).toBeVisible();
    const inboxAddress = (await page.getByTestId('agent-inbox-address').textContent())?.trim() ?? '';
    expect(inboxAddress).toContain('@');

    await page.getByTestId('agent-email-allowed-senders').fill(ready.gmail_address);
    await page.getByTestId('agent-inbox-settings').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Inbox settings saved')).toBeVisible();

    harness.send(`SEND ${inboxAddress}`);
    expect((await harness.next()).kind).toBe('sent');

    const row = page.getByTestId('inbox-conversation-row').filter({ hasText: `Pirate UI ${ready.nonce}` });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText(`Where is the treasure? Request code: ${ready.nonce}`, { exact: false })).toBeVisible();

    const reply = await harness.next();
    expect(reply.kind).toBe('reply');
    expect(reply.author).toBe(inboxAddress);
    expect(reply.body.toLowerCase()).toContain('arr');
    expect(reply.body).toContain(ready.nonce);
    await expect(page.getByText(/arr/i).last()).toBeVisible();
    await page.getByTestId('thread-stack-open').click();
    await expect(page.getByTestId('email-message-headers')).toHaveCount(2);

    harness.send('CLEANUP');
    expect((await harness.next()).kind).toBe('clean');
    agentId = '';
    fallbackAgentId = '';
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    if (agentId) {
      await cleanup(agentId, gmailCreated, childEnv);
      fallbackAgentId = '';
    }
    if (stderr.length && child.exitCode && child.exitCode !== 0) {
      console.error(stderr.join('').slice(-2000));
    }
  }
});
