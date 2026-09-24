import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { operationsRoute } from "../src/lib/api/operations";
import { handle } from "../src/lib/http";

vi.mock("../src/lib/auth/session", async (original) => ({
  ...(await original<typeof import("../src/lib/auth/session")>()),
  requireStaff: vi
    .fn()
    .mockResolvedValue({ id: "media-test", role: "manager" }),
}));

async function upload(bytes: Uint8Array) {
  vi.stubEnv("APP_URL", "http://127.0.0.1:3001");
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(bytes)], "image.jpg", { type: "image/jpeg" }),
  );
  return handle(
    async () =>
      (await operationsRoute(
        new Request("http://127.0.0.1:3001/api/admin/media", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:3001" },
          body: form,
        }),
        "admin/media",
      ))!,
  );
}

describe("invalid admin images", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns an actionable validation error for corrupt image data", async () => {
    const response = await upload(Buffer.from("not an image"));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "IMAGE_INVALID" });
  });
  it("rejects oversized dimensions before attempting to store a compressed image", async () => {
    const bytes = await sharp({
      create: { width: 5001, height: 5000, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    const response = await upload(bytes);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "IMAGE_INVALID" });
  });
});
