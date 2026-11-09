# Безопасная интеграция бота RPM Rent

## Граница доступа

Бот не получает прав на таблицы `public.users`, `public.rentals`, `public.roulette_attempt_credits` и другие основные таблицы RPM Club. Он может вызывать только функции схемы `integration` через роль-группу `rpm_rent_bot_api`.

Отдельный логин бота создаётся администратором БД и включается только в эту группу. PostgreSQL остаётся во внутренней Docker-сети `rpm-club_backend`; из контейнера бота используются host `rpm-club-db`, port `5432`, database `rpm_club`.

Пример секрета для контейнера бота: `RPM_CLUB_DATABASE_URL=postgresql://rpm_rent_bot:<пароль>@rpm-club-db:5432/rpm_club`. Пароль хранится только в закрытом env-файле сервера, не в репозитории.

## ID клиента

`user_id` — UUID из RPM Club и единственный технический ключ связи. Он возвращается поиском и передаётся во все остальные функции.

`public_member_id` — публичный отображаемый ID. Не используйте телефон, Telegram ID или username как постоянный ключ: они могут меняться или отсутствовать.

## Доступные функции

| Функция | Назначение | Результат |
|---|---|---|
| `integration.find_clients(username, telegram_id, phone, name)` | Поиск клиента. Укажите хотя бы одно поле; поиск по имени — от 2 символов; максимум 20 строк. | `user_id`, `public_member_id`, имя, телефон, Telegram ID/username, `account_status`, `blacklisted` |
| `integration.client_rental_history(user_id, limit)` | История аренд клиента, `limit` от 1 до 100. | ID аренды, внешний ID, авто, даты, статусы, стоимость в копейках, даты выдачи/завершения |
| `integration.client_blacklist_status(user_id)` | Текущий статус чёрного списка. | `account_status`, `blacklisted` |
| `integration.set_client_blacklist_status(user_id, blacklisted, actor_id, reason)` | Изменить чёрный список с аудитом. | Новый статус и флаг `changed` |
| `integration.grant_daily_roulette_attempt(user_id, actor_id, reason)` | Начислить одну попытку. | `granted`, ID начисления, срок действия |
| `integration.record_rental_event(...)` | Записать событие аренды в неизменяемый журнал. | ID события, признак повторной доставки, ID связанной аренды Club |

## Статусы

Статус аккаунта: `pending`, `active`, `blocked`. Чёрный список — это `account_status = blocked`.

При снятии с чёрного списка ранее заблокированный клиент становится `active`; `pending` без блокировки остаётся `pending`.

Статусы основной аренды в истории: `accepted`, `in_progress`, `completed`, `cancelled`. Статусы оплаты: `unpaid`, `partial`, `paid`, `refunded`.

Статус интеграционного события аренды: `started`, `completed`, `cancelled`. Для него обязательны `event_key` UUID для идемпотентности, `user_id`, внешний ID аренды, автомобиль, даты, время события, роль исполнителя (`manager` или `technician`) и его ID.

## Правила записи

- Попытка выдаётся только активному клиенту.
- Для одного клиента бот может выдать не более одной попытки за московский календарный день. Повторный вызов возвращает ту же запись с `granted = false`.
- События аренды не меняют напрямую `public.rentals`: бот записывает подтверждённый журнал, а бизнес-обработчик Club остаётся единственной точкой изменения основной аренды, бонусов и уровней.
- Все изменения чёрного списка, попыток и новые события аудируются. Журнал событий аренды неизменяем.

## Примеры вызовов

```sql
SELECT * FROM integration.find_clients('@rpm_client', NULL, NULL, NULL);
SELECT * FROM integration.client_rental_history('00000000-0000-0000-0000-000000000000', 50);
SELECT * FROM integration.set_client_blacklist_status(
  '00000000-0000-0000-0000-000000000000', true, 'manager:42', 'Нарушение правил аренды'
);
SELECT * FROM integration.grant_daily_roulette_attempt(
  '00000000-0000-0000-0000-000000000000', 'manager:42', 'Компенсация от менеджера'
);
SELECT * FROM integration.record_rental_event(
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'RPM-RENT-12345', 'Porsche 911', DATE '2026-10-30', DATE '2026-11-01',
  'started', now(), 'manager', 'manager:42'
);
```

Настройка роли находится в [rpm-rent-bot-access.sql](rpm-rent-bot-access.sql). Миграция интеграционного API — [20261030110000_rpm_rent_bot_integration.sql](20261030110000_rpm_rent_bot_integration.sql).
