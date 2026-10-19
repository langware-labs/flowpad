import type { TypeId } from '@sdk';
import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';

import { createChildTeam } from '@src/components/organization/create-child-team';
import { notify } from '@src/notifications';

interface CreateChildTeamFormOptions {
  parentTypeId: TypeId;
  parentLabel: string;
  isOrganization: boolean;
  organizationCreatedTitle: string;
  onCreated: () => void;
}

/** Shared mutation state for the page and graph-drawer team creation controls. */
export function useCreateChildTeamForm({
  parentTypeId,
  parentLabel,
  isOrganization,
  organizationCreatedTitle,
  onCreated,
}: CreateChildTeamFormOptions) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await createChildTeam(parentTypeId, trimmed);
      setName('');
      setOpen(false);
      notify.success({
        title: isOrganization ? organizationCreatedTitle : t`Sub-team created`,
        message: t`${trimmed} was added to ${parentLabel}.`,
        id: 'org-create-team',
      });
      onCreated();
    } catch (err) {
      notify.error({
        title: t`Could not create`,
        message: err instanceof Error ? err.message : t`Unknown error.`,
        id: 'org-create-team',
      });
    } finally {
      setBusy(false);
    }
  }, [busy, isOrganization, name, onCreated, organizationCreatedTitle, parentLabel, parentTypeId, t]);

  return { open, setOpen, name, setName, busy, submit };
}
