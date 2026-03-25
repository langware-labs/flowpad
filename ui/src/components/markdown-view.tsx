import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

export const MarkdownView = ({ value, compact = false }: { value: string; compact?: boolean }) => {
  const paragraphClass = compact
    ? 'mb-2 leading-6 last:mb-0 [&:not(:first-child)]:mt-2'
    : 'mb-4 leading-7 last:mb-0 [&:not(:first-child)]:mt-6';

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}
      components={{
        code: ({ children }) => (
          <code className="rounded-md bg-muted px-1.5 py-1 font-mono text-sm text-muted-foreground">{children}</code>
        ),
        pre: ({ children }) => (
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
            {children}
          </pre>
        ),
        p: ({ children }) => <p className={paragraphClass}>{children}</p>,
        h1: ({ children }) => (
          <h1 className="mb-4 scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-3 scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => <h3 className="mb-2 scroll-m-20 text-2xl font-semibold tracking-tight">{children}</h3>,
        ul: ({ children }) => <ul className="my-6 ml-6 list-disc [&>li]:mt-2">{children}</ul>,
        ol: ({ children }) => <ol className="my-6 ml-6 list-decimal [&>li]:mt-2">{children}</ol>,
        li: ({ children }) => <li className="mt-2">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
          >
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="mt-6 border-l-2 pl-6 italic text-muted-foreground">{children}</blockquote>
        ),
        table: ({ children }) => (
          <div className="my-6 w-full overflow-auto">
            <table className="w-full">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-muted">{children}</tr>,
        th: ({ children }) => <th className="px-4 py-2 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="px-4 py-2 align-top">{children}</td>,
        hr: () => <hr className="my-4 border-muted" />,
      }}
    >
      {value}
    </ReactMarkdown>
  );
};
