import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DelayField, delayInputsAreValid } from "./DelayField";

describe("DelayField", () => {
  beforeEach(cleanup);

  it("shows no error and stays valid for a usable value", () => {
    render(<DelayField value="-1.5" onChange={vi.fn()} />);

    const input = screen.getByLabelText(/delay/i);
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains an unusable value instead of silently treating it as zero", () => {
    render(<DelayField value="abc" onChange={vi.fn()} />);

    expect(screen.getByLabelText(/delay/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/enter a number of seconds/i);
  });

  it("accepts a comma decimal separator, which used to mux as no delay at all", () => {
    render(<DelayField value="1,5" onChange={vi.fn()} />);

    expect(screen.getByLabelText(/delay/i)).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports what was typed so the caller keeps control of the value", () => {
    const onChange = vi.fn();
    render(<DelayField value="0.000" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/delay/i), { target: { value: "2.5" } });

    expect(onChange).toHaveBeenCalledWith("2.5");
  });

  it("shows a hint when there is nothing wrong, and replaces it with the error when there is", () => {
    const { rerender } = render(
      <DelayField value="0" onChange={vi.fn()} hint="Positive delays the track." />,
    );
    expect(screen.getByText(/positive delays the track/i)).toBeInTheDocument();

    rerender(<DelayField value="!!" onChange={vi.fn()} hint="Positive delays the track." />);
    expect(screen.queryByText(/positive delays the track/i)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("delayInputsAreValid", () => {
  it("is true only when every value can be used, for gating a Save button", () => {
    expect(delayInputsAreValid("1", "-2.5", "")).toBe(true);
    expect(delayInputsAreValid("1", "oops")).toBe(false);
  });
});
