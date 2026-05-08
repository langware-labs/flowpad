/**
 * WorkflowTracePreviewPage — dev-only standalone view for the WorkflowTraceViewer.
 *
 * Iteration loop:
 *   1. Run /tmp/run_workflow_demo.py once to produce trace + analysis
 *   2. Open one of these URLs:
 *        /dev/trace/<runner_id>             — loads via AgenticProcess entity
 *        /dev/trace/path?p=<absolute_path>  — points at an output folder directly
 *   3. Hot-reload viewer changes — page re-renders against the same on-disk
 *      artifacts; no demo re-run needed unless the schema changes.
 *
 * The path-based form exists because the demo's AgenticProcess row may not
 * always be visible to the running backend's entity layer (different DB,
 * different records root in dev mode). The path mode is a no-frills bypass
 * that just reads the trace + analysis files directly.
 *
 * Note: the URL param is named `runId` (not `processId`) to avoid colliding
 * with `loadAgentApp`'s shared loader, which interprets `:processId` as a
 * Flow entity id and 404s when it isn't.
 */

import { useParams, useSearchParams } from "react-router";

import { WorkflowTraceViewer } from "./WorkflowTraceViewer";

export function WorkflowTracePreviewPage() {
  const { runId } = useParams<{ runId: string }>();
  const [searchParams] = useSearchParams();
  const explicitPath = searchParams.get("p");

  if (runId === "path") {
    if (!explicitPath) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
          Pass an output folder via ?p=&lt;absolute path&gt;.
        </div>
      );
    }
    return (
      <WorkflowTraceViewer
        outputFolderPath={explicitPath}
        onBack={() => {
          if (window.history.length > 1) {
            window.history.back();
          } else {
            window.close();
          }
        }}
      />
    );
  }

  if (!runId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No run id in URL. Use /dev/trace/&lt;agentic_process_id&gt; or
        /dev/trace/path?p=&lt;absolute folder path&gt;.
      </div>
    );
  }

  return (
    <WorkflowTraceViewer
      processId={runId}
      onBack={() => {
        if (window.history.length > 1) {
          window.history.back();
        } else {
          window.close();
        }
      }}
    />
  );
}
