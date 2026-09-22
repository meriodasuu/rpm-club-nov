# RPM Club — определения и сохранённые SQL

День отчёта — Europe/Moscow. Суммы аренд в SQL — целые копейки, Bonus — целые единицы; агрегаты не переводятся через float. Параметры периода задаются как timestamptz, нижняя граница включается, верхняя исключается. Запросы выполняются серверным отчётным доступом; не публикуйте строки с идентификаторами клиентов. Ниже сохранённые запросы, а не заявления о текущих результатах: Эти SQL-запросы на БД в этом этапе не выполнялись.

## API и фильтры

- `GET /api/admin/rentals`: `status=completed|in_progress|cancelled`, `payment_status=paid|unpaid|partial|refunded`, `source`, `date_from/date_to=YYYY-MM-DD`, `page`. Даты фильтруют `end_date`, обе границы включительно.
- `GET /api/admin/transactions`: `type`, `user_id` UUID, `q` (имя, телефон, Member ID, username), `date_from/date_to`, `page`. Даты — календарные дни Москвы по `created_at`, верхняя граница реализована как начало следующего дня. Поля строк включают `reverses_id`, `remaining_amount`, `expires_at`, `reversed_amount`, `reversible_amount`.
- Ответ списков `{items,page,total}`; размер страницы 50. Для пустой страницы `total=0` из оконного счётчика; UI сбрасывает страницу при применении фильтров.
- Поиск клиента распознаёт формат `8 (900) 123-45-67` как `79001234567`, а также `+7…` и фрагменты номера. Специальные LIKE-символы экранируются. Клиентская карточка добавляет `crmCustomerId`, `crmIdentities` и имена обеих сторон referral.

## Dashboard и Bonus Redemption

Dashboard показывает текущие итоги за всё время. `gross_credits` — положительные начисления без reversals и opening; `opening_balance` — manual_credit с точной причиной opening_balance. `reversal_credits` и `reversal_debits` — положительная и абсолютная отрицательная части компенсирующих операций. `redeemed`, `manual_debits`, `expired` показываются положительными величинами. `net_bonus=sum(amount)` равен доступному остатку минус внутренний дефицит после обработки сроков. Legacy `credited` сохранён для совместимости и включает opening.

Исходная сумма учтённых аренд — сумма `amount_kopecks` при `is_qualified=true`. Снижения/повышения — разность исходной и текущей суммы каждой аренды, а не валовая сумма всех промежуточных adjustments. `gross_rental_amount - rental_reductions + rental_increases = total_amount`.

Периодическая Bonus Redemption ниже разделяет обычные начисления и импорт старых остатков. Gross ratio не ограничивается 100%: клиенты могут тратить Bonus прежних периодов. Net выдаётся отдельно; при неположительном знаменателе — NULL. Сгорание и его компенсация не выдаются за новую награду.

```sql
WITH p AS (
  SELECT timestamptz '2026-09-01 00:00:00+03' AS from_at,
         timestamptz '2026-10-01 00:00:00+03' AS to_at
), classified AS (
  SELECT t.*, original.type AS original_type, original.reason AS original_reason
  FROM bonus_transactions t LEFT JOIN bonus_transactions original ON original.id=t.reverses_id
  CROSS JOIN p WHERE t.created_at>=p.from_at AND t.created_at<p.to_at
), totals AS (
  SELECT coalesce(sum(amount) FILTER (WHERE amount>0 AND type<>'reversal'
      AND NOT(type='manual_credit' AND reason='opening_balance')),0) AS gross_earned,
    coalesce(sum(amount) FILTER (WHERE type='manual_credit' AND reason='opening_balance'),0) AS opening,
    coalesce(-sum(amount) FILTER (WHERE type='rental_payment'),0) AS gross_redeemed,
    coalesce(sum(amount) FILTER (WHERE type='reversal' AND original_type='rental_payment'),0) AS redemption_refunds,
    coalesce(sum(amount) FILTER (WHERE type='reversal' AND original_type IN ('rental_cashback','referral_reward','manual_credit')
      AND NOT(original_type='manual_credit' AND original_reason='opening_balance')),0) AS earned_reversals,
    coalesce(sum(amount) FILTER (WHERE type='reversal' AND original_type='manual_credit' AND original_reason='opening_balance'),0) AS opening_reversals,
    coalesce(-sum(amount) FILTER (WHERE type='expiration'),0) AS expired,
    coalesce(sum(amount) FILTER (WHERE type='reversal' AND original_type='expiration'),0) AS expiration_compensations,
    coalesce(sum(amount) FILTER (WHERE type='reversal' AND amount>0),0) AS reversal_credits,
    coalesce(-sum(amount) FILTER (WHERE type='reversal' AND amount<0),0) AS reversal_debits,
    coalesce(sum(amount),0) AS net_posted
  FROM classified
)
SELECT *,100.0*gross_redeemed/nullif(gross_earned,0) AS gross_redemption_pct,
  CASE WHEN gross_earned+earned_reversals>0 THEN
    100.0*(gross_redeemed-redemption_refunds)/(gross_earned+earned_reversals) END AS net_redemption_pct
FROM totals;
```

## Участники, новые и эффективные уровни

Блокированные участники остаются в исторической базе, но выделяются статусом. Эффективный уровень — максимум трёх рангов. Эта выборка является текущим snapshot; она не реконструирует прошлый статус блокировки.

```sql
SELECT u.status,e.code AS effective_tier,count(*) AS members,
  count(*) FILTER (WHERE a.member_since>=now()-interval '30 days') AS new_30_days
FROM loyalty_accounts a JOIN users u ON u.id=a.user_id
JOIN loyalty_tiers c ON c.code=a.calculated_tier
JOIN loyalty_tiers h ON h.code=a.achieved_tier
LEFT JOIN loyalty_tiers m ON m.code=a.manual_override
JOIN loyalty_tiers e ON e.rank=greatest(c.rank,h.rank,coalesce(m.rank,0))
WHERE a.member_since IS NOT NULL GROUP BY u.status,e.code,e.rank ORDER BY e.rank,u.status;
```

## Activation Rate импортированной когорты

Когорта определяется датами создания batches и уникальными клиентами успешно связанных строк (`rental_id IS NOT NULL`). Повторные строки/файлы не увеличивают знаменатель. Ошибочные строки без идентифицированного клиента не входят в вычисление. Активация проверяется на фиксированный `as_of`. Самостоятельные регистрации без импортных строк считаются отдельно, ниже.

```sql
WITH p AS (
  SELECT timestamptz '2026-09-01 00:00:00+03' AS from_at,
         timestamptz '2026-10-01 00:00:00+03' AS to_at,
         now() AS as_of
), cohort AS (
  SELECT DISTINCT r.user_id FROM import_batches b JOIN import_rows ir ON ir.batch_id=b.id
  JOIN rentals r ON r.id=ir.rental_id CROSS JOIN p
  WHERE b.created_at>=p.from_at AND b.created_at<p.to_at
)
SELECT count(*) AS imported_clients,
  count(*) FILTER (WHERE a.member_since<=p.as_of) AS activated_clients,
  100.0*count(*) FILTER (WHERE a.member_since<=p.as_of)/nullif(count(*),0) AS activation_pct
FROM cohort c JOIN loyalty_accounts a ON a.user_id=c.user_id CROSS JOIN p;

SELECT count(*) AS activated_without_import
FROM loyalty_accounts a WHERE a.member_since IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM rentals r JOIN import_rows ir ON ir.rental_id=r.id WHERE r.user_id=a.user_id
);
```

## Repeat Rental Rate, окно 90 дней

Единица — клиент. Первая подходящая аренда определяется по всей доступной истории, не только внутри периода отчёта; затем выбирается когорта её даты. Только клиенты, для которых целиком завершились 90 дней наблюдения к `as_of`, входят в знаменатель. Отменённые аренды и нулевые текущие суммы исключены. Порядок — `qualified_at,id`; две разные аренды в одно время различаются id и могут дать повтор. Используется квалификация, поэтому позднее подтверждение оплаты влияет на дату. Даты неполной старой истории способны исказить первую аренду; перед бизнес-интерпретацией проверяется полнота импорта.

```sql
WITH p AS (
  SELECT timestamptz '2026-01-01 00:00:00+03' AS cohort_from,
         timestamptz '2026-04-01 00:00:00+03' AS cohort_to,
         now() AS as_of
), eligible AS (
  SELECT r.id,r.user_id,r.qualified_at FROM rentals r CROSS JOIN p
  WHERE r.is_qualified AND r.status='completed' AND r.payment_status='paid'
    AND r.current_amount_kopecks>0 AND r.qualified_at<=p.as_of
), first_rental AS (
  SELECT DISTINCT ON(user_id) user_id,id,qualified_at AS first_at
  FROM eligible ORDER BY user_id,qualified_at,id
), mature AS (
  SELECT f.* FROM first_rental f CROSS JOIN p
  WHERE f.first_at>=p.cohort_from AND f.first_at<p.cohort_to
    AND f.first_at+interval '90 days'<=p.as_of
), outcome AS (
  SELECT m.*,EXISTS(SELECT 1 FROM eligible r WHERE r.user_id=m.user_id
    AND (r.qualified_at,r.id)>(m.first_at,m.id)
    AND r.qualified_at<=m.first_at+interval '90 days') AS repeated
  FROM mature m
)
SELECT date_trunc('month',first_at AT TIME ZONE 'Europe/Moscow')::date AS cohort_month,
  count(*) AS mature_clients,count(*) FILTER(WHERE repeated) AS repeat_clients,
  100.0*count(*) FILTER(WHERE repeated)/nullif(count(*),0) AS repeat_90d_pct
FROM outcome GROUP BY 1 ORDER BY 1;
```

## RPM Drop Conversion

Здесь просмотр и последующий клик сопоставляются по тому же клиенту и Drop внутри периода. Повторные события одного клиента не раздувают числитель. Аналитика без user_id не участвует. Схема rentals пока не содержит подтверждённой CRM-связи offer_id, поэтому rental conversion возвращается как **«нет данных»**, без атрибуции по близости дат.

```sql
WITH p AS (
  SELECT timestamptz '2026-09-01 00:00:00+03' AS from_at,
         timestamptz '2026-10-01 00:00:00+03' AS to_at
), views AS (
  SELECT entity_id,user_id,min(created_at) AS first_view FROM analytics_events CROSS JOIN p
  WHERE name='offer_viewed' AND user_id IS NOT NULL AND entity_id IS NOT NULL
    AND created_at>=p.from_at AND created_at<p.to_at GROUP BY entity_id,user_id
), outcomes AS (
  SELECT v.*,EXISTS(SELECT 1 FROM analytics_events e CROSS JOIN p
    WHERE e.name='offer_clicked' AND e.entity_id=v.entity_id AND e.user_id=v.user_id
      AND e.created_at>=v.first_view AND e.created_at<p.to_at) AS clicked FROM views v
)
SELECT entity_id AS offer_id,count(*) AS unique_viewers,
  count(*) FILTER(WHERE clicked) AS unique_clickers,
  100.0*count(*) FILTER(WHERE clicked)/nullif(count(*),0) AS view_to_click_pct,
  'нет данных'::text AS rental_conversion FROM outcomes GROUP BY entity_id;
```

## Referral Conversion

Когорта — валидные сохранённые привязки по created_at. Последующая ineligible не удаляется из знаменателя: это исход ранее принятой привязки. Факт первой квалификации хранится в qualifying_rental_id и сохраняется при отмене. Rewarded, reversed и qualified/blocked_hold показываются раздельно; это текущие результаты выбранной когорты.

```sql
WITH cohort AS (
  SELECT * FROM referrals
  WHERE created_at>=timestamptz '2026-09-01 00:00:00+03'
    AND created_at<timestamptz '2026-10-01 00:00:00+03'
)
SELECT count(*) AS valid_bindings,
  count(*) FILTER(WHERE qualifying_rental_id IS NOT NULL) AS ever_qualified,
  count(*) FILTER(WHERE status='rewarded') AS rewarded,
  count(*) FILTER(WHERE status='reversed') AS reversed,
  count(*) FILTER(WHERE status='qualified' AND reason='blocked_hold') AS held,
  count(*) FILTER(WHERE status='ineligible') AS ineligible,
  100.0*count(*) FILTER(WHERE qualifying_rental_id IS NOT NULL)/nullif(count(*),0) AS qualification_pct
FROM cohort;
```
