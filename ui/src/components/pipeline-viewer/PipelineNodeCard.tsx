import type { PipelineNode } from '@sdk';
import { Bot, CirclePlay, CircleStop, GitBranch, GitFork, MessageSquare } from 'lucide-react';
import React from 'react';

const NODE_W = 180;
const NODE_H = 72;

export { NODE_W, NODE_H };

const TYPE_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  start:  { bg: 'bg-green-50',  border: 'border-green-400', text: 'text-green-700' },
  end:    { bg: 'bg-gray-50',   border: 'border-gray-400',  text: 'text-gray-600'  },
  task:   { bg: 'bg-white',     border: 'border-blue-300',  text: 'text-blue-800'  },
  switch: { bg: 'bg-amber-50',  border: 'border-amber-400', text: 'text-amber-700' },
  fork:   { bg: 'bg-purple-50', border: 'border-purple-400',text: 'text-purple-700'},
  input:  { bg: 'bg-sky-50',    border: 'border-sky-400',   text: 'text-sky-700'   },
};

function NodeIcon({ type }: { type: string }) {
  const cls = 'h-4 w-4 flex-shrink-0';
  switch (type) {
    case 'start':  return <CirclePlay  className={cls} />;
    case 'end':    return <CircleStop  className={cls} />;
    case 'task':   return <Bot         className={cls} />;
    case 'switch': return <GitBranch   className={cls} />;
    case 'fork':   return <GitFork     className={cls} />;
    case 'input':  return <MessageSquare className={cls} />;
    default:       return <Bot         className={cls} />;
  }
}

interface PipelineNodeCardProps {
  node: PipelineNode;
}

export function PipelineNodeCard({ node }: PipelineNodeCardProps) {
  const style = TYPE_STYLES[node.type] ?? TYPE_STYLES.task;

  const inputPorts = Object.keys(node.inputs);
  const outputPorts = Object.keys(node.outputs);

  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      className={`relative flex flex-col justify-center rounded-lg border-2 px-3 py-2 shadow-sm ${style.bg} ${style.border}`}
    >
      {/* Port dots — left side (inputs) */}
      {inputPorts.map((_, i) => (
        <div
          key={i}
          className="absolute -left-[6px] h-3 w-3 rounded-full border-2 border-white bg-gray-400"
          style={{ top: NODE_H / 2 - 6 + i * 14 }}
        />
      ))}

      {/* Content */}
      <div className={`flex items-center gap-2 ${style.text}`}>
        <NodeIcon type={node.type} />
        <span className="truncate text-xs font-semibold leading-tight">{node.label}</span>
      </div>
      {node.description && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{node.description}</p>
      )}

      {/* Port dots — right side (outputs) */}
      {outputPorts.map((_, i) => (
        <div
          key={i}
          className="absolute -right-[6px] h-3 w-3 rounded-full border-2 border-white bg-gray-400"
          style={{ top: NODE_H / 2 - 6 + i * 14 }}
        />
      ))}
    </div>
  );
}
