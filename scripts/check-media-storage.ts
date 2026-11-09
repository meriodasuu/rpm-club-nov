import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.env.MEDIA_DIR;
if (!root || !path.isAbsolute(root)) {
  console.error(
    "MEDIA_DIR must be an absolute path to persistent media storage",
  );
  process.exitCode = 1;
} else {
  const probe = path.join(root, `.rpm-media-check-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(probe, "rpm-media-check", { flag: "wx", mode: 0o600 });
    if ((await readFile(probe, "utf8")) !== "rpm-media-check")
      throw new Error("readback failed");
    console.log("MEDIA_DIR is writable and readable");
  } catch {
    console.error(
      "MEDIA_DIR is not writable/readable; check the mounted volume and UID/GID 1000",
    );
    process.exitCode = 1;
  } finally {
    await unlink(probe).catch(() => {});
  }
}
