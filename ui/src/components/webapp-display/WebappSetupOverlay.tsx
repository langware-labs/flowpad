import { Trans } from '@lingui/react/macro';
import type { SetupTreeResult } from '@sdk';
import { AskForm } from '@src/components/ask/AskForm';
import { SetupTreeView } from '@src/components/project-setup/SetupTreeView';

/**
 * "Setting things up" — what a web app's display shows while the app's setup runs (its node of the
 * project's setup tree: what it needs, then install → build → start). The live tree, and the question
 * the setup is waiting on drawn in place; the app itself takes over once its node is done.
 */
export function WebappSetupOverlay({
  tree,
  questionId,
  onQuestionSettled,
}: {
  tree: SetupTreeResult | null;
  questionId: string | null;
  onQuestionSettled: () => void;
}) {
  return (
    <div
      className="flex h-full w-full items-start justify-center overflow-auto bg-background p-8"
      data-testid="webapp-setting-up"
    >
      <div className="flex w-full max-w-xl flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-foreground" />
          <h2 className="text-lg font-semibold">
            <Trans>Setting things up</Trans>
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          <Trans>Your app is starting. Everything it needs comes up first — this page opens on the app when it is ready.</Trans>
        </p>
        {questionId && (
          <div className="rounded border p-3" data-testid="webapp-setup-question">
            <AskForm questionId={questionId} showOp={false} onSettled={onQuestionSettled} />
          </div>
        )}
        <SetupTreeView tree={tree} />
      </div>
    </div>
  );
}
