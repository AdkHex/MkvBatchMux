/** Drag a row to a new place in a list, with the pointer.
 *
 *  Pointer events, not HTML drag and drop: on Windows, Tauri's file-drop
 *  handler takes every HTML drag, so `draggable` rows never moved there. A
 *  press becomes a drag once the pointer has travelled a little
 *  (hasDragStarted), so clicks and double-clicks still reach the row, and the
 *  list scrolls when the pointer nears its edge. */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { getAutoScrollDelta, getReorderIndexFromPointer, hasDragStarted } from "./reorderDrag";

/** The table body's top padding (ui.css `.tbl .tb`), above the first row. */
const BODY_PADDING = 2;

export function useRowReorder({
  bodyRef,
  rowHeight = 32,
  rowCount,
  onMove,
  disabled,
}: {
  bodyRef: RefObject<HTMLDivElement | null>;
  rowHeight?: number;
  rowCount: number;
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const pending = useRef<{ index: number; x: number; y: number; pointerId: number; row: HTMLElement } | null>(null);
  const active = useRef<{ from: number; pointerId: number } | null>(null);
  const over = useRef<number | null>(null);
  const pointerY = useRef(0);
  const frame = useRef<number | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const target = useCallback(
    (y: number) => {
      const body = bodyRef.current;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      const index = getReorderIndexFromPointer({
        containerRect: { top: rect.top + BODY_PADDING, bottom: rect.bottom },
        scrollTop: body.scrollTop,
        rowHeight,
        rowCount,
        pointerY: y,
      });
      over.current = index;
      setOverIndex(index);
    },
    [bodyRef, rowHeight, rowCount],
  );

  useEffect(() => {
    const tick = () => {
      const body = bodyRef.current;
      if (!active.current || !body) return;
      const delta = getAutoScrollDelta({ containerRect: body.getBoundingClientRect(), pointerY: pointerY.current });
      if (delta !== 0) {
        body.scrollTop += delta;
        target(pointerY.current);
      }
      frame.current = requestAnimationFrame(tick);
    };
    const end = () => {
      const drag = active.current;
      active.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      if (drag && over.current !== null && over.current !== drag.from) onMoveRef.current(drag.from, over.current);
      over.current = null;
      setDragIndex(null);
      setOverIndex(null);
    };
    const move = (event: PointerEvent) => {
      const press = pending.current;
      if (press && press.pointerId === event.pointerId) {
        if (!hasDragStarted({ start: press, current: { x: event.clientX, y: event.clientY } })) return;
        pending.current = null;
        active.current = { from: press.index, pointerId: press.pointerId };
        press.row.setPointerCapture?.(press.pointerId);
        over.current = press.index;
        setDragIndex(press.index);
        setOverIndex(press.index);
        frame.current = requestAnimationFrame(tick);
      }
      if (!active.current || active.current.pointerId !== event.pointerId) return;
      pointerY.current = event.clientY;
      target(event.clientY);
    };
    const up = (event: PointerEvent) => {
      if (pending.current?.pointerId === event.pointerId) pending.current = null;
      if (active.current?.pointerId === event.pointerId) end();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [bodyRef, target]);

  /** Spread on a row: starts a drag from a press anywhere on it except its
   *  own controls. */
  const rowProps = (index: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, select, textarea, a")) return;
      pending.current = { index, x: event.clientX, y: event.clientY, pointerId: event.pointerId, row: event.currentTarget };
    },
    className: dragIndex === index ? "dragging" : overIndex === index && dragIndex !== null && dragIndex !== index ? "drop" : undefined,
  });

  return { dragIndex, overIndex, rowProps };
}
