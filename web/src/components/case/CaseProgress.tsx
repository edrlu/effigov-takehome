"use client";

/**
 * The intake stepper.
 *
 * Six steps, each one a predicate over data the call actually captured (see
 * `progressSteps`). When a step flips to complete it rings once, so a viewer
 * watching a live call sees the moment the fact landed rather than only its
 * result.
 */

import { useEffect, useRef, useState } from "react";
import { Card } from "./ui";
import { Icon } from "./icons";
import { STEP_STATE_LABEL, type ProgressStep } from "./derive";

const STATE_TEXT: Record<ProgressStep["state"], string> = {
  complete: "text-slate-500",
  current: "text-blue-600 font-medium",
  pending: "text-slate-400",
};

export function CaseProgress({ steps }: { steps: ProgressStep[] }) {
  const previous = useRef<Record<string, ProgressStep["state"]>>({});
  const [justCompleted, setJustCompleted] = useState<string | null>(null);

  useEffect(() => {
    const before = previous.current;
    const landed = steps.find((step) => step.state === "complete" && before[step.key] && before[step.key] !== "complete");
    previous.current = Object.fromEntries(steps.map((step) => [step.key, step.state]));
    if (!landed) return;
    setJustCompleted(landed.key);
    const timer = setTimeout(() => setJustCompleted(null), 1400);
    return () => clearTimeout(timer);
  }, [steps]);

  const done = steps.filter((step) => step.state === "complete").length;

  return (
    <Card
      title="Case Progress"
      action={
        <span className="text-[12px] text-slate-500 tabular-nums">
          {done} of {steps.length}
        </span>
      }
     
    >
      <div className="-mx-1 overflow-x-auto px-1 pt-1 pb-1">
        <ol className="flex min-w-[560px] items-start">
          {steps.map((step, index) => {
            const complete = step.state === "complete";
            const current = step.state === "current";
            return (
              <li
                key={step.key}
                className="relative flex flex-1 flex-col items-center px-1 text-center"
                title={step.detail}
              >
                {index > 0 ? (
                  // The connector is drawn on the circle's centre line, and it
                  // is blue only when the step it arrives at has been reached -
                  // a blue line running into a grey circle reads as progress
                  // the case has not actually made.
                  <span
                    aria-hidden
                    className={`absolute top-[13px] right-1/2 h-[2px] w-full transition-colors duration-500 ${
                      complete || current ? "bg-blue-600" : "bg-slate-200"
                    }`}
                  />
                ) : null}

                <span
                  className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-semibold transition-colors ${
                    complete || current
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-slate-300 bg-sheet text-slate-400"
                  } ${justCompleted === step.key ? "settle-ring" : ""}`}
                >
                  {complete ? <Icon name="check" className="h-3.5 w-3.5" strokeWidth="2.2" /> : index + 1}
                </span>

                <p
                  className={`mt-2.5 text-[12px] leading-4 ${
                    step.state === "pending" ? "text-slate-500" : "font-medium text-slate-900"
                  }`}
                >
                  {step.name}
                </p>
                <p className={`mt-1 text-[11px] leading-4 ${STATE_TEXT[step.state]}`}>
                  {STEP_STATE_LABEL[step.state]}
                </p>
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}
