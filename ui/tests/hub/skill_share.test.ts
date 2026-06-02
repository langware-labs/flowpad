/**
 * Live-hub test: sharing a SKILL travels as a *folder* in the body bundle,
 * and stays a `skill` TYPE_ID on the wire — it must NOT degrade to a flat
 * `data/SKILL.md` FILE attachment.
 *
 * ─── Harness reality (read this before extending) ──────────────────────────
 * The TS hub vitest is a SINGLE SDK client. `dataManager` + `config.SERVER_URL`
 * are process-level singletons, so there is exactly ONE backend per vitest
 * process — "alice", the local backend `apiTestSetup` bootstraps. The
 * counterparty ("bob") is NOT a second SDK client: it's just an email used as a
 * share target, plus a hub bearer token for raw, read-only hub GETs.
 *
 * Therefore this test can only cover the SENDER half (does the skill leave as a
 * skill-folder bundle?). The RECEIVER half your pseudocode wants — accept the
 * invite, sync, download, and resolve `Skill.getById(...)` on the *other* side —
 * needs a SECOND real backend and lives in Python `tests/hub_tests/`
 * (OSS_BE=9008 alice + APP_BE=9009 bob), e.g. test_share_with_recipients.py.
 * See the companion sketch referenced in the PR.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import {
  BODY_FILENAME,
  BodyStatus,
  FlowMessage,
  type IFlowMessage,
} from '@sdk/entities/flow-message';
import { Skill } from '@sdk/entities/skill';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import {
  HUB_URL,
  getAliceCreds,
  getBobCreds,
  hubAvailable,
  hubLogin,
  localBackendIsCloudLoggedIn,
} from './_hub';

let skipReason: string | null = null;
let aliceToken: string | null = null;
let bobEmail: string | null = null;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!(await localBackendIsCloudLoggedIn(config.SERVER_URL))) {
    return void (skipReason = 'local backend is not cloud-logged-in');
  }
  const alice = await getAliceCreds();
  const bob = await getBobCreds();
  if (!alice || !bob) return void (skipReason = 'missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD}');
  aliceToken = (await hubLogin(alice.email, alice.password)).token;
  bobEmail = bob.email;
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

async function hubGetFm(fmId: string): Promise<IFlowMessage> {
  const r = await fetch(`${HUB_URL}/api/v1/graph/flow_message/${fmId}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  if (!r.ok) throw new Error(`hub GET FM ${fmId} → ${r.status}: ${await r.text()}`);
  return (await r.json()).data as IFlowMessage;
}

/** List entries inside the hub's body bundle (a .flowmsg zip) by shelling out
 *  to `unzip -Z1`. Returns null when `unzip` isn't available so the caller can
 *  fall back to a magic-bytes check rather than fail spuriously. */
async function listBundleEntries(fmId: string): Promise<string[] | null> {
  const r = await fetch(
    `${HUB_URL}/api/v1/graph/flow_message/${fmId}/fs/download/${BODY_FILENAME}`,
    { headers: { Authorization: `Bearer ${aliceToken}` } },
  );
  if (!r.ok) throw new Error(`hub bundle download → ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  // .flowmsg is a zip — verify the PK magic regardless of unzip availability.
  expect(bytes[0]).toBe(0x50); // 'P'
  expect(bytes[1]).toBe(0x4b); // 'K'
  const dir = mkdtempSync(join(tmpdir(), 'flowmsg-'));
  const zip = join(dir, 'body.flowmsg');
  writeFileSync(zip, bytes);
  try {
    return execFileSync('unzip', ['-Z1', zip], { encoding: 'utf-8' }).split('\n').filter(Boolean);
  } catch {
    return null; // unzip missing — caller asserts on the magic bytes only
  }
}

describe('hub: sharing a skill keeps it a skill folder', () => {
  it(
    'skill TYPE_ID → READY bundle carrying the .claude/skills/<name>/ folder, not a flat file',
    async () => {
      // A real skill on alice's disk (server creates ~/.claude/skills/<name>/SKILL.md).
      const skill = await Skill.create(`hub-test-skill-${Date.now()}`, 'shared in a hub test');
      expect(skill.id).toBeTruthy();

      const conv = new Conversation({ title: `skill-share-${Date.now()}` });
      await conv.save();
      await conv.share([bobEmail!]); // share = create conversation + invite the email
      expect(conv.remote).toBe(true);

      // Attach the skill as a TYPE_ID (the asset path), NOT as a file.
      const data = await conv.addMessage('here is a skill', {
        attachment: [{ attachment_type: 'type_id', data: `skill-${skill.id}` }],
      });
      const fm = new FlowMessage(data);
      expect(fm.hasBody()).toBe(true);
      expect(fm.body_status).toBe(BodyStatus.UPLOADING);

      // Sender packs the skill folder into body.flowmsg and flips READY.
      await fm.uploadBody();

      const onHub = await hubGetFm(fm.id!);
      expect(onHub.body_status).toBe('ready');
      expect(onHub.attachment_filename).toBe(BODY_FILENAME);

      // Wire contract #1: the skill stays a `skill` TYPE_ID — it must NOT have
      // been turned into a flat FILE named SKILL.md.
      const atts = onHub.attachment ?? [];
      expect(
        atts.some((a) => a.attachment_type === 'type_id' && String(a.data) === `skill-${skill.id}`),
      ).toBe(true);
      expect(
        atts.some((a) => a.attachment_type === 'file' && /SKILL\.md$/i.test(String(a.data))),
      ).toBe(false);

      // Wire contract #2: inside the bundle the skill is a FOLDER subtree
      // (attachment/skill-@<id>/.claude/skills/<name>/SKILL.md), not a flat file.
      const entries = await listBundleEntries(fm.id!);
      if (entries) {
        expect(entries.some((e) => /skill-@.*\/\.claude\/skills\/.+\/SKILL\.md$/.test(e))).toBe(true);
        expect(entries.some((e) => /^(data|attachment\/files)\/SKILL\.md$/.test(e))).toBe(false);
      }
    },
    20_000, // do not increase timeout without approval
  );
});
