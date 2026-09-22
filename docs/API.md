# HTTP API RPM Club

Все пути начинаются с `/api`. JSON UTF-8, ответы `Cache-Control: no-store`. Денежные значения — строки целых копеек, Bonus — строки целых единиц. Ошибка: `{code,message,request_id,field_errors?}`. Статусы: 401 сессия/подпись, 403 роль/Origin, 404 запись, 409 конфликт, 422 поля, 429 лимит, 503 зависимость. Успех не возвращается при ошибке БД.

Cookie `rpm_session` — Telegram-клиент, `rpm_staff` — сотрудник; HttpOnly, SameSite=Lax, Secure в production. Изменяющие browser-запросы требуют `Origin=APP_URL`. Экономические команды требуют `Idempotency-Key` (8–128 символов); тот же ключ с другим payload отклоняется.

## Вход и клиент

| Метод и путь | Контракт |
|---|---|
| POST auth/telegram | `{initData}`; HMAC, возраст ≤300с, server-derived Telegram identity |
| POST me/contact-request | Создать запрос контакта, 5 минут |
| POST telegram/webhook | Telegram update + X-Telegram-Bot-Api-Secret-Token; дедупликация update_id |
| GET me/onboarding | active/contact_verified/phone/актуальные document IDs |
| POST me/activate | `{documentIds:[3 UUID],referralCode?,marketingConsent}`; атомарная привязка/согласия/referral |
| GET me | Snapshot, tier/progress/Bonus, ссылки |
| GET me/qr | SVG с `/m/<public_member_id>`; PII в QR нет |
| GET loyalty/tiers | Текущая версия программы |
| GET me/rentals, me/transactions | `?limit=20&cursor=...`; items/nextCursor; только свой счёт |
| GET me/referral | code/url/items без контактных данных приглашённых |
| PATCH me/preferences | `{marketingConsent:boolean}` |
| GET offers, offers/{id} | Только активные, не истёкшие и подходящие уровню |
| POST analytics | `{eventId:UUID,name,entityId?}`; allowlist событий, дедупликация |
| POST auth/logout | Отозвать текущую сессию |

## Админка

`POST auth/staff/login`: `{email,password,otp?,factorId?}`. Ответ либо authenticated+cookie, либо mfa_required и enrollment `{factorId,qrCode}`. Enrollment QR секретен: не сохранять в логах. Admin получает cookie только после TOTP. `auth/staff/logout` отзывает сессию.

GET admin/me/dashboard/customers/rentals/transactions/tiers/referrals/imports/offers доступны staff. Audit/settings/deliveries/team/legal — admin. Пагинация основных списков `page` с нуля, по 50 записей. Фильтры аренд/операций описаны непосредственно в API handler и UI; суммы не вычисляются браузером.

| Команда | Данные |
|---|---|
| POST admin/rentals | userId, externalRentalId, carName, startDate/endDate YYYY-MM-DD, amountKopecks, status, paymentStatus, reason |
| POST admin/rentals/{id}/status | status accepted/in_progress/completed/cancelled, paymentStatus, expectedVersion (число из rentals.version), reason; manager/admin; автоматические Bonus и tier |
| POST admin/rentals/{id}/adjust | amountKopecks, reason |
| POST admin/rentals/{id}/cancel | reason |
| POST admin/bonus/credit | userId, amount, expiresAt? ISO, reason |
| POST admin/bonus/debit | userId, amount, reason |
| POST admin/bonus/redeem | userId, amount, externalRentalId, eligiblePriceKopecks, reason |
| POST admin/bonus/reverse | transactionId, reason |
| POST admin/customers/{id}/tier | tier/null, reason; только admin, no downgrade |
| POST admin/customers/{id}/block, restore | reason; admin |
| POST admin/customers/{id}/identity | name, phone/null, telegramId/null, expectedVersion, identityVerified:true, reason от 10 символов; admin, отзыв сессий, аудит/outbox |
| POST admin/program-preview | tiers[{code,thresholdKopecks}]; влияние порогов без мутаций |
| POST admin/program-versions | Полный Program input по CORE-CONTRACT + reason; новая immutable версия |
| POST/PATCH admin/offers[/{id}] | title/subtitle/car_name/description/image_url/prices/tiers/dates/CTA/active; PATCH expected_version |
| GET/POST admin/offers/{id}/campaigns | GET recipients/version; POST expectedVersion создаёт очередь конкретной версии |
| POST admin/media | multipart file, JPEG/PNG/WebP ≤5МБ, результат {url} |
| POST admin/team | authUserId/name/email/role/active/reason; admin |
| POST admin/legal | type/version/title/text; immutable редакция |
| POST admin/deliveries/{id}/retry | Повтор retry/dead, admin, аудит |

## CSV/XLSX

Шаблон: `public/templates/rentals.csv`. POST admin/imports multipart `{file,mode,delimiter,legacyCompletedPaid}` → `{batch,stats,rows}`. Mode historical доступен admin; operational — manager/admin. POST admin/imports/{id}/commit подтверждает valid-строки. GET admin/imports/{id} — результат/первые100строк, GET .../errors — CSV ошибок. Остальные chunks завершает worker.

Канонические колонки: external_rental_id (aliases external_id/rental_id), customer_name, phone, crm_customer_id?, car_name, start_date, end_date, rental_amount (alias amount, рубли), status, payment_status, qualified_at?. Разные значения aliases отклоняются. CSV UTF-8 с запятой/точкой с запятой, XLSX один лист. ≤10МБ/10000строк. Формулы, hyperlinks, rich text, VBA/external links запрещены. QualifiedAt и date-only записи сортируются по общей шкале времени.

Status accepted/in_progress/completed/cancelled; payment paid/unpaid/partial/refunded. Только completed+paid влияет на экономику. Операции текущего дня без времени используют фактическое подтверждение; исторические даты без времени — конец дня Москвы. Повторная проверка при commit защищает от изменений после preview.

## CRM integration

POST integrations/rentals принимает канонический объект одной строки импорта. Заголовки `Authorization: Bearer <INTEGRATION_API_KEY>`, `Idempotency-Key`. UserId не доверяется, клиент разрешается по проверенной phone/CRM связи. POST integrations/rentals/{external_id}/adjust или cancel принимает reason и amountKopecks для adjustment. Integration может изменять только источник rpm; ручные Bonus и настройки недоступны.

## Ручные награды за приглашения

- `GET admin/referral-program` — текущая редакция или `program: null`; доступен сотрудникам.
- `POST admin/referral-program` — только admin; `{enabled, referrer: {title, terms}, referred: {title, terms}, expectedVersion, reason}`. Заголовок `Idempotency-Key` обязателен. Несовпадение версии — 409. Первая активация фиксирует границу для новых аренд; отключение не отменяет возникшие награды.
- `GET admin/referrals?page=0&q=...&status=pending` — приглашения с массивом `awards`; статус фильтра: pending/issued/cancelled/review. Поля прежних наград Bonus сохраняются отдельно.
- `POST admin/referral-awards/{id}/issue` — admin/manager; `{confirmed: true, comment}` и `Idempotency-Key`. Выдача и отмена аренды сериализованы; повтор не создаёт второй факт выдачи. Наблюдателю запрещено.
- `GET me/referral` дополнен публичными условиями `program` и собственными наградами `awards`. В ответ не включаются служебная причина публикации, авторы и чужие награды.

Перед выкладкой кода обязательна миграция `20260922120313_manual_referral_awards.sql`. Порядок и ограничения отката: `ADMIN-UX-RELEASE.md`.

## Диагностика фонового обслуживания

Ошибки `job_maintenance` содержат безопасные `stage`, `code`, `runId`. Произвольный текст исключения/DSN не сохраняется. Успешный этап закрывает только прежние ошибки этого этапа. Старые записи без этапа требуют отдельного разбора и автоматически не скрываются. `jobs:last-maintenance-success` отделён от общего heartbeat обработчика; `GET admin/deliveries` возвращает последнее успешное обслуживание.

GET/POST internal/jobs требует Bearer CRON_SECRET; финансовые записи не переигрываются при доставке. Публичный `/m/{memberId}` перенаправляет staff к карточке, остальных — на staff login, не раскрывая наличие клиента.
