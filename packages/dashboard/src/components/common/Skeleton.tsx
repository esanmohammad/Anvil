import React from 'react';

export interface SkeletonProps {
  width?: number | string;
  height?: number;
  /** CSS variable name (e.g. '--radius-sm'); defaults to '--radius-xs'. */
  radius?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Optional centered children (used by full-canvas skeletons). */
  children?: React.ReactNode;
}

export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  className,
  style,
  children,
}: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        width,
        height,
        borderRadius: `var(${radius ?? '--radius-xs'})`,
        backgroundColor: 'var(--bg-elevated-3)',
        backgroundImage:
          'linear-gradient(90deg, var(--bg-elevated-2) 25%, var(--bg-elevated-3) 50%, var(--bg-elevated-2) 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s ease-in-out infinite',
        display: children ? 'flex' : undefined,
        alignItems: children ? 'center' : undefined,
        justifyContent: children ? 'center' : undefined,
        color: 'var(--text-tertiary)',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function RowSkeleton({
  count = 3,
  height = 32,
  gap = 6,
}: {
  count?: number;
  height?: number;
  gap?: number;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={height} radius="--radius-sm" />
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        padding: 'var(--space-md)',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          height={i === 0 ? 16 : 12}
          width={i === 0 ? '60%' : '90%'}
        />
      ))}
    </div>
  );
}

export function TileSkeleton() {
  return (
    <div
      aria-hidden="true"
      style={{
        padding: 12,
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 64,
      }}
    >
      <Skeleton height={11} width="40%" />
      <Skeleton height={20} width="55%" />
    </div>
  );
}

export interface LoadingState {
  loading: boolean;
  error: string | null;
  loaded: () => void;
  errored: (msg: string) => void;
  reset: () => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MSG =
  'Dashboard server unreachable — check that anvil-loc dashboard is running.';

/**
 * Tracks first-paint loading for a WS-driven page.
 *
 * - Starts in `loading: true`.
 * - Calling `loaded()` flips loading off and clears the timer.
 * - Calling `errored(msg)` flips loading off with an error.
 * - If neither fires within `timeoutMs`, surfaces a server-unreachable
 *   error so the user gets actionable text instead of a forever
 *   spinner.
 */
export function useLoadingState(timeoutMs = DEFAULT_TIMEOUT_MS): LoadingState {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const timerRef = React.useRef<number | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    timerRef.current = window.setTimeout(() => {
      setLoading((isLoading) => {
        if (isLoading) setError(DEFAULT_TIMEOUT_MSG);
        return false;
      });
      timerRef.current = null;
    }, timeoutMs);
    return clearTimer;
  }, [timeoutMs, clearTimer]);

  const loaded = React.useCallback(() => {
    setLoading(false);
    setError(null);
    clearTimer();
  }, [clearTimer]);

  const errored = React.useCallback(
    (msg: string) => {
      setLoading(false);
      setError(msg);
      clearTimer();
    },
    [clearTimer],
  );

  const reset = React.useCallback(() => {
    setLoading(true);
    setError(null);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setLoading((isLoading) => {
        if (isLoading) setError(DEFAULT_TIMEOUT_MSG);
        return false;
      });
      timerRef.current = null;
    }, timeoutMs);
  }, [clearTimer, timeoutMs]);

  return { loading, error, loaded, errored, reset };
}

export default Skeleton;
