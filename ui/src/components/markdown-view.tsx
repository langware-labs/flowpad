import { CodeBlockRunButton } from '@src/components/code-block-run-button';
import { CopyButton } from '@src/components/ui/copy-button';
import React, { useMemo, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { linkEventProps, type LinkHandlers } from '@src/components/links/link-events';
import { useLocaleInfo } from '@src/contexts/locale-context';
import { isWebUrl } from '@src/lib/link-kind';
import remarkLinkRefs from '@src/lib/remark-link-refs';
import { resolveTextDirection, type TextDirection } from '@src/lib/text-direction';

/** Parse the `language-xxx` class rehype-highlight puts on the inner <code>. */
function extractLanguage(children: React.ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  if (React.isValidElement(child)) {
    const cls = (child.props as { className?: string })?.className ?? '';
    const m = cls.match(/language-([\w-]+)/);
    if (m) return m[1];
  }
  return '';
}

/**
 * Code block with a calm header (language label) + Run (for a shell or script
 * block — see `CodeBlockRunButton`) + a Copy button. Theme-aware
 * via semantic tokens. `codeChrome={false}` falls back to a bare <pre> (the
 * review-diff viewer keeps the minimal look).
 */
const headerButtonClass =
  'rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

function CodeBlock({ children, codeChrome }: { children: React.ReactNode; codeChrome: boolean }) {
  const preRef = useRef<HTMLPreElement>(null);
  const { t } = useLingui();

  if (!codeChrome) {
    return (
      <pre
        dir="ltr"
        className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-start font-mono text-sm text-muted-foreground"
      >
        {children}
      </pre>
    );
  }

  const language = extractLanguage(children);

  return (
    <div dir="ltr" className="group my-3 overflow-hidden rounded-lg border bg-muted/60">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {language || t`code`}
        </span>
        <div className="flex items-center gap-1">
          <CodeBlockRunButton
            language={language}
            code={() => preRef.current?.textContent ?? ''}
            className={headerButtonClass}
          />
          <CopyButton
            value={() => preRef.current?.textContent ?? ''}
            title={t`Copy code`}
            label={t`Copy`}
            copiedLabel={t`Copied`}
            className={headerButtonClass}
          />
        </div>
      </div>
      <pre
        ref={preRef}
        className="max-h-[480px] overflow-auto px-3 py-3 text-start font-mono text-[13px] leading-relaxed text-foreground"
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * The app's canonical markdown element styling. Shared so any markdown surface
 * (the chat, the review-diff viewer) renders prose identically.
 */
/** How a link reads inside rendered markdown — shared by every surface that overrides `a`. */
export const MARKDOWN_LINK_CLASS = 'font-medium text-primary underline underline-offset-4 hover:text-primary/80';

export function markdownComponents({
  compact = false,
  codeChrome = true,
  localeDir,
}: {
  compact?: boolean;
  codeChrome?: boolean;
  localeDir: TextDirection;
}): Components {
  const paragraphClass = compact
    ? 'mb-2 leading-6 last:mb-0 [&:not(:first-child)]:mt-2'
    : 'mb-4 leading-7 last:mb-0 [&:not(:first-child)]:mt-6';

  // Every text-bearing block carries an explicit dir so its base direction (and
  // with it alignment + punctuation side) follows the block's own content
  // instead of the app UI locale — Hebrew/Arabic content renders RTL even when
  // the app is in an LTR language. Direction-sensitive spacing uses logical
  // utilities (ms-*, ps-*, border-s, text-start) so it flips with the
  // resolved direction.
  //
  // `resolveTextDirection` and NOT dir="auto": see `lib/text-direction.ts`.
  // Briefly — "auto" reads only the FIRST STRONG CHARACTER, so a Hebrew list
  // item opening with an English term flipped LTR; and "auto" ignores the text
  // of descendants that carry their own dir, so dir="auto" on <li> left the
  // <ol> with nothing to read and it fell back to LTR for EVERY list, pure
  // Hebrew ones included (FLOWPAD-2015).
  const dirOf = (node: unknown) => resolveTextDirection(node, localeDir);

  return {
    code: ({ children }) => (
      <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    ),
    pre: ({ children }) => <CodeBlock codeChrome={codeChrome}>{children}</CodeBlock>,
    p: ({ node, children }) => (
      <p dir={dirOf(node)} className={paragraphClass}>
        {children}
      </p>
    ),
    h1: ({ node, children }) => (
      <h1 dir={dirOf(node)} className="mb-4 scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl">
        {children}
      </h1>
    ),
    h2: ({ node, children }) => (
      <h2 dir={dirOf(node)} className="mb-3 scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ node, children }) => (
      <h3 dir={dirOf(node)} className="mb-2 scroll-m-20 text-2xl font-semibold tracking-tight">
        {children}
      </h3>
    ),
    ul: ({ node, children }) => (
      <ul dir={dirOf(node)} className="my-6 ms-6 list-disc [&>li]:mt-2">
        {children}
      </ul>
    ),
    ol: ({ node, children }) => (
      <ol dir={dirOf(node)} className="my-6 ms-6 list-decimal [&>li]:mt-2">
        {children}
      </ol>
    ),
    // No dir here on purpose: the marker sits on the item's start side, so a
    // per-item direction would scatter the markers across both sides of one
    // list. <li> inherits the direction its <ul>/<ol> resolved for the whole.
    li: ({ children }) => <li className="mt-2">{children}</li>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className={MARKDOWN_LINK_CLASS}>
        {children}
      </a>
    ),
    blockquote: ({ node, children }) => (
      <blockquote dir={dirOf(node)} className="mt-6 border-s-2 ps-6 italic text-muted-foreground">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="my-6 w-full overflow-auto">
        <table className="w-full">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-b border-muted">{children}</tr>,
    th: ({ node, children }) => (
      <th dir={dirOf(node)} className="px-4 py-2 text-start font-semibold">
        {children}
      </th>
    ),
    td: ({ node, children }) => (
      <td dir={dirOf(node)} className="px-4 py-2 align-top">
        {children}
      </td>
    ),
    hr: () => <hr className="my-4 border-muted" />,
  };
}

/** Inline images (`data:image/…`, a QR code a backend drew) pass; every other url is the default's. Only on
 *  an `<img>`, where a data URI cannot run anything — never on a link. */
const withDataImages: UrlTransform = (url, key, node) =>
  node.tagName === 'img' && key === 'src' && url.startsWith('data:image/') ? url : defaultUrlTransform(url);
/** A drawn image (a QR code) on its own white card: a camera reads dark-on-light, and a backend's black-on-
 *  transparent drawing vanishes on a dark theme. Other images keep the default rendering. */
const DataImage: Components['img'] = ({ node: _node, src, alt, ...rest }) =>
  typeof src === 'string' && src.startsWith('data:image/') ? (
    <img
      src={src}
      alt={alt ?? ''}
      {...rest}
      className="my-2 inline-block rounded-md bg-white p-2 shadow-sm"
      data-testid="md-data-image"
    />
  ) : (
    <img src={src} alt={alt ?? ''} {...rest} />
  );
const dataImageSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), 'data'] },
};

/** Keeps the raw reference `remarkLinkRefs` put on a link; it is data, never followed by the browser. */
const linkRefSchema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, a: [...(defaultSchema.attributes?.a ?? []), 'dataLinkRef'] },
};

/**
 * Every link — authored, gfm-autolinked, or a file reference `remarkLinkRefs` found — takes
 * the link layer's click and menu. Only a web page keeps an href: a path href would send a
 * middle-click to a dead app route.
 */
function linkedAnchors(links: LinkHandlers): Partial<Components> {
  return {
    a: ({ node, href, children }) => {
      const ref = node?.properties?.dataLinkRef;
      if (typeof ref !== 'string') {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className={MARKDOWN_LINK_CLASS}>
            {children}
          </a>
        );
      }
      return (
        <a
          href={isWebUrl(ref) ? ref : undefined}
          role="link"
          // A linked `code.py:3` keeps its code chip but reads as a link.
          className={`cursor-pointer ${MARKDOWN_LINK_CLASS} [&>code]:text-primary [&>code]:underline`}
          {...linkEventProps(links, ref)}
        >
          {children}
        </a>
      );
    },
  };
}

export const MarkdownView = ({
  value,
  compact = false,
  codeChrome = true,
  components,
  dataImages = false,
  links = null,
}: {
  value: string;
  compact?: boolean;
  codeChrome?: boolean;
  /** Element overrides merged OVER the defaults — for renderers that can resolve
   *  something this component cannot know about on its own. The portal uses it
   *  for `img`/`a`, which are document-relative and need a project to resolve
   *  against (see `useMarkdownAssetComponents`). */
  components?: Partial<Components>;
  /** Draw inline `data:image/` images (a QR code in a setup question). Off by default. */
  dataImages?: boolean;
  /**
   * The surface's link handlers (`useLinks`). Given, file references in prose and
   * inline code become links too, and every link opens through the link layer
   * instead of a browser tab.
   */
  links?: LinkHandlers | null;
}) => {
  // Reactive on purpose. The supported-locale list lands one tick AFTER this
  // tree first renders, so a stored `he` reads as unsupported on the first
  // pass; a non-subscribing read would freeze this at the pre-bootstrap `ltr`
  // for the whole session (see `locale-context.tsx`). Only the tiebreaker for
  // blocks with no strong characters of their own — content still wins.
  const localeDir = useLocaleInfo().dir;
  const anchors = useMemo(() => (links ? linkedAnchors(links) : undefined), [links]);
  return (
    <ReactMarkdown
      remarkPlugins={links ? [remarkGfm, remarkLinkRefs] : [remarkGfm]}
      // `dataImages` and `links` never meet: a setup question has no link source.
      rehypePlugins={[
        rehypeRaw,
        links ? [rehypeSanitize, linkRefSchema] : dataImages ? [rehypeSanitize, dataImageSchema] : rehypeSanitize,
        rehypeHighlight,
      ]}
      urlTransform={dataImages ? withDataImages : undefined}
      components={{
        ...markdownComponents({ compact, codeChrome, localeDir }),
        ...(dataImages ? { img: DataImage } : {}),
        ...anchors,
        ...components,
      }}
    >
      {value}
    </ReactMarkdown>
  );
};
