import { Trans } from '@lingui/react/macro';
import type { SetupNodeResult, SetupTreeResult } from '@sdk';
import { CheckCircle2, Circle, CornerDownRight, Hourglass, Loader2, Lock, XCircle } from 'lucide-react';

/**
 * The setup tree as it stands: every asset of the project (or of one node of it), indented under what
 * needs it, each with its state — done, running, failed (and why), or blocked (waiting on a child).
 * Leaves come up first, so reading it top-down is reading what the project is waiting for.
 *
 * Failures are marked by their row, not their text: red text on a dark surface is unreadable.
 */
export function SetupTreeView({ tree, hideRoot = false }: { tree: SetupTreeResult | null; hideRoot?: boolean }) {
  if (!tree) return null;
  if (!tree.root) {
    // Refused before anything ran (a cycle in the tree, an untrusted callee): no nodes to draw — the reason
    // is the whole story.
    return tree.detail ? (
      <p
        className="rounded border-l-2 border-red-500 bg-red-500/15 px-3 py-2 text-sm text-foreground"
        data-testid="setup-tree-refused"
      >
        {tree.detail}
      </p>
    ) : null;
  }
  const nodes = hideRoot ? tree.root.children : [tree.root];
  return (
    <div className="flex flex-col gap-2" data-testid="setup-tree">
      <p className="text-xs text-muted-foreground" data-testid="setup-tree-progress">
        <Trans>
          {tree.done} of {tree.total} set up
        </Trans>
      </p>
      <ul className="flex flex-col gap-0.5 text-sm">
        {nodes.map((node) => (
          <SetupNodeRow key={node.id} node={node} depth={0} />
        ))}
      </ul>
    </div>
  );
}

function SetupNodeRow({ node, depth }: { node: SetupNodeResult; depth: number }) {
  const failed = node.state === 'failed' || node.state === 'refused';
  return (
    <>
      <li
        className={`flex items-start gap-2 rounded px-2 py-1 ${
          failed ? 'border-l-2 border-red-500 bg-red-500/15 text-foreground' : ''
        }`}
        style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
        data-testid={`setup-node-${node.id}`}
        data-state={node.state}
      >
        <StateIcon node={node} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{node.label || node.id}</span>
          {node.detail && node.state !== 'done' && (
            <span className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{node.detail}</span>
          )}
        </span>
      </li>
      {!node.shared && node.children.map((child) => <SetupNodeRow key={child.id} node={child} depth={depth + 1} />)}
    </>
  );
}

function StateIcon({ node }: { node: SetupNodeResult }) {
  const cls = 'mt-0.5 size-4 shrink-0';
  if (node.shared) return <CornerDownRight className={`${cls} text-muted-foreground`} />;
  switch (node.state) {
    case 'done':
      return <CheckCircle2 className={`${cls} text-emerald-600`} />;
    case 'running':
      return <Loader2 className={`${cls} animate-spin text-primary`} />;
    case 'failed':
    case 'refused':
      return <XCircle className={`${cls} text-red-500`} />;
    case 'blocked':
      return <Lock className={`${cls} text-amber-600`} />;
    case 'held':
      return <Hourglass className={`${cls} text-muted-foreground`} />;
    default:
      return <Circle className={`${cls} text-muted-foreground`} />;
  }
}
