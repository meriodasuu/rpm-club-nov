import { HttpError } from "@/lib/http";

export function normalizeUsername(raw: string) {
  const username = raw.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(username))
    throw new HttpError(
      422,
      "USERNAME_INVALID",
      "Введите Telegram-ник, например @wthtwn",
    );
  return username;
}

// Resolve a known private chat by immutable ID, never trust a cached username
// when granting privileges: Telegram usernames can change owners.
export async function verifyTelegramUsername(
  telegramId: string,
  username: string,
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  let chat: { id?: number; type?: string; username?: string };
  try {
    if (!token) throw new Error("Unavailable");
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getChat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: telegramId }),
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      },
    );
    const data = await response.json();
    if (!response.ok || !data.ok || !data.result)
      throw new Error("Unavailable");
    chat = data.result;
  } catch {
    throw new HttpError(
      503,
      "TELEGRAM_UNAVAILABLE",
      "Не удалось проверить Telegram-аккаунт. Повторите поиск позже.",
    );
  }
  if (
    String(chat.id) !== telegramId ||
    chat.type !== "private" ||
    chat.username?.toLowerCase() !== username
  )
    throw new HttpError(
      409,
      "USERNAME_CHANGED",
      "Telegram-ник изменился. Попросите пользователя снова открыть Club и повторите поиск.",
    );
}
