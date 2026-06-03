import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  navigate: vi.fn(),
  createSynthesisNote: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      createSynthesisNote: h.createSynthesisNote,
    },
  };
});

import { SynthesisCreate } from "./SynthesisCreate";

beforeEach(() => {
  h.desktop = true;
  h.navigate.mockReset();
  h.createSynthesisNote.mockReset();
  h.createSynthesisNote.mockResolvedValue({ element: { id: "syn-1" } });
});

describe("SynthesisCreate", () => {
  it("renders the desktop-only state without the bridge", () => {
    h.desktop = false;
    const { getByTestId, getByText } = render(<SynthesisCreate />);

    expect(getByTestId("route-synthesis-new")).toBeInTheDocument();
    expect(getByText(/open the Electron app/i)).toBeInTheDocument();
    expect(h.createSynthesisNote).not.toHaveBeenCalled();
  });

  it("creates a trimmed synthesis note and navigates to it", async () => {
    const { getByLabelText, getByTestId } = render(<SynthesisCreate />);

    expect(getByTestId("synthesis-create-save")).toBeDisabled();
    fireEvent.change(getByLabelText("Synthesis note title"), { target: { value: "  My Note  " } });
    expect(getByTestId("synthesis-create-save")).not.toBeDisabled();
    fireEvent.click(getByTestId("synthesis-create-save"));

    await waitFor(() => expect(h.createSynthesisNote).toHaveBeenCalledWith({ title: "My Note" }));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/synthesis/$id", params: { id: "syn-1" } });
  });

  it("shows an error when creation fails and re-enables the button", async () => {
    h.createSynthesisNote.mockRejectedValueOnce(new Error("db down"));
    const { getByLabelText, getByTestId } = render(<SynthesisCreate />);

    fireEvent.change(getByLabelText("Synthesis note title"), { target: { value: "Draft" } });
    fireEvent.keyDown(getByLabelText("Synthesis note title"), { key: "Enter" });

    await waitFor(() =>
      expect(getByTestId("synthesis-create-error")).toHaveTextContent(
        "Could not create the synthesis note.",
      ),
    );
    expect(getByTestId("synthesis-create-save")).not.toBeDisabled();
  });

  it("cancels back to the library", () => {
    const { getByText } = render(<SynthesisCreate />);

    fireEvent.click(getByText("Cancel"));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/library" });
  });
});
