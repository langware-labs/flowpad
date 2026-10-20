import { expect, it } from 'vitest';
import { isAnonymousEntryPath } from '@src/routes/anonymous-entry';

const ID = '72433d29-b78b-4917-913b-e0ee952bd06f';

it("a message's email link renders signed out (it offers its own Log in)", () => {
  expect(isAnonymousEntryPath(`/flow_message/${ID}`)).toBe(true);
  expect(isAnonymousEntryPath(`/flow_message/${ID}/`)).toBe(true);
});

it('nothing else under it, and no other page, renders signed out', () => {
  expect(isAnonymousEntryPath(`/flow_message/${ID}/attachments`)).toBe(false);
  expect(isAnonymousEntryPath('/flow_message/not-an-id')).toBe(false);
  expect(isAnonymousEntryPath(`/dock/conversation/${ID}`)).toBe(false);
  expect(isAnonymousEntryPath('/launch')).toBe(true);
});
