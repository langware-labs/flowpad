/**
 * The data source matrix, TS SDK surface: shipped data sources × verbs, through `DataSource`.
 *
 * The same verbs the REST and CLI matrices drive (`tests/api/test_source_matrix.py`), called the way
 * the Data Sources screen calls them: create, verify, syncNow, items, send, reply, setEnabled,
 * delete. The api tier runs against a live backend, so a provider can be doubled only where the
 * source's manifest lets config point it somewhere — a feed URL, a `base_url`, a local tree. Those
 * doubles are served from this process; the rest of the matrix is the Python tiers' and the live
 * tier's.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataSource, credentialsService, secretsService } from '@sdk';
import { apiTestSetup } from '../utils/test-utils';
import { testEntityName } from '../_cleanup';

const ASSETS = path.resolve(__dirname, '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver');
const NOW_ISO = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

type Handler = (req: IncomingMessage, body: string) => { status?: number; json?: unknown; text?: string; type?: string };

let server: Server;
let base = '';
let handler: Handler = () => ({ status: 404, json: {} });
let tmpRoot = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const answer = handler(req, body);
      res.writeHead(answer.status ?? 200, { 'Content-Type': answer.type ?? 'application/json' });
      res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flowpad-source-matrix-')));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await apiTestSetup();
});

interface Case {
  provider: string;
  config: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** The driver's secret values by `auth` key — never config; `seedAuth` puts them where auth reads them. */
  secrets?: Record<string, string>;
  fields?: Record<string, unknown>;
  serve?: Handler;
  minItems?: number;
  send?: { to: string; text: string; subject?: string };
}

const TELEGRAM_CHAT = '111222333';
const telegramUpdates = () => [{
  update_id: 900001,
  message: { message_id: 7, date: Math.floor(Date.now() / 1000), chat: { id: Number(TELEGRAM_CHAT), type: 'private' }, from: { id: 444, first_name: 'Ada' }, text: 'hello bot' },
}];
let telegramNext = 8;

const CASES: Case[] = [
  {
    provider: 'rss',
    serve: () => ({
      type: 'application/xml',
      text: readFileSync(path.join(ASSETS, 'rss/tests/fixtures/atom.xml'), 'utf8').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, NOW_ISO),
    }),
    config: () => ({ feed_urls: [`${base}/atom`] }),
    minItems: 3,
  },
  {
    provider: 'hackernews',
    serve: (req) => {
      const url = req.url ?? '';
      if (url.startsWith('/updates.json')) return { json: { items: [101, 102], profiles: [] } };
      const id = Number(url.split('/item/')[1]?.split('.json')[0]);
      return { json: { id, type: 'story', by: 'ada', time: Math.floor(Date.now() / 1000) - 60, title: `story ${id}`, score: 100 } };
    },
    config: () => ({ base_url: base }),
    minItems: 2,
  },
  {
    provider: 'telegram',
    serve: (req, body) => {
      const method = (req.url ?? '').split('?')[0].split('/').pop();
      if (method === 'getMe') return { json: { ok: true, result: { id: 777, username: 'matrix_bot' } } };
      if (method === 'getUpdates') return { json: { ok: true, result: telegramUpdates() } };
      const sent = JSON.parse(body || '{}');
      return { json: { ok: true, result: { message_id: telegramNext++, date: Math.floor(Date.now() / 1000), chat: { id: Number(sent.chat_id), type: 'private' }, from: { id: 777, is_bot: true }, text: sent.text } } };
    },
    config: () => ({ base_url: base }),
    secrets: { bot_token: '123:MATRIX' },
    fields: { account_key: '@matrix_bot' },
    minItems: 1,
    send: { to: TELEGRAM_CHAT, text: 'matrix send' },
  },
  {
    provider: 'agentmail',
    serve: (req) => {
      const url = req.url ?? '';
      if (url.includes('/messages/send') || url.endsWith('/reply')) return { json: { message_id: `<sent-${Date.now()}@x>`, thread_id: 't-1' } };
      return { json: { messages: [{ message_id: '<in-1@x>', thread_id: 't-1', timestamp: new Date().toISOString(), from: 'Ada <ada@example.com>', to: ['matrix@agentmail.to'], subject: 'Hi', preview: 'Hello' }] } };
    },
    config: () => ({ inbox: 'matrix@agentmail.to', base_url: base }),
    secrets: { api_key: 'am_matrix' },
    fields: { account_key: 'matrix@agentmail.to' },
    minItems: 1,
    send: { to: 'someone@example.com', text: 'matrix send', subject: 'Matrix' },
  },
  {
    provider: 'folder',
    config: async () => {
      const root = path.join(tmpRoot, 'watched');
      await fs.mkdir(path.join(root, 'sub'), { recursive: true });
      await fs.writeFile(path.join(root, 'a.md'), 'alpha');
      await fs.writeFile(path.join(root, 'sub', 'b.md'), 'bravo');
      return { root };
    },
    fields: { reflect: 'none' },
  },
  {
    provider: 'git',
    config: async () => {
      const repo = path.join(tmpRoot, 'repo');
      await fs.mkdir(repo, { recursive: true });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'matrix@example.com');
      git('config', 'user.name', 'Matrix');
      await fs.writeFile(path.join(repo, 'a.md'), 'a');
      git('add', '-A');
      git('commit', '-q', '-m', 'seed');
      return { repo, branch: 'main' };
    },
    fields: { reflect: 'none' },
  },
];

/**
 * Put a driver's secret values where its manifest's `auth` reads them — a SecretPack (`credential` +
 * `vars`) in this instance's vault, or a machine secret (`secrets`) — and return the undo. `null` when
 * this instance already holds a real one: the matrix never overwrites, or deletes, a person's secret.
 */
async function seedAuth(provider: string, values: Record<string, string>): Promise<(() => Promise<unknown>) | null> {
  const auth = JSON.parse(readFileSync(path.join(ASSETS, provider, 'data_driver.json'), 'utf8')).auth ?? {};
  if (auth.credential) {
    const vars: Record<string, string> = auth.vars ?? {};
    const status = await credentialsService.status();
    if (status.credentials.some((row) => row.name === auth.credential && row.scope === 'user')) return null;
    const { typeid } = await credentialsService.save({
      scope: 'user',
      manifest: {
        name: auth.credential,
        value_store: 'vault',
        vars: Object.fromEntries(Object.values(vars).map((name) => [name, { label: name, secret: true, required: true }])),
      },
      values: Object.fromEntries(Object.entries(values).map(([key, value]) => [vars[key], value])),
    });
    return () => credentialsService.remove(typeid);
  }
  const names = Object.entries(values).map(([key]) => auth.secrets?.[key] as string);
  const held = new Set((await secretsService.list()).map((secret) => secret.name));
  if (names.some((name) => held.has(name))) return null;
  await Promise.all(Object.entries(values).map(([key, value]) => secretsService.write(auth.secrets[key], value)));
  return () => Promise.all(names.map((name) => secretsService.delete(name)));
}

describe('data source matrix — TS SDK', () => {
  for (const c of CASES) {
    it(`${c.provider}: create, verify, sync, items, send, reply, disable, delete`, async (ctx) => {
      handler = c.serve ?? (() => ({ status: 404, json: {} }));
      const forget = c.secrets ? await seedAuth(c.provider, c.secrets) : undefined;
      if (forget === null) ctx.skip(); // a real secret of this driver lives on this instance
      let created: DataSource | undefined;
      try {
        created = await new DataSource({
          name: testEntityName(`data-source-${c.provider}`),
          provider: c.provider,
          config: await c.config(),
          ...(c.fields ?? {}),
        } as never).save();
        const verdict = await created.verify();
        expect(verdict).toHaveProperty('ready');

        const report = await created.syncNow();
        expect(report.health, JSON.stringify(report)).toBe('ok');

        const { items } = await created.items(50);
        expect(items.length).toBeGreaterThanOrEqual(c.minItems ?? 0);

        if (c.send) {
          const sent = await created.send(c.send);
          expect(['sent', 'drafted']).toContain(sent.status);
          const inbound = items.find((item) => item.external_id !== sent.external_id);
          if (inbound) expect((await created.reply(String(inbound.id), 'matrix reply')).external_id).toBeTruthy();
        }

        expect((await created.setEnabled(false)).status).toBe('disabled');
        expect((await created.setEnabled(true)).status).toBe('active');
      } finally {
        await Promise.all([created?.delete(), forget?.()]);
      }
    });
  }
});
