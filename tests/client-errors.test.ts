import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/components/shared";

afterEach(() => vi.unstubAllGlobals());
describe("client HTTP failures behind the reverse proxy", () => {
  it("shows a readable error for a proxy HTML error without exposing its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>private upstream details</html>", {
            status: 502,
          }),
        ),
    );
    await expect(api("me")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 502,
      message: "Сервис временно недоступен. Повторите попытку позже.",
    });
  });
  it("explains proxy upload limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 413 })),
    );
    await expect(api("admin/media")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 413,
      message: "Файл или запрос слишком большой.",
    });
  });
  it("rejects an invalid successful response and preserves structured server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("<html>Maintenance</html>"))
        .mockResolvedValueOnce(
          Response.json(
            { code: "RENTAL_CONFLICT", message: "Автомобиль занят" },
            { status: 409 },
          ),
        ),
    );
    await expect(api("me")).rejects.toBeInstanceOf(ApiError);
    await expect(api("me/rental-requests")).rejects.toMatchObject({
      code: "RENTAL_CONFLICT",
      status: 409,
      message: "Автомобиль занят",
    });
  });
});
