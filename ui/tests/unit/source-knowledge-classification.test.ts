import { expect, it } from 'vitest';
import { DataDriver, DataSource } from '@sdk';
import { isKnowledgeSource, isMessageChannel } from '@src/components/data-sources/use-source-specs';

it('offers read-only mail as knowledge while keeping writable message sources as channels', () => {
  const mail = new DataDriver({ name: 'gmail', sends: true });
  const files = new DataDriver({ name: 'files', sends: false });
  const sources = [
    new DataSource({ name: 'Read-only mail', provider: 'gmail', channel: 'a@x', read_only: true }),
    new DataSource({ name: 'Agent mail', provider: 'gmail', channel: 'b@x', read_only: false }),
    new DataSource({ name: 'Legacy mail', provider: 'gmail', channel: 'c@x' }),
    new DataSource({ name: 'Project files', provider: 'files', read_only: false }),
  ];
  const knowledge = (source: DataSource) => isKnowledgeSource(source, source.provider === 'gmail' ? mail : files);
  expect(sources.filter(knowledge).map((source) => source.name)).toEqual(['Read-only mail', 'Project files']);
  expect(sources.filter((source) => !knowledge(source)).map((source) => source.name)).toEqual(['Agent mail', 'Legacy mail']);
  expect(sources[0].owner).toBeFalsy(); // Classification does not bind the mailbox to an answering agent.
});

// Same four cases as `agent_scope.is_message_source` — the two spellings must agree.
it('matches the backend message-source rule', () => {
  const sends = new DataDriver({ name: 'gmail', sends: true });
  const pulls = new DataDriver({ name: 'rss', sends: false });
  expect(isMessageChannel(new DataSource({ provider: 'gmail', channel: 'a@x' }), sends)).toBe(true);
  expect(isMessageChannel(new DataSource({ provider: 'gmail', channel: '' }), sends)).toBe(false);
  expect(isMessageChannel(new DataSource({ provider: 'gmail', channel: 'a@x', read_only: true }), sends)).toBe(false);
  expect(isMessageChannel(new DataSource({ provider: 'rss', channel: 'feed' }), pulls)).toBe(false);
});
