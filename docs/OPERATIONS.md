# Эксплуатация RPM Club

## Запуск и окружения

Локально: `npm ci`, `npm run setup:local`, `npm run dev`. Origin и APP_URL должны совпадать: `http://127.0.0.1:3001`. Не запускать seed против реальных данных.

Production: отдельная PostgreSQL/Supabase БД и ключи, `NODE_ENV=production`, `LOCAL_PREVIEW=0`, публичный HTTPS APP_URL. Установить зависимости, применить миграции, выполнить `npm run build`, запустить `npm run start` за HTTPS reverse proxy. Для контейнерного хостинга использовать `next start --hostname 0.0.0.0 --port 3001` внутри закрытой сети. Нужен Node runtime, постоянное соединение с PostgreSQL и scheduler. При serverless проверить лимиты соединений и длительности worker. Состояние облачной публикации — в VERCEL-DEPLOYMENT.md.

DATABASE_URL доступен только серверу. Таблицы защищены RLS, ledger/audit — append-only триггерами. Браузер не получает DB URL или service-role key. Runtime выполняет SQL через серверную БД-роль; не предоставлять anon/authenticated произвольные grants. Миграции выполняются административной ролью до новой версии приложения. Изменение checksum применённой миграции останавливает runner.

## Credentials и подключения

Полный список — `.env.example`. SESSION_SECRET, ENCRYPTION_KEY, CRON_SECRET, INTEGRATION_API_KEY независимы. ENCRYPTION_KEY — 32 байта base64/64 hex; SESSION_SECRET и CRON_SECRET — минимум 32 символа. Без конфигурации провайдер отвечает ошибкой, успешная доставка не имитируется.

**Telegram:** создать/выбрать бота, настроить Main Mini App/menu button с APP_URL, webhook `/api/telegram/webhook` и secret_token=TELEGRAM_WEBHOOK_SECRET. Контакт принимается только из private chat, если contact.user_id совпадает с sender и есть непросроченный запрос. Приглашение: `startapp=ref_<code>`. Проверить вход, свой/чужой контакт, отказ/повтор контакта и сообщения на тестовом пользователе.

**Supabase:** URL, publishable и service-role key; создать staff-account в Auth. В чистой production БД первый admin назначается `npm run staff:bootstrap -- email@example.com`; скрипт отказывается, если memberships уже есть. `/admin/login` показывает QR TOTP; сессия не выдаётся до проверки кода. Остальных сотрудников назначать через раздел «Сотрудники» по существующему Auth User ID. Смена роли/активности отзывает старые сессии; promotion требует нового MFA-входа. Восстановление пароля/MFA выполняет владелец Auth-проекта после внешней проверки личности.

**Storage:** отдельный public bucket rpm-offers только для изображений Drops. Сервер проверяет RBAC, декодируемый формат/размер, преобразует в WebP. Импорт, PII и сертификаты туда не помещать. Без Storage development использует `.local/media`; production отвечает ошибкой.

## Worker и диагностика

Раз в минуту выполнять `npm run jobs` либо HTTPS GET/POST `/api/internal/jobs` с `Authorization: Bearer <CRON_SECRET>`. Не передавать секрет через query string или клиентский код. При подключённых credentials задания действительно отправляют запросы Telegram.

Доставки независимы, lease 120 секунд с owner token, максимум 7 попыток. Backoff/jitter учитывает Retry-After. Telegram 403 отключает reachability. Потеря ответа может вызвать повтор сообщения, но не повтор экономики. Перед Drop проверяются согласие, статус, tier, период и версия предложения. Редактирование подавляет старые ожидающие deliveries; для нового текста нужна новая кампания.

Tiers пересчитываются по 50 клиентов с durable cursor; импорт — до 25 строк/10 секунд за chunk, с lease и возобновлением; expiration — 50 счетов. Ежедневная сверка читает все ledger/projections: перед масштабированием измерить её длительность. Бюджет delivery loop не гарантирует длительность всех SQL maintenance.

`/api/health` проверяет процесс, `/api/ready` — БД. Админка «Доставка»: retry/dead, operational_errors. `program_settings.jobs:last-run` — heartbeat. Настроить внешние алерты на отсутствие heartbeat, возраст очереди, DB errors, сертификаты. В production не включать логирование request bodies с initData/contact/секретами. Provider response bodies и URL с credentials не сохраняются.

## Импорт и исправления

Historical переносит сумму и tier без cashback. Старый баланс переносится отдельным начислением с подтверждённым сроком. Operational начисляет только completed+paid; база — аренда после скидок, без залога, штрафов и доплат.

Preview не создаёт клиентов/экономику, показывает дубли, ошибки и строки без начисления. Commit обрабатывает valid-строки; ошибка одной не откатывает уже проведённые. CSV ошибок доступен из результата. Повтор внешнего ID не создаёт второе начисление. После смены программы получить новый preview.

Исправлять сумму через adjustment, аренду — cancel. История сохраняет компенсации. Потраченный отменённый Bonus образует внутренний дефицит, новые начисления сначала закрывают его. Доступный баланс не отрицательный, статус не падает. Ledger нельзя править UPDATE/DELETE.

## Backup, restore, rollback

До production включить ежедневные backups и проверить retention/тариф провайдера. Цели RPO ≤24ч, RTO ≤4ч ещё не подтверждены восстановлением.

Self-managed пример в защищённом shell: `pg_dump --format=custom --file=rpm-club.dump "$DATABASE_URL"`. Dump и секреты хранить отдельно, не в Git. Восстанавливать `pg_restore --no-owner --dbname="$RESTORE_DATABASE_URL" rpm-club.dump` только в новую изолированную БД. На restore-среде отключить provider credentials/scheduler. Проверить checksum схемы, reconcileAccounts, счета/проводки, leases и истории. Восстановленная очередь не должна рассылать сообщения реальным пользователям.

Rollback приложения: предыдущий build, совместимый с текущей схемой. Миграции не переписывать; исправления новым SQL. Несовместимая схема требует отдельного плана. Экономические изменения отменять компенсирующими командами; старый dump не накатывать поверх новых аренд.

Перед публикацией утвердить решения D01–D09/юридические тексты и проверить реальную выгрузку, Telegram, MFA, нагрузку, backup/restore и полный A40. Актуальные облачные настройки описаны в VERCEL-DEPLOYMENT.md.
