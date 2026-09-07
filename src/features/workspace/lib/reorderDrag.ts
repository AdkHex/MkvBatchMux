export interface ReorderIndexInput {
  containerRect: Pick<DOMRect, "top" | "bottom">;
  scrollTop: number;
  rowHeight: number;
  rowCount: number;
  pointerY: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function getReorderIndexFromPointer({
  containerRect,
  scrollTop,
  rowHeight,
  rowCount,
  pointerY,
}: ReorderIndexInput) {
  if (rowCount <= 0 || rowHeight <= 0) return 0;
  const relativeY = pointerY - containerRect.top + scrollTop;
  return clamp(Math.floor(relativeY / rowHeight), 0, rowCount - 1);
}

export interface AutoScrollInput {
  containerRect: Pick<DOMRect, "top" | "bottom">;
  pointerY: number;
  threshold?: number;
  maxSpeed?: number;
}

export function getAutoScrollDelta({
  containerRect,
  pointerY,
  threshold = 40,
  maxSpeed = 18,
}: AutoScrollInput) {
  // Intensity is capped: dragging far past the edge (easy to do once the
  // pointer is captured) would otherwise scale straight past maxSpeed.
  if (pointerY < containerRect.top + threshold) {
    const intensity = clamp((containerRect.top + threshold - pointerY) / threshold, 0, 1);
    return -Math.max(4, Math.round(maxSpeed * intensity));
  }
  if (pointerY > containerRect.bottom - threshold) {
    const intensity = clamp((pointerY - (containerRect.bottom - threshold)) / threshold, 0, 1);
    return Math.max(4, Math.round(maxSpeed * intensity));
  }
  return 0;
}
