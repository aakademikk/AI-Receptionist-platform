import type { ReactNode } from 'react';

/**
 * Primitives.
 *
 * Deliberately a handful of small components rather than a component library. The
 * dashboard is a dozen screens of tables, tiles and forms; a design-system
 * dependency would be more surface area than the whole UI.
 *
 * Everything is styled from the tokens in globals.css (dark-canvas glassmorphism),
 * so a tenant's brand colour reaches chrome and nothing else. Panes compose the
 * reference `.glass .hairline` treatment; data marks and status keep their fixed,
 * validated colours.
 */

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`glass hairline rounded-2xl ${padded ? 'p-5' : ''} ${className}`}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Stat tile.
 *
 * The right form for a single headline number: a one-value bar chart communicates
 * nothing a large numeral does not, and costs a legend and an axis to say it.
 *
 * `tone` uses the reserved status colours and always pairs colour with a label, so
 * the state is never conveyed by colour alone.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warning' | 'critical';
  href?: string;
}) {
  const toneColor =
    tone === 'good'
      ? 'var(--status-good)'
      : tone === 'warning'
        ? 'var(--status-warning)'
        : tone === 'critical'
          ? 'var(--status-critical)'
          : 'var(--text-primary)';

  const body = (
    <>
      <div
        className="text-[11px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </div>
      <div className="tnum mt-1.5 text-3xl font-semibold leading-none" style={{ color: toneColor }}>
        {value}
      </div>
      {hint ? (
        <div className="mt-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {hint}
        </div>
      ) : null}
    </>
  );

  const className = 'glass hairline rounded-2xl p-4 transition-colors';

  if (href) {
    return (
      <a href={href} className={`${className} hover:brightness-[1.04]`}>
        {body}
      </a>
    );
  }

  return (
    <div className={className}>
      {body}
    </div>
  );
}

/**
 * Two-series proportion bar — AI-handled vs human-handled.
 *
 * A stacked bar is the right form: the question is "what share of replies did the
 * assistant handle?", which is a part-to-whole comparison of two categories, and a
 * single bar answers it in one line.
 *
 * Both segments carry a direct label and a legend entry, so identity never rests on
 * colour alone, and there is a 2px surface gap between the fills.
 */
export function SplitBar({
  aiCount,
  humanCount,
  aiLabel = 'AI',
  humanLabel = 'Human',
}: {
  aiCount: number;
  humanCount: number;
  aiLabel?: string;
  humanLabel?: string;
}) {
  const total = aiCount + humanCount;

  if (total === 0) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        No replies sent yet.
      </p>
    );
  }

  const aiPct = Math.round((aiCount / total) * 1000) / 10;
  const humanPct = Math.round((humanCount / total) * 1000) / 10;

  return (
    <div>
      <div
        className="flex h-7 w-full overflow-hidden rounded"
        style={{ background: 'var(--surface-2)', gap: '2px' }}
        role="img"
        aria-label={`${aiLabel} handled ${aiPct}% of replies, ${humanLabel} handled ${humanPct}%`}
      >
        {aiCount > 0 ? (
          <div
            className="flex items-center justify-end px-2 text-[11px] font-semibold"
            style={{
              width: `${aiPct}%`,
              background: 'var(--series-1)',
              // Ink token, not the series colour — text never wears a mark's hue.
              color: '#ffffff',
              borderRadius: '4px',
            }}
          >
            {aiPct >= 12 ? `${aiPct}%` : ''}
          </div>
        ) : null}
        {humanCount > 0 ? (
          <div
            className="flex items-center justify-end px-2 text-[11px] font-semibold"
            style={{
              width: `${humanPct}%`,
              background: 'var(--series-2)',
              color: '#ffffff',
              borderRadius: '4px',
            }}
          >
            {humanPct >= 12 ? `${humanPct}%` : ''}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]">
        <LegendItem color="var(--series-1)" label={aiLabel} value={`${aiPct}% · ${aiCount}`} />
        <LegendItem color="var(--series-2)" label={humanLabel} value={`${humanPct}% · ${humanCount}`} />
      </div>
    </div>
  );
}

function LegendItem({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2.5 rounded-sm"
        style={{ background: color }}
      />
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="tnum font-medium" style={{ color: 'var(--text-primary)' }}>
        {value}
      </span>
    </span>
  );
}

/** Status pill. Colour plus text, never colour alone. */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'info';
}) {
  const palette: Record<string, { bg: string; fg: string; edge: string }> = {
    neutral: { bg: 'var(--surface-2)', fg: 'var(--text-secondary)', edge: 'rgba(255,255,255,0.08)' },
    good: {
      bg: 'color-mix(in oklab, var(--status-good) 14%, transparent)',
      fg: 'var(--status-good)',
      edge: 'color-mix(in oklab, var(--status-good) 30%, transparent)',
    },
    warning: {
      bg: 'color-mix(in oklab, var(--status-warning) 18%, transparent)',
      fg: 'var(--status-warning)',
      edge: 'color-mix(in oklab, var(--status-warning) 34%, transparent)',
    },
    critical: {
      bg: 'color-mix(in oklab, var(--status-critical) 14%, transparent)',
      fg: 'var(--status-critical)',
      edge: 'color-mix(in oklab, var(--status-critical) 30%, transparent)',
    },
    info: {
      bg: 'color-mix(in oklab, var(--series-1) 14%, transparent)',
      fg: 'var(--series-1)',
      edge: 'color-mix(in oklab, var(--series-1) 30%, transparent)',
    },
  };

  const { bg, fg, edge } = palette[tone] ?? palette['neutral']!;

  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ background: bg, color: fg, borderColor: edge }}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = 'primary',
  type = 'button',
  disabled,
  onClick,
  formAction,
  className = '',
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  formAction?: (formData: FormData) => void | Promise<void>;
  className?: string;
}) {
  const variantClass =
    variant === 'primary' ? 'btn-primary btn-sm' : variant === 'danger' ? 'btn-danger btn-sm' : 'btn-ghost btn-sm';

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      formAction={formAction}
      className={`inline-flex items-center justify-center disabled:opacity-50 ${variantClass} ${className}`}
    >
      {children}
    </button>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div
      className="rounded-2xl border border-dashed p-8 text-center"
      style={{
        borderColor: 'rgba(255,255,255,0.14)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <p className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {title}
      </p>
      {description ? (
        <p className="mx-auto mt-1 max-w-md text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** Table wrapper. Scrolls horizontally in its own container so the page never does. */
export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="glass hairline overflow-hidden rounded-2xl">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
          {children}
        </table>
      </div>
    </div>
  );
}

export function Th({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider ${
        align === 'right' ? 'text-right' : ''
      }`}
      style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  muted = false,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  muted?: boolean;
}) {
  return (
    <td
      className={`border-b px-4 py-3 align-top ${align === 'right' ? 'text-right tnum' : ''}`}
      style={{
        color: muted ? 'var(--text-secondary)' : 'var(--text-primary)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {children}
    </td>
  );
}
