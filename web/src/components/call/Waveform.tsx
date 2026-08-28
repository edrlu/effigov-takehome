"use client";

/**
 * Live input level, drawn two ways.
 *
 * Both subscribe to the shared `LevelMeter` and write heights straight onto
 * their own DOM nodes. Nothing here calls `setState`, so a talking resident
 * does not re-render the case panels sixty times a second.
 */

import { useEffect, useRef } from "react";
import { useCallSession } from "@/components/call/session";

const BAR_COUNT = 54;
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 42;
/** How often a new sample enters the scrolling history, in milliseconds. */
const SAMPLE_MS = 45;

export function Waveform({ live }: { live: boolean }) {
  const { meter } = useCallSession();
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const history = useRef<number[]>(new Array(BAR_COUNT).fill(0));

  useEffect(() => {
    if (!live) {
      history.current = new Array(BAR_COUNT).fill(0);
      for (const bar of bars.current) {
        if (bar) bar.style.height = `${MIN_HEIGHT}px`;
      }
      return;
    }

    let last = 0;
    const unsubscribe = meter.subscribe((level) => {
      const now = performance.now();
      if (now - last < SAMPLE_MS) return;
      last = now;

      const samples = history.current;
      samples.push(level);
      samples.shift();

      for (let index = 0; index < samples.length; index += 1) {
        const bar = bars.current[index];
        if (!bar) continue;
        // Square-root shaping: quiet speech still moves the bar visibly, loud
        // speech does not simply peg every bar at full height.
        const height = MIN_HEIGHT + Math.sqrt(samples[index]) * (MAX_HEIGHT - MIN_HEIGHT);
        bar.style.height = `${height.toFixed(1)}px`;
      }
    });
    return unsubscribe;
  }, [live, meter]);

  return (
    <div
      className="flex h-[46px] w-full items-center justify-between gap-[2px]"
      role="img"
      aria-label={live ? "Live microphone level" : "Microphone idle"}
    >
      {Array.from({ length: BAR_COUNT }).map((_, index) => (
        <span
          key={index}
          ref={(node) => {
            bars.current[index] = node;
          }}
          style={{ height: MIN_HEIGHT }}
          className={`w-[2px] shrink-0 grow rounded-full transition-[background-color] ${
            live ? "bg-blue-600" : "bg-slate-200"
          }`}
        />
      ))}
    </div>
  );
}

const METER_BARS = 5;

/** The five-step level chip in the Voice Agent stat row. */
export function VolumeMeter({ live }: { live: boolean }) {
  const { meter } = useCallSession();
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const paint = (lit: number) => {
      for (let index = 0; index < METER_BARS; index += 1) {
        const bar = bars.current[index];
        if (!bar) continue;
        bar.style.backgroundColor = index < lit ? "#2563eb" : "#e2e8f0";
      }
    };

    if (!live) {
      paint(0);
      return;
    }
    return meter.subscribe((level) => paint(Math.min(METER_BARS, Math.round(Math.sqrt(level) * METER_BARS))));
  }, [live, meter]);

  return (
    <span className="flex h-[18px] items-end gap-[3px]" role="img" aria-label="Input volume">
      {Array.from({ length: METER_BARS }).map((_, index) => (
        <span
          key={index}
          ref={(node) => {
            bars.current[index] = node;
          }}
          style={{ height: 6 + index * 3, backgroundColor: "#e2e8f0" }}
          className="w-[3px] rounded-full"
        />
      ))}
    </span>
  );
}
