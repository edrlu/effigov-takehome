"use client";

import { PHASE_HINT, PHASE_LABEL } from "@/lib/labels";
import { CALL_PHASES, type CallPhase } from "@/lib/types";

/**
 * `greeting -> gathering -> filed -> wrapping -> ended` as a fixed-width track.
 *
 * The step count never changes, so the control cannot reflow as the call
 * progresses; only the fill moves. Colour alone does not carry the state - the
 * current step is also named in text (compact: as the label beside the track).
 */
export function PhaseTrack({
  phase,
  compact = false,
  className = "",
}: {
  phase: CallPhase;
  compact?: boolean;
  className?: string;
}) {
  const index = Math.max(0, CALL_PHASES.indexOf(phase));
  const done = phase === "ended";

  if (compact) {
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 ${className}`}
        title={`Call phase: ${PHASE_LABEL[phase]} - ${PHASE_HINT[phase]}`}
      >
        <span aria-hidden className="flex items-center gap-[3px]">
          {CALL_PHASES.map((step, position) => (
            <span
              key={step}
              className={`h-1 w-3 rounded-full transition-colors ${
                position < index
                  ? done
                    ? "bg-line-strong"
                    : "bg-accent/55"
                  : position === index
                    ? done
                      ? "bg-muted"
                      : "bg-accent"
                    : "bg-line"
              }`}
            />
          ))}
        </span>
        <span className={`text-[11px] whitespace-nowrap ${done ? "text-faint" : "text-accent"}`}>
          {PHASE_LABEL[phase]}
        </span>
      </span>
    );
  }

  return (
    <ol
      className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 ${className}`}
      aria-label={`Call phase: ${PHASE_LABEL[phase]}`}
    >
      {CALL_PHASES.map((step, position) => {
        const passed = position < index;
        const current = position === index;
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              title={PHASE_HINT[step]}
              aria-current={current ? "step" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 whitespace-nowrap transition-colors ${
                current
                  ? done
                    ? "border-line-strong bg-raised text-muted"
                    : "border-accent/45 bg-accent/12 font-medium text-accent"
                  : passed
                    ? "border-line bg-raised/60 text-muted"
                    : "border-line/70 text-faint"
              }`}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  current
                    ? done
                      ? "bg-muted"
                      : "live-dot bg-accent"
                    : passed
                      ? "bg-line-strong"
                      : "border border-line-strong bg-transparent"
                }`}
              />
              {PHASE_LABEL[step]}
            </span>
            {position < CALL_PHASES.length - 1 ? (
              <span
                aria-hidden
                className={`h-px w-2 ${passed ? "bg-line-strong" : "bg-line"}`}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
