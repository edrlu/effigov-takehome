/**
 * The three charts on this page, hand-authored as inline SVG.
 *
 * None of them invent a point: an empty series renders as an empty state, and
 * a flat series renders flat rather than being stretched to look interesting.
 */

export interface Sparkline {
  points: number[];
  stroke: string;
  className?: string;
}

const SPARK_WIDTH = 76;
const SPARK_HEIGHT = 34;

/**
 * A 7-point daily trend. Drawn with `vector-effect` so the stroke keeps its
 * weight when the viewBox is scaled by the tile.
 */
export function Sparkline({ points, stroke, className = "" }: Sparkline) {
  if (points.length < 2) return null;

  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min;
  const step = SPARK_WIDTH / (points.length - 1);
  // A flat series sits on the middle line; scaling it to the full height would
  // draw movement that is not in the data.
  const y = (value: number) =>
    span === 0 ? SPARK_HEIGHT / 2 : SPARK_HEIGHT - 3 - ((value - min) / span) * (SPARK_HEIGHT - 6);

  const line = points.map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const area = `${line} L${SPARK_WIDTH},${SPARK_HEIGHT} L0,${SPARK_HEIGHT} Z`;
  const id = `spark-${stroke.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      aria-hidden
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface BarChartBar {
  label: string;
  value: number;
  /** The most recent bucket, drawn solid rather than tinted. */
  highlighted?: boolean;
  title?: string;
}

/** One soft-blue column per day, with the newest day picked out in solid blue. */
export function BarChart({ bars, minHeight = 132 }: { bars: BarChartBar[]; minHeight?: number }) {
  const max = Math.max(...bars.map((bar) => bar.value), 0);

  return (
    <div className="flex h-full flex-col gap-2">
      <div
        className="flex flex-1 items-end gap-2"
        style={{ minHeight }}
        role="img"
        aria-label="Calls per day"
      >
        {bars.map((bar) => {
          // A zero day still gets a visible foot, so the axis reads as a day
          // with no calls rather than a missing bucket.
          const ratio = max === 0 ? 0 : bar.value / max;
          return (
            // The column owns the full height, so the bar's percentage has
            // something to resolve against.
            <div key={bar.label} className="flex h-full min-w-0 flex-1 items-end justify-center">
              <div
                title={bar.title ?? `${bar.label}: ${bar.value}`}
                style={{ height: `${Math.max(ratio * 100, bar.value > 0 ? 6 : 2)}%` }}
                className={`w-full rounded-t-[5px] transition-[height] duration-300 ${
                  bar.highlighted ? "bg-[#2563eb]" : "bg-[#dbe6fe]"
                }`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        {bars.map((bar) => (
          <span key={bar.label} className="min-w-0 flex-1 truncate text-center text-[11px] text-slate-400">
            {bar.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

const DONUT_RADIUS = 56;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

/** Total in the middle, one arc per slice, drawn in the order given. */
export function Donut({ slices, total, size = 150 }: { slices: DonutSlice[]; total: number; size?: number }) {
  const sum = slices.reduce((accumulator, slice) => accumulator + slice.value, 0);
  let offset = 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 150 150" width={size} height={size} aria-hidden className="-rotate-90">
        <circle cx="75" cy="75" r={DONUT_RADIUS} fill="none" stroke="#eef1f5" strokeWidth="20" />
        {sum > 0
          ? slices.map((slice) => {
              const length = (slice.value / sum) * DONUT_CIRCUMFERENCE;
              const dash = `${length} ${DONUT_CIRCUMFERENCE - length}`;
              const element = (
                <circle
                  key={slice.key}
                  cx="75"
                  cy="75"
                  r={DONUT_RADIUS}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth="20"
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                />
              );
              offset += length;
              return element;
            })
          : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[26px] leading-7 font-semibold tracking-tight tabular-nums text-slate-900">{total}</span>
        <span className="text-[12px] text-slate-400">Total</span>
      </div>
    </div>
  );
}

/** Fixed slice palette, applied by position so the legend and arcs agree. */
export const DONUT_COLORS = ["#2563eb", "#7c3aed", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#94a3b8"];
