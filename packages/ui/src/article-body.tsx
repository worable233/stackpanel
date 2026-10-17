import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function ArticleBody({ body }: { body: string }) {
  let headingIndex = 0;
  return (
    <div className="min-w-0 break-words text-base leading-8 text-foreground/85 [&_p]:my-5 [&_h2]:mb-5 [&_h2]:mt-12 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mb-4 [&_h3]:mt-8 [&_h3]:text-xl [&_h3]:font-medium [&_h4]:mt-6 [&_h4]:font-semibold [&_h1]:my-8 [&_h1]:text-3xl [&_h1]:font-semibold [&_strong]:font-semibold [&_strong]:text-foreground [&_a]:text-primary [&_a]:underline [&_a]:decoration-primary/30 [&_a]:underline-offset-4 [&_ul]:my-5 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-5 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-2 [&_li]:pl-1 [&_blockquote]:my-8 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/50 [&_blockquote]:pl-6 [&_blockquote]:text-muted-foreground [&_hr]:my-10 [&_hr]:border-border [&_pre]:my-8 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/40 [&_pre]:p-5 [&_pre]:text-sm [&_pre]:leading-7 [&_code]:font-mono [&_p_code]:rounded [&_p_code]:bg-muted [&_p_code]:px-1.5 [&_p_code]:py-0.5 [&_p_code]:text-[0.88em] [&_img]:my-8 [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-xl [&_th]:border-b [&_th]:border-border [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_td]:border-b [&_td]:border-border/60 [&_td]:px-4 [&_td]:py-3 [&_input]:mr-2 [&_input]:accent-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => (
            <h2 id={`section-${headingIndex++}`} className="scroll-mt-28 text-foreground">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 id={`section-${headingIndex++}`} className="scroll-mt-28 text-foreground">
              {children}
            </h3>
          ),
          table: ({ children }) => (
            <div className="my-8 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm leading-6">{children}</table>
            </div>
          ),
          img: ({ src, alt }) => <img src={src} alt={alt ?? ''} loading="lazy" />,
          a: ({ href, children }) => (
            <a href={href} rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}>
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
