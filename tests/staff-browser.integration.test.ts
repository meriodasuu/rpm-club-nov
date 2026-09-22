import { describe, expect, it } from "vitest";
import { authRoute } from "../src/lib/auth/routes";
import { handle } from "../src/lib/http";
describe("Retired browser session handoff", () => {
  it.each(["auth/staff/browser-link", "auth/staff/browser-redeem"])(
    "rejects %s even with an old cookie",
    async (path) => {
      const response = await handle(
        async () =>
          (await authRoute(
            new Request("http://127.0.0.1:3001/api/" + path, {
              method: "POST",
              headers: {
                origin: "http://127.0.0.1:3001",
                cookie: "rpm_staff=" + "a".repeat(43),
              },
              body: JSON.stringify({ code: "a".repeat(43) }),
            }),
            path,
          ))!,
      );
      expect(response.status).toBe(410);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await response.json()).code).toBe("STAFF_BOT_ONLY");
    },
  );
});
