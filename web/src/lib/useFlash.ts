"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const FLASH_MS = 1800;

/**
 * Tracks which keys (row ids, field names) changed recently so the UI can
 * highlight them. Re-flagging a key that is still lit restarts the animation
 * by dropping the class for one frame.
 */
export function useFlash<K extends string | number>(duration = FLASH_MS) {
  const [flashed, setFlashed] = useState<ReadonlySet<K>>(() => new Set<K>());
  const timers = useRef(new Map<K, ReturnType<typeof setTimeout>>());
  const frames = useRef(new Set<number>());

  const clear = useCallback((key: K) => {
    setFlashed((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }, []);

  const flash = useCallback(
    (key: K) => {
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);

      clear(key);
      const frame = requestAnimationFrame(() => {
        frames.current.delete(frame);
        setFlashed((previous) => {
          const next = new Set(previous);
          next.add(key);
          return next;
        });
      });
      frames.current.add(frame);

      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          clear(key);
        }, duration),
      );
    },
    [clear, duration],
  );

  useEffect(() => {
    const timeouts = timers.current;
    const pending = frames.current;
    return () => {
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      timeouts.clear();
      for (const frame of pending) cancelAnimationFrame(frame);
      pending.clear();
    };
  }, []);

  const flashClass = useCallback((key: K) => (flashed.has(key) ? "flash" : ""), [flashed]);

  return { flash, flashed, flashClass };
}
