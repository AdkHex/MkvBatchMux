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
  if (pointerY < containerRect.top + threshold) {
    const intensity = (containerRect.top + threshold - pointerY) / threshold;
    return -Math.max(4, Math.round(maxSpeed * intensity));
  }
  if (pointerY > containerRect.bottom - threshold) {
    const intensity = (pointerY - (containerRect.bottom - threshold)) / threshold;
    return Math.max(4, Math.round(maxSpeed * intensity));
  }
  return 0;
}
