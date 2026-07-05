import { ViewType } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod } from '@src/navigation/asset-doc-types';

export type DisplayAnnotationKind =
  | 'website'
  | 'markdown-document'
  | 'asset'
  | 'file'
  | 'diff'
  | 'active-view';

export interface DisplayAnnotationContext {
  kind: DisplayAnnotationKind;
  title: string;
  path?: string;
  url?: string;
  port?: string;
  typeid?: string;
  type?: string;
  viewType?: string;
}

export interface DisplayShowTarget {
  kind?: string;
  typeid?: string;
  type?: string;
  id?: string;
  path?: string;
  port?: number | string;
}

const MARKDOWN_PATH_RE = /\.(?:md|markdown|mdx|mdo|md\.out)$/i;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function isMarkdownDocumentPath(path?: string | null): boolean {
  return Boolean(path && MARKDOWN_PATH_RE.test(path));
}

export function displayAnnotationContextForWebapp(
  host?: string | null,
  port?: string | number | null,
): DisplayAnnotationContext {
  const portText = port != null && port !== '' ? String(port) : undefined;
  return {
    kind: 'website',
    title: portText ? `Website on port ${portText}` : 'Website',
    url: host || undefined,
    port: portText,
    viewType: ViewType.WEB_APP,
  };
}

export function displayAnnotationContextForPath(path: string): DisplayAnnotationContext {
  if (isMarkdownDocumentPath(path)) {
    return {
      kind: 'markdown-document',
      title: 'Markdown document',
      path,
      viewType: ViewType.MARKDOWN,
    };
  }
  return {
    kind: 'file',
    title: 'File',
    path,
    viewType: ViewType.EDITOR,
  };
}

export function displayAnnotationContextForShown(
  shown: DisplayShowTarget,
  host?: string | null,
  port?: string | number | null,
): DisplayAnnotationContext {
  if (shown.kind === 'webapp') {
    return displayAnnotationContextForWebapp(host, shown.port ?? port);
  }

  if (shown.path) {
    return displayAnnotationContextForPath(shown.path);
  }

  if (shown.kind === 'entity') {
    const kind = shown.type === 'markdown' ? 'markdown-document' : 'asset';
    return {
      kind,
      title: kind === 'markdown-document' ? 'Markdown document' : 'Asset',
      type: shown.type,
      typeid: shown.typeid,
    };
  }

  return {
    kind: 'active-view',
    title: 'Active display',
    type: shown.type,
    typeid: shown.typeid,
  };
}

export function displayAnnotationContextForDock(dock?: DockPointer | null): DisplayAnnotationContext {
  if (!dock) return { kind: 'active-view', title: 'Active display' };

  if (dock.viewType === ViewType.WEB_APP) {
    return displayAnnotationContextForWebapp(null, null);
  }

  if (dock.viewType === ViewType.EDITOR && dock.pointer) {
    return displayAnnotationContextForPath(dock.pointer);
  }

  if (
    dock.viewType === ViewType.MARKDOWN ||
    dock.viewType === ViewType.DOCS ||
    dock.viewType === ViewType.PLAN ||
    dock.viewType === ViewType.SPEC
  ) {
    return {
      kind: 'markdown-document',
      title: 'Markdown document',
      path: dock.pointer,
      viewType: dock.viewType,
    };
  }

  if (dock.viewType === ViewType.DIFF) {
    return {
      kind: 'diff',
      title: 'Diff',
      path: dock.pointer,
      viewType: dock.viewType,
    };
  }

  if (dock.viewType === ViewType.ASSETS && dock.pointer) {
    try {
      const ptr = AssetDocPointer.parse(dock.pointer);
      if (ptr.mode === AssetMode.WIKI) {
        return {
          kind: 'markdown-document',
          title: 'Markdown document',
          path: ptr.wikiName,
          viewType: dock.viewType,
        };
      }
      if (ptr.mode === AssetMode.EDITOR) {
        const isMarkdown =
          ptr.editor === AssetEditor.MARKDOWN ||
          (ptr.method === AssetRoutingMethod.VFS && isMarkdownDocumentPath(ptr.value));
        return {
          kind: isMarkdown ? 'markdown-document' : 'asset',
          title: isMarkdown ? 'Markdown document' : 'Asset',
          path: ptr.method === AssetRoutingMethod.VFS ? ptr.value : undefined,
          typeid: ptr.method === AssetRoutingMethod.TYPEID ? ptr.value : undefined,
          type: ptr.editor,
          viewType: dock.viewType,
        };
      }
    } catch {
      // Fall through to the generic dock context. A malformed pointer should not
      // block a user from submitting an annotated screenshot.
    }
  }

  return {
    kind: 'active-view',
    title: 'Active display',
    path: dock.pointer,
    viewType: dock.viewType,
  };
}

export function displayAnnotationImageName(context: DisplayAnnotationContext, date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  const target = slug(context.path || context.url || context.title || context.kind) || 'display';
  return `${context.kind}-${target}-${stamp}.png`;
}

function targetKindLabel(kind: DisplayAnnotationKind): string {
  switch (kind) {
    case 'website':
      return 'website';
    case 'markdown-document':
      return 'Markdown document';
    case 'asset':
      return 'asset';
    case 'file':
      return 'file';
    case 'diff':
      return 'diff';
    case 'active-view':
    default:
      return 'active display';
  }
}

export function buildDisplayAnnotationPrompt({
  fileName,
  filePath,
  context,
}: {
  fileName: string;
  filePath: string;
  context: DisplayAnnotationContext;
}): string {
  const lines = [
    'The user annotated the active display view.',
    'The attached screenshot contains visual instructions from the user. Use the marks and text on it as the requested change or issue description.',
    `Target kind: ${targetKindLabel(context.kind)}.`,
    `Target: ${context.title}.`,
  ];

  if (context.kind === 'website') {
    lines.push('Apply the annotation to the website/web app currently shown in the active display.');
  } else if (context.kind === 'markdown-document') {
    lines.push('Apply the annotation to the Markdown document currently shown in the active display.');
  }

  if (context.path) lines.push(`Target path: ${context.path}`);
  if (context.url) lines.push(`Target URL: ${context.url}`);
  if (context.port) lines.push(`Target port: ${context.port}`);
  if (context.type) lines.push(`Target type: ${context.type}`);
  if (context.typeid) lines.push(`Target typeid: ${context.typeid}`);
  if (context.viewType) lines.push(`Target view: ${context.viewType}`);

  lines.push('', `Annotated screenshot: ${fileName}`, `File path: ${filePath}`);
  return lines.join('\n');
}
