type OfferPeriod = {
  active: boolean;
  start_at: string | Date;
  end_at: string | Date;
};

function moscowTime(value: string | Date) {
  return (
    new Date(value).toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      dateStyle: "short",
      timeStyle: "short",
    }) + " МСК"
  );
}

export function offerCampaignBlockReason(offer: OfferPeriod, now = Date.now()) {
  if (!offer.active)
    return "Предложение не опубликовано. Откройте редактирование, включите «Опубликовать в клубе» и сохраните.";
  if (new Date(offer.end_at).getTime() <= now)
    return `Предложение завершилось ${moscowTime(offer.end_at)}. Измените срок действия перед рассылкой.`;
  if (new Date(offer.start_at).getTime() > now)
    return `Предложение ещё не началось. Рассылка доступна с ${moscowTime(offer.start_at)}. Для отправки сейчас измените начало действия.`;
  return null;
}

export function offerStatusLabel(offer: OfferPeriod, now = Date.now()) {
  if (!offer.active) return "СКРЫТО";
  if (new Date(offer.end_at).getTime() <= now) return "ЗАВЕРШЕНО";
  if (new Date(offer.start_at).getTime() > now) return "ЗАПЛАНИРОВАНО";
  return "АКТИВНО";
}
