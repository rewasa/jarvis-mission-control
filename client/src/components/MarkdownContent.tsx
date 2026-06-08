import { memo, useEffect, useRef, useState } from 'react';
import { Streamdown, type Components, type ControlsConfig } from 'streamdown';
import { code } from '@streamdown/code';
import 'streamdown/styles.css';

const plugins = { code };

const controls: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
};

const components: Components = {
  a: ({ href, children, node: _node, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 decoration-zinc-300 dark:decoration-zinc-600 hover:decoration-zinc-500 dark:hover:decoration-zinc-400 transition-colors"
      {...props}
    >
      {children}
    </a>
  ),
};

const compactMarkdownClassName = [
  'mobile-chat-content min-w-0 max-w-full overflow-hidden text-sm leading-relaxed text-zinc-700 dark:text-zinc-300',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base',
  '[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-sm',
  '[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-sm',
  '[&_p]:mb-2 [&_p:last-child]:mb-0',
  '[&_ul]:mb-2 [&_ul:last-child]:mb-0 [&_ol]:mb-2 [&_ol:last-child]:mb-0',
  '[&_blockquote]:my-2',
  '[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-[13px] [&_code]:text-[13px]',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
].join(' ');

export const MarkdownContent = memo(function MarkdownContent({
  content,
  isStreaming = false,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  return (
    <Streamdown
      animated={isStreaming}
      caret={isStreaming ? 'block' : undefined}
      className={compactMarkdownClassName}
      components={components}
      controls={controls}
      isAnimating={isStreaming}
      plugins={plugins}
    >
      {content}
    </Streamdown>
  );
});

// Lightweight stand-in shown until a message scrolls near the viewport. Mounting
// a full Streamdown (markdown parse + Shiki highlighting) for every message in a
// long conversation freezes the main thread on open; this defers that cost so we
// only pay it for messages the user can actually see.
const placeholderClassName = `${compactMarkdownClassName} whitespace-pre-wrap break-words`;

/**
 * Renders message markdown lazily. Messages start as cheap plain text and only
 * upgrade to the full Streamdown renderer once they intersect (or get near) the
 * viewport. `forceMount` opts a message in immediately — used for the tail of the
 * conversation that's visible on open and for the live-streaming message.
 *
 * `content-visibility: auto` lets the browser additionally skip layout/paint for
 * off-screen rows, and `contain-intrinsic-size` reserves an estimated height so
 * the scrollbar stays stable while rows are still collapsed.
 */
export const DeferredMarkdown = memo(function DeferredMarkdown({
  content,
  isStreaming = false,
  forceMount = false,
}: {
  content: string;
  isStreaming?: boolean;
  forceMount?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(forceMount);

  useEffect(() => {
    if (forceMount) {
      setMounted(true);
      return;
    }
    if (mounted) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMounted(true);
          observer.disconnect();
        }
      },
      // Mount a screenful early so the upgrade finishes before the row is read.
      { rootMargin: '600px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [forceMount, mounted]);

  return (
    <div
      ref={ref}
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}
    >
      {mounted ? (
        <MarkdownContent content={content} isStreaming={isStreaming} />
      ) : (
        <div className={placeholderClassName}>{content}</div>
      )}
    </div>
  );
});
