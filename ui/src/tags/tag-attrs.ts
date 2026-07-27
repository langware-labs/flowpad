export type TagKind = 'button' | 'input' | 'label';

/**
 * Declare a component's place in the tag ontology. One tag, three powers:
 * the same word the wiki-highlight system targets, now also observable — the
 * global UiTagEmitter turns interactions with tagged elements into
 * `app.ui.<kind>.clicked` bus events. Components never wire listeners.
 */
export function tagAttrs(target: string, kind: TagKind): Record<string, string> {
  return { 'data-tag': target, 'data-tag-kind': kind };
}
