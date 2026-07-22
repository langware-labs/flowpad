export type TopicTagKind = 'button' | 'input' | 'label';

/**
 * Declare a component's place in the topic ontology. One tag, three powers:
 * the same word the wiki-highlight system targets, now also observable — the
 * global UiTopicEmitter turns interactions with tagged elements into
 * `app.ui.<kind>.clicked` bus events. Components never wire listeners.
 */
export function topicTag(target: string, kind: TopicTagKind): Record<string, string> {
  return { 'data-topic': target, 'data-topic-kind': kind };
}
