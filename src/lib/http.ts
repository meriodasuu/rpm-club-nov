import { randomUUID } from "node:crypto";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(
    JSON.stringify(data, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...Object.fromEntries(new Headers(headers)),
      },
    },
  );
}
export async function body<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 1_000_000)
    throw new HttpError(413, "BODY_TOO_LARGE", "Слишком большой запрос");
  const text = (await readLimitedBody(request, 1_000_000)).toString("utf8");
  if (Buffer.byteLength(text) > 1_000_000)
    throw new HttpError(413, "BODY_TOO_LARGE", "Слишком большой запрос");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Некорректный формат запроса");
  }
  return schema.parse(data);
}
export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<Buffer> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    throw new HttpError(413, "BODY_TOO_LARGE", "Превышен размер запроса");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE", "Превышен размер запроса");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export async function formBody(request: Request, maxBytes: number) {
  return new Response(new Uint8Array(await readLimitedBody(request, maxBytes)), {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData();
}
export async function handle(work: () => Promise<Response>) {
  const requestId = randomUUID();
  try {
    const response = await work();
    response.headers.set("X-Request-ID", requestId);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          code: "VALIDATION_ERROR",
          message: "Проверьте заполнение полей",
          field_errors: error.flatten(),
          request_id: requestId,
        },
        422,
      );
    if (error instanceof HttpError)
      return json(
        { code: error.code, message: error.message, request_id: requestId },
        error.status,
      );
    if (
      error instanceof Error &&
      "status" in error &&
      "code" in error &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status < 500
    )
      return json(
        { code: error.code, message: error.message, request_id: requestId },
        error.status,
      );
    console.error("request_failed", {
      requestId,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "Сервис временно недоступен. Повторите попытку.",
        request_id: requestId,
      },
      503,
    );
  }
}
export function requireOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.APP_URL ?? "http://127.0.0.1:3000")
    .origin;
  if (origin !== expected)
    throw new HttpError(
      403,
      "INVALID_ORIGIN",
      "Запрос отклонён. Откройте приложение заново.",
    );
}
export const idSchema = z.string().uuid();
export function operationKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length > 128 || key.length < 8)
    throw new HttpError(
      422,
      "IDEMPOTENCY_REQUIRED",
      "Отсутствует ключ операции",
    );
  return key;
}
export function notFound(): never {
  throw new HttpError(404, "NOT_FOUND", "Запись не найдена");
}
