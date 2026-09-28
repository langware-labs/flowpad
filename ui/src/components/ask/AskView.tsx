import { Trans } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AskForm } from './AskForm';

/**
 * A question a ComputeOp put to a person, drawn as the whole `win/` window.
 *
 * `win/` is the chrome-less focus layout: the routed view IS the window, so this renders the
 * surface and nothing around it. The form itself is `AskForm`, shared with the setup screens
 * that draw a run's questions in place.
 */
export default function AskView() {
  // The pointer comes from the parsed dock address, not from a route param:
  // the route is `:viewType/*`, so react-router never names this segment.
  const { currentDock } = useDockNavigation();
  const questionId = currentDock?.pointer;
  if (!questionId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          <Trans>This question is no longer waiting.</Trans>
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col p-6">
      <AskForm questionId={questionId} />
    </div>
  );
}
