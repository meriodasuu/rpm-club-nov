import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { HttpError } from "./http";

function directory() {
  const configured = process.env.MEDIA_DIR;
  if (configured && path.isAbsolute(configured)) return configured;
  if (process.env.NODE_ENV !== "production" && !configured)
    return path.resolve(".local/media");
  throw new HttpError(
    503,
    "STORAGE_UNAVAILABLE",
    "Хранилище изображений не настроено",
  );
}

export async function saveMedia(name: string, data: Buffer) {
  const root = directory();
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, name), data, { flag: "wx", mode: 0o640 });
  } catch {
    throw new HttpError(
      503,
      "UPLOAD_FAILED",
      "Не удалось сохранить изображение",
    );
  }
}

export async function loadMedia(name: string) {
  const root = directory();
  try {
    return await readFile(path.join(root, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HttpError(
      503,
      "STORAGE_UNAVAILABLE",
      "Хранилище изображений недоступно",
    );
  }
}
