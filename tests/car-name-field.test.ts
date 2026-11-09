import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/shared", () => ({
  Field: ({ children }: { children: React.ReactNode }) =>
    createElement("label", null, children),
  FormMessage: () => null,
  Spinner: () => null,
  useResource: () => ({
    data: {
      items: [
        { id: "taycan", title: "Porsche Taycan", active: true },
        { id: "hidden", title: "Скрытый автомобиль", active: false },
      ],
    },
  }),
}));

import { CarNameField } from "../src/components/admin/customer-picker";

describe("manual rental car selection", () => {
  it("offers only published catalog cars in a dropdown", () => {
    const markup = renderToStaticMarkup(createElement(CarNameField));

    expect(markup).toContain('<select name="carName"');
    expect(markup).toContain("Porsche Taycan");
    expect(markup).not.toContain("Скрытый автомобиль");
  });
});
