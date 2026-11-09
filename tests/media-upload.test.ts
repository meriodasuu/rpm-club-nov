import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { mkdtemp, readdir, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { operationsRoute } from "../src/lib/api/operations";
import { handle } from "../src/lib/http";

vi.mock("../src/lib/auth/session", async (original) => ({
  ...(await original<typeof import("../src/lib/auth/session")>()),
  requireStaff: vi
    .fn()
    .mockResolvedValue({ id: "media-test", role: "manager" }),
}));

async function upload(bytes: Uint8Array, type = "image/jpeg") {
  vi.stubEnv("APP_URL", "http://127.0.0.1:3001");
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "image", { type }));
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
  it("stores production uploads on disk and serves them without a provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rpm-media-test-"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEDIA_DIR", root);
    try {
      for (const format of ["jpeg", "png", "webp"] as const) {
        const source = sharp({
          create: { width: 16, height: 16, channels: 3, background: "red" },
        });
        const bytes = await source.toFormat(format).toBuffer();
        const response = await upload(bytes, `image/${format}`);
        expect(response.status).toBe(200);
        const { url } = await response.json();
        expect(url).toMatch(/^\/api\/media\/[a-f0-9-]{36}\.webp$/);
        const stored = await operationsRoute(
          new Request("http://127.0.0.1:3001" + url),
          url.slice(5),
        );
        expect(stored?.status).toBe(200);
        expect(stored?.headers.get("content-type")).toBe("image/webp");
        expect(
          (await sharp(Buffer.from(await stored!.arrayBuffer())).metadata())
            .format,
        ).toBe("webp");
      }
      const missing = await handle(
        async () =>
          (await operationsRoute(
            new Request("http://127.0.0.1:3001/api/media/missing"),
            "media/00000000-0000-0000-0000-000000000000.webp",
          ))!,
      );
      expect(missing?.status).toBe(404);
    } finally {
      for (const file of await readdir(root))
        await unlink(path.join(root, file));
      await rmdir(root);
    }
  });
  it("refuses an unconfigured production media directory", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEDIA_DIR", "");
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    expect((await upload(bytes)).status).toBe(503);
  });
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
