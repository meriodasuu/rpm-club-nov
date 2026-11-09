import { describe, expect, it } from "vitest";
import { ApiError } from "../src/components/shared";
import { prizeSaveError } from "../src/components/admin/roulette";

describe("roulette prize form errors", () => {
  it("identifies the invalid field instead of showing a generic error", () => {
    const error = new ApiError("VALIDATION_ERROR", "Проверьте заполнение полей", 422, {
      title: ["Too small: expected string to have >=2 characters"],
    });
    expect(prizeSaveError(error)).toContain("Название:");
    expect(prizeSaveError(error)).not.toBe("Проверьте заполнение полей");
  });
});
