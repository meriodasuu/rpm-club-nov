import { afterEach, expect, it, vi } from "vitest";
import { authRoute } from "../src/lib/auth/routes";
import { handle } from "../src/lib/http";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("retires password login without external authentication or issuing a session", async () => {
  const origin = "http://127.0.0.1:3001";
  vi.stubEnv("APP_URL", origin);
  const external = vi.fn();
  vi.stubGlobal("fetch", external);
  const response = await handle(
    async () =>
      (await authRoute(
        new Request(origin + "/api/auth/staff/login", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            email: "staff@example.com",
            password: "synthetic",
          }),
        }),
        "auth/staff/login",
      ))!,
  );
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({
    code: "TELEGRAM_LOGIN_REQUIRED",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(external).not.toHaveBeenCalled();
});
