import { describe, expect, it } from "vitest";
import { authRoute } from "../src/lib/auth/routes";
import { handle } from "../src/lib/http";
describe("Retired Mini App staff authentication", () => {
  it.each(["auth/staff/telegram", "auth/staff/bot-link"])(
    "rejects %s without returning enrollment secrets or a session",
    async (path) => {
      const response = await handle(
        async () =>
          (await authRoute(
            new Request("http://127.0.0.1:3001/api/" + path, {
              method: "POST",
              headers: {
                origin: "http://127.0.0.1:3001",
                cookie: "rpm_session=" + "a".repeat(43),
              },
              body: JSON.stringify({ initData: "old-client", otp: "123456" }),
            }),
            path,
          ))!,
      );
      expect(response.status).toBe(410);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await response.json()).enrollment).toBeUndefined();
    },
  );
});
