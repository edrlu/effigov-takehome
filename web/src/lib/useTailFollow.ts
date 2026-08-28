"use client";

import { useCallback, useEffect, useRef } from "react";

/** Within this many pixels of the bottom counts as following the tail. */
const SLACK_PX = 48;

/**
 * Keep a scrolling panel pinned to its newest row without ever yanking the view
 * away from someone reading back through it.
 *
 * The subtlety is that a programmatic scroll fires a `scroll` event like any
 * other, and it is delivered a frame later - by which time more rows may have
 * arrived and pushed the bottom further down. Judging "did the reader scroll
 * away?" from that stale event unpins the panel permanently after the first
 * burst. So the position we scrolled to is remembered, and an event still
 * sitting at that exact offset is our own scroll, not the reader's.
 */
export function useTailFollow(signal: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const auto = useRef(-1);

  useEffect(() => {
    const node = ref.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
    auto.current = node.scrollTop;
  }, [signal]);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (!node || node.scrollTop === auto.current) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < SLACK_PX;
  }, []);

  return { ref, onScroll };
}
