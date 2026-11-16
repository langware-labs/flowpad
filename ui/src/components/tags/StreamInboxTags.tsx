import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { dataManager, FlowMessage, Tag } from '@sdk';
import type { MessageClassificationSettings } from '@sdk/entities/flow-message';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { EntityChip } from '@src/components/conversation/EntityChip';
import { errorMessage } from '@src/lib/error-message';
import { streamInboxTagsQuery, tagChipStyle, useTagDefinitions } from './MessageTags';
import { tagReturnContext } from './message-tag-navigation';

/** Existing Tag entities and generic CRUD, exposed beside their existing graph viewer. */
export function StreamInboxTags() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const { data: tags = [], refetch } = useEntitiesQuery<Tag>(streamInboxTagsQuery);
  const definitions = useTagDefinitions();
  const [settings, setSettings] = useState<MessageClassificationSettings | null>(null);
  const [editing, setEditing] = useState<Tag | 'new' | null>(null);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#7c3aed');
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<{ messages: number; automations: number } | null>(null);
  const loadedEditor = useRef('');
  const editorKey = currentDock?.options?.creating === 'tag' ? 'new' : currentDock?.options?.editing ?? '';
  useEffect(() => {
    if (!editorKey) { loadedEditor.current = ''; setEditing(null); return; }
    if (loadedEditor.current === editorKey) return;
    const tag = editorKey === 'new' ? 'new' : tags.find((item) => item.id === editorKey);
    if (!tag) return;
    loadedEditor.current = editorKey;
    setEditing(tag); setName(tag === 'new' ? '' : tag.name ?? '');
    setTitle(tag === 'new' ? '' : tag.title ?? '');
    setDescription(tag === 'new' ? '' : tag.description ?? '');
    setColor(tag === 'new' ? '#7c3aed' : tag.color ?? '#7c3aed'); setError(null);
  }, [editorKey, tags]);
  useEffect(() => {
    setImpact(null);
    if (!deleting) return;
    let active = true;
    void deleting.messageTagImpact().then((value) => { if (active) setImpact(value); }).catch((e) => { if (active) setError(errorMessage(e, t`Could not inspect tag usage`)); });
    return () => { active = false; };
  }, [deleting, t]);
  const tagsPointer = () => currentDock!.withOption('creating', null).withOption('editing', null).withOption('result', null).withOption('result_tag', null).withOption('settings', null);
  useEffect(() => {
    void FlowMessage.classificationSettings()
      .then(setSettings)
      .catch((e) => setError(errorMessage(e, t`Could not read classification settings`)));
  }, [t]);
  const edit = (tag: Tag | 'new') => {
    navigation.openDock(tagsPointer().withOption(tag === 'new' ? 'creating' : 'editing', tag === 'new' ? 'tag' : tag.id));
  };
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const values = { name: name.trim(), title: title.trim() || name.trim().split('.').at(-1) || name.trim(), description, color, stream_inbox: true };
      if (editing === 'new') await new Tag(values).save();
      else if (editing.name === values.name)
        await dataManager.save(editing.typeId, [], { ...editing.toJSON(), ...values });
      else {
        await editing.renameMessageTag({ name: values.name, title: values.title, description, color });
      }
      await refetch();
      navigation.openDock(tagsPointer().withOption('result', editing === 'new' ? 'created' : 'edited').withOption('result_tag', values.name));
    } catch (e) {
      setError(errorMessage(e, t`Could not save tag`));
    } finally {
      setBusy(false);
    }
  };
  const updateSettings = async (patch: Partial<MessageClassificationSettings>) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await FlowMessage.classificationSettings(patch));
      if ('include_flow_tags' in patch && currentDock) navigation.openDock(currentDock.withOption('settings', 'flow'));
    } catch (e) {
      setError(errorMessage(e, t`Could not save classification settings`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="stream-inbox-tags-page">
      <header className="flex items-center gap-2 border-b border-border p-4">
        <h1 className="flex-1 text-lg font-semibold">
          <Trans>Stream Inbox tags</Trans>
        </h1>
        <Button variant="outline" size="sm" onClick={() => navigation.openDock(DockPointer.forTagGraph())}>
          <Trans>Tag graph</Trans>
        </Button>
        <Button size="sm" data-testid="stream-inbox-tags-create" onClick={() => edit('new')}>
          <Trans>New tag</Trans>
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <p className="text-sm text-muted-foreground">
          <Trans>New incoming messages use your ontology. Existing messages are not reclassified.</Trans>
        </p>
        {settings && (
          <div className="flex flex-wrap gap-4 text-sm" data-testid="stream-inbox-tags-settings">
            <label className="flex items-center gap-2">
              <Switch
                checked={settings.enabled}
                disabled={busy}
                onCheckedChange={(enabled) => void updateSettings({ enabled })}
                data-testid="message-classification-enabled"
              />
              <Trans>Classify arriving messages</Trans>
            </label>
            <label className="flex items-center gap-2">
              <Switch
                checked={settings.include_flow_tags}
                disabled={busy}
                onCheckedChange={(include_flow_tags) => void updateSettings({ include_flow_tags })}
                data-testid="message-classification-flow-tags"
              />
              <Trans>Include Flowpad message tags</Trans>
            </label>
          </div>
        )}
        {settings?.include_flow_tags && <div className="flex flex-wrap gap-1" data-testid="stream-inbox-flow-tags">
          {definitions.filter((tag) => tag.system && tag.stream_inbox).map((tag) => <EntityChip key={tag.id}
            entity={{ type: Tag.type, id: tag.id, name: tag.name?.split('.').at(-1) }} style={tagChipStyle(tag.color)}
            onClick={() => navigation.openDock(DockPointer.forTagGraph(tag.name))} />)}
        </div>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {currentDock?.options?.result && <div role="status" data-testid="stream-inbox-tag-result" className="flex items-center gap-3 rounded border border-border p-3 text-sm">
          <span>{currentDock.options.result === 'created' ? t`Tag created` : currentDock.options.result === 'edited' ? t`Changes saved` : t`Tag deleted`}</span>
          <Button variant="outline" size="sm" data-testid="stream-inbox-tag-back" onClick={() => navigation.openDock(currentDock.options?.result === 'created'
            ? DockPointer.forTagGraph(currentDock.options.origin_tag || currentDock.options.result_tag, { carry: tagReturnContext(currentDock.options) })
            : tagsPointer())}>{currentDock.options.result === 'created' ? t`Back to tag` : t`Back to tags`}</Button>
        </div>}
        {currentDock?.options?.settings === 'flow' && settings && <Button data-testid="stream-inbox-tags-save-preferences" variant="outline"
          onClick={() => { void FlowMessage.classificationSettings(settings).then(() => navigation.openDock(tagsPointer())).catch((e) => setError(errorMessage(e, t`Could not save classification settings`))); }}><Trans>Save preferences</Trans></Button>}
        {editing && (
          <form
            data-testid="stream-inbox-tag-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="space-y-3 rounded-md border border-border p-3"
          >
            <h2 className="font-medium">{editing === 'new' ? t`New tag` : t`Edit tag`}</h2>
            <label className="block text-sm">
              <Trans>Name</Trans>
              <input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                data-testid="stream-inbox-tag-name"
                className="mt-1 block w-full rounded border border-input bg-background p-2"
              />
            </label>
            <label className="block text-sm">
              <Trans>Title</Trans>
              <input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="stream-inbox-tag-title" className="mt-1 block w-full rounded border border-input bg-background p-2" />
            </label>
            <label className="block text-sm">
              <Trans>Description</Trans>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                data-testid="stream-inbox-tag-description"
                className="mt-1 block w-full rounded border border-input bg-background p-2"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Trans>Color</Trans>
              <input
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                data-testid="stream-inbox-tag-color"
                className="h-8 w-10 rounded bg-background"
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !name.trim()} data-testid="stream-inbox-tag-save">
                <Trans>Save</Trans>
              </Button>
              <Button type="button" variant="outline" data-testid="stream-inbox-tag-cancel" onClick={() => navigation.openDock(tagsPointer())}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        )}
        <div className="divide-y divide-border rounded-md border border-border" data-testid="stream-inbox-tags-list">
          {tags
            .filter((tag) => !tag.deprecated && (!tag.system || tag.stream_inbox))
            .map((tag) => (
              <div key={tag.id} className="flex items-center gap-3 p-3" data-testid={`stream-inbox-tag-row-${tag.name}`}>
                <EntityChip
                  entity={{ type: Tag.type, id: tag.id, name: tag.name?.split('.').at(-1) }}
                  style={tagChipStyle(tag.color)}
                  title={tag.name ?? ''}
                  onClick={() => navigation.openDock(DockPointer.forTagGraph(tag.name, { carry: tagReturnContext(currentDock?.options) }))}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {tag.description || tag.name}
                </span>
                {!tag.system && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`stream-inbox-tag-edit-${tag.name}`}
                      onClick={() => edit(tag)}
                    >
                      <Trans>Edit</Trans>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`stream-inbox-tag-delete-${tag.name}`}
                      onClick={() => setDeleting(tag)}
                    >
                      <Trans>Delete</Trans>
                    </Button>
                  </>
                )}
              </div>
            ))}
        </div>
      </div>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        testId="stream-inbox-tag-delete-confirm"
        variant="destructive"
        confirmLabel={t`Delete`}
        title={t`Delete tag`}
        description={impact ? t`Remove this tag from ${impact.messages} messages and disable ${impact.automations} automations. Messages are kept.` : t`Remove this tag's assignments and disable matching automations. Messages are kept.`}
        onConfirm={() => { void (async () => {
          if (!deleting) return;
          try {
            await deleting.deleteMessageTag();
            setDeleting(null);
            await refetch();
            navigation.openDock(tagsPointer().withOption('result', 'deleted'));
          } catch (e) {
            setError(errorMessage(e, t`Could not delete tag`));
          }
        })(); }}
      />
    </section>
  );
}
