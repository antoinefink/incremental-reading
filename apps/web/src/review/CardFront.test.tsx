import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardFront } from "./CardFront";

describe("CardFront", () => {
  it("renders Q&A prompts through the shared card body", () => {
    render(<CardFront card={{ kind: "qa", prompt: "What is the answer?" }} revealed={false} />);

    expect(screen.getByText("What is the answer?")).toBeInTheDocument();
  });

  it("masks every cloze deletion until reveal", () => {
    render(
      <CardFront
        card={{ kind: "cloze", prompt: "{{c1::Alpha}} links to {{c2::Beta}}" }}
        revealed={false}
      />,
    );

    expect(screen.getAllByText("[ … ]")).toHaveLength(2);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("reveals every cloze deletion after reveal", () => {
    render(
      <CardFront
        card={{ kind: "cloze", prompt: "{{c1::Alpha}} links to {{c2::Beta}}" }}
        revealed={true}
      />,
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("[ … ]")).toBeNull();
  });
});
