import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface RenameAnimation {
  isAnimating: boolean;
  typedValue: string;
}

function durationMsFor(charCount: number) {
  return Math.min(2600, Math.max(1100, 260 + charCount * 62));
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useRenameAnimation(value: string, identity?: string | null): RenameAnimation {
  const previousRef = useRef<{ identity?: string | null; value: string } | null>(null);
  const [state, setState] = useState<RenameAnimation>({ isAnimating: false, typedValue: value });

  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { identity, value };

    const sameIdentity = previous && previous.identity === identity;
    const valueChanged = previous && previous.value !== value;

    if (sameIdentity && valueChanged && !prefersReducedMotion()) {
      setState({ isAnimating: true, typedValue: '' });
    } else {
      setState((current) => (
        current.isAnimating ? { isAnimating: false, typedValue: value } : current
      ));
    }
  }, [identity, value]);

  useEffect(() => {
    if (!state.isAnimating) return;

    const characters = Array.from(value);
    if (characters.length === 0) {
      setState({ isAnimating: false, typedValue: value });
      return;
    }

    const durationMs = durationMsFor(characters.length);
    let frame = 0;
    let lastCount = -1;
    const startedAt = performance.now();

    function tick(now: number) {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const count = Math.min(characters.length, Math.max(1, Math.ceil(progress * characters.length)));

      if (count !== lastCount) {
        lastCount = count;
        setState({
          isAnimating: progress < 1,
          typedValue: characters.slice(0, count).join(''),
        });
      }

      if (progress < 1) frame = window.requestAnimationFrame(tick);
    }

    frame = window.requestAnimationFrame(tick);

    return () => window.cancelAnimationFrame(frame);
  }, [state.isAnimating, value]);

  return state;
}

export function RenameReveal({
  animation,
  className = '',
}: {
  animation: RenameAnimation;
  className?: string;
}) {
  if (!animation.isAnimating) return null;

  return (
    <span aria-hidden="true" className={`rename-title-reveal ${className}`}>
      <span className="rename-title-typed">
        {animation.typedValue}
        <span className="rename-title-caret" />
      </span>
    </span>
  );
}

export function RenameTitle({
  value,
  identity,
  className = '',
}: {
  value: string;
  identity?: string | null;
  className?: string;
}) {
  const animation = useRenameAnimation(value, identity);

  return (
    <span className={`rename-title-shell ${className}`}>
      {animation.isAnimating ? (
        <span className="rename-title-layout-hidden">{value}</span>
      ) : value}
      <RenameReveal animation={animation} />
    </span>
  );
}
