/** Dragging a row with the pointer: where it lands, and where the drop line
 *  says it will. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";

import { useRowReorder } from "./useRowReorder";

afterEach(cleanup);

const ROWS = ["A", "B", "C", "D", "E"];

function List({ onMove }: { onMove: (from: number, to: number) => void }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drag = useRowReorder({ bodyRef, rowCount: ROWS.length, onMove });
  return (
    <div className="tb" ref={bodyRef} data-testid="body">
      {ROWS.map((row, index) => {
        const props = drag.rowProps(index);
        return (
          <div key={row} className={["tr", props.className].filter(Boolean).join(" ")} data-testid={row} onPointerDown={props.onPointerDown}>
            {row}
          </div>
        );
      })}
    </div>
  );
}

/** jsdom lays nothing out: give the list a place on screen and its rows the
 *  dialogs' 40 px height (ui.css `.dialog.xl .db .tbl .tr`). */
function layOut(body: HTMLElement, rowHeight: number) {
  body.getBoundingClientRect = () => ({ top: 0, bottom: 1000, left: 0, right: 400, width: 400, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
  body.querySelectorAll<HTMLElement>(".tr").forEach((row) => Object.defineProperty(row, "offsetHeight", { configurable: true, value: rowHeight }));
}

const pointer = (type: string, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, clientX: 10, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
};

function dragFromTo(container: ReturnType<typeof render>, row: string, fromY: number, toY: number) {
  fireEvent(container.getByTestId(row), pointer("pointerdown", fromY));
  act(() => {
    window.dispatchEvent(pointer("pointermove", fromY + 10));
    window.dispatchEvent(pointer("pointermove", toY));
  });
}

describe("useRowReorder", () => {
  it("measures the rows, so a 40 px row under the pointer is the one dropped on", () => {
    const onMove = vi.fn();
    const view = render(<List onMove={onMove} />);
    layOut(view.getByTestId("body"), 40);

    // 2 px of body padding, then rows of 40: y 112 is inside the third row
    // (82–122). A 32 px guess would put it in the fourth.
    dragFromTo(view, "A", 20, 112);
    act(() => {
      window.dispatchEvent(pointer("pointerup", 112));
    });

    expect(onMove).toHaveBeenCalledWith(0, 2);
  });

  it("draws the drop line below the target when dragging down, above it when dragging up", () => {
    const view = render(<List onMove={vi.fn()} />);
    layOut(view.getByTestId("body"), 40);

    dragFromTo(view, "A", 20, 112);
    expect(view.getByTestId("C").className).toBe("tr drop after");
    act(() => {
      window.dispatchEvent(pointer("pointerup", 112));
    });

    dragFromTo(view, "E", 180, 60);
    expect(view.getByTestId("B").className).toBe("tr drop");
  });
});
