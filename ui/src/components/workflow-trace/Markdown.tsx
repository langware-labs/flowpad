/**
 * Lightweight markdown renderer used by Memory / Feedback / Learning-log panels.
 *
 * Same shape as the inline renderer that was inside `WorkflowTraceViewer.tsx` —
 * extracted so all panels stay visually consistent. Strips YAML frontmatter,
 * renders headings (h1–h4), bulleted lists (single-level), paragraphs, and
 * preserves inline `code` spans. Falls through unknown lines as plain text.
 */

import { Fragment, type ReactNode } from "react";

function renderInline(text: string): ReactNode {
  if (!text.includes("`")) return text;
  const parts = text.split(/(`[^`]+`)/);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

interface MarkdownProps {
  text: string;
  /** When true, strip a leading YAML frontmatter block. */
  stripFrontmatter?: boolean;
  className?: string;
}

export function Markdown({
  text,
  stripFrontmatter = true,
  className,
}: MarkdownProps) {
  const stripped = stripFrontmatter
    ? text.replace(/^---\n[\s\S]*?\n---\n*/, "").trim()
    : text.trim();

  const lines = stripped.split("\n");
  const blocks: ReactNode[] = [];
  let paraBuf: string[] = [];
  let listBuf: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    blocks.push(
      <p key={`p-${key++}`} className="!my-1 text-sm leading-relaxed">
        {renderInline(paraBuf.join(" "))}
      </p>,
    );
    paraBuf = [];
  };

  const flushList = () => {
    if (listBuf.length === 0) return;
    blocks.push(
      <ul key={`l-${key++}`} className="!my-1 list-disc space-y-0.5 pl-5 text-sm leading-relaxed">
        {listBuf.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    listBuf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flushPara();
      flushList();
      continue;
    }
    const heading = trimmed.match(/^(#+)\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(4, heading[1].length);
      const cls = {
        1: "!mt-2 !mb-1 text-xl font-semibold",
        2: "!mt-3 !mb-1 text-lg font-semibold",
        3: "!mt-2 !mb-0.5 text-base font-semibold",
        4: "!mt-2 !mb-0.5 text-sm font-semibold",
      }[level];
      const Tag = (`h${level}` as "h1" | "h2" | "h3" | "h4");
      blocks.push(
        <Tag key={`h-${key++}`} className={cls}>
          {renderInline(heading[2])}
        </Tag>,
      );
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushPara();
      listBuf.push(bullet[1]);
      continue;
    }
    flushList();
    paraBuf.push(trimmed);
  }
  flushPara();
  flushList();

  return <div className={className}>{blocks}</div>;
}
