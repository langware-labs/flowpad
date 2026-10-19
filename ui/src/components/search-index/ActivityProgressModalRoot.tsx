import { useLingui } from '@lingui/react/macro';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { useActivityModalStore } from '@src/store/use-activity-modal-store';
import { activityHeaderTitle } from './activity-labels';
import { ActivityProgressModal } from './ActivityProgressModal';

export function ActivityProgressModalRoot() {
  const open = useActivityModalStore((s) => s.open);
  const setOpen = useActivityModalStore((s) => s.setOpen);
  const { currentActivity, progressTable } = useSystemTools();
  const { t } = useLingui();

  return (
    <ActivityProgressModal
      open={open}
      onOpenChange={setOpen}
      table={progressTable}
      title={currentActivity ? activityHeaderTitle(currentActivity, progressTable) : t`Activity`}
    />
  );
}
