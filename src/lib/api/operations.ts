import { z } from "zod";
import { randomUUID } from "node:crypto";
import { offerCampaignBlockReason } from "@/lib/offers/availability";
import { saveMedia, loadMedia } from "@/lib/media";
import sharp from "sharp";
import { query, transaction } from "@/lib/db";
import { requireStaff, secretMatches, rateLimit } from "@/lib/auth/session";
import {
  body,
  formBody,
  HttpError,
  json,
  requireOrigin,
  operationKey,
  notFound,
} from "@/lib/http";
import {
  TIER_CODES,
  getProgram,
  processRental,
  adjustRental,
  cancelRental,
} from "@/lib/loyalty";
import {
  previewImport,
  getImport,
  commitImport,
  resolveCustomer,
} from "@/lib/imports/service";
import { normalizeRentalRow } from "@/lib/imports/parser";
import { normalizePhone } from "@/lib/auth/telegram";

const offerSchema = z.object({
  title: z.string().trim().min(1).max(140),
  subtitle: z.string().max(240).default(""),
  car_name: z.string().max(200).default(""),
  description: z.string().min(1).max(5000),
  image_url: z.string().max(1500).default(""),
  old_price: z.string().regex(/^\d+$/).nullable(),
  new_price: z.string().regex(/^\d+$/).nullable(),
  minimum_tier: z.enum(TIER_CODES),
  start_at: z.iso.datetime(),
  end_at: z.iso.datetime(),
  cta_text: z.string().min(1).max(60),
  cta_url: z.url(),
  active: z.boolean(),
  expected_version: z.number().int().optional(),
});
export async function operationsRoute(
  request: Request,
  key: string,
): Promise<Response | null> {
  if (key === "admin/program-preview" && request.method === "POST") {
    requireOrigin(request);
    await requireStaff(request, "admin");
    const input = await body(
      request,
      z.object({
        tiers: z
          .array(
            z.object({
              code: z.enum(TIER_CODES),
              thresholdKopecks: z.string().regex(/^\d{1,15}$/),
            }),
          )
          .min(5)
          .max(6),
      }),
    );
    if (
      input.tiers.some(
        (t, i) =>
          t.code !==
            TIER_CODES.filter((c) => input.tiers.some((t) => t.code === c))[
              i
            ] ||
          (i === 0 && t.thresholdKopecks !== "0") ||
          (i > 0 &&
            BigInt(t.thresholdKopecks) <=
              BigInt(input.tiers[i - 1].thresholdKopecks)),
      )
    )
      throw new HttpError(
        422,
        "INVALID_TIERS",
        "Пороги должны строго возрастать от MEMBER = 0",
      );
    const items = await query(
      `WITH projected AS (SELECT a.achieved_tier AS before_tier,(SELECT r->>'code' FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(r,n) WHERE a.total_rental_amount>=(r->>'thresholdKopecks')::bigint ORDER BY n DESC LIMIT 1) AS calculated FROM loyalty_accounts a),final AS (SELECT before_tier,CASE WHEN array_position($2::text[],calculated)>array_position($2::text[],before_tier) THEN calculated ELSE before_tier END AS after_tier FROM projected) SELECT before_tier,after_tier,count(*)::int count FROM final GROUP BY before_tier,after_tier ORDER BY before_tier,after_tier`,
      [JSON.stringify(input.tiers), TIER_CODES],
    );
    return json({
      items,
      upgrades: items
        .filter((r) => r.before_tier !== r.after_tier)
        .reduce((sum, r) => sum + Number(r.count), 0),
    });
  }
  const identity = key.match(/^admin\/customers\/([a-f0-9-]{36})\/identity$/);
  if (identity && request.method === "POST") {
    requireOrigin(request);
    const staff = await requireStaff(request, "admin");
    const input = await body(
      request,
      z.object({
        name: z.string().trim().min(1).max(200),
        phone: z.string().nullable(),
        telegramId: z
          .string()
          .regex(/^[1-9]\d{0,14}$/)
          .nullable(),
        expectedVersion: z.string().regex(/^\d+$/),
        reason: z.string().trim().min(10).max(1000),
        identityVerified: z.literal(true),
      }),
    );
    const phone = input.phone ? normalizePhone(input.phone) : null;
    await transaction(async (tx) => {
      const [before] = await tx.query(
        "SELECT u.*,a.account_version FROM users u JOIN loyalty_accounts a ON a.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,a",
        [identity[1]],
      );
      if (!before) return notFound();
      if (before.account_version !== input.expectedVersion)
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "Карточка изменилась. Откройте форму заново.",
        );
      if (before.telegram_id !== input.telegramId) {
        // Staff grants also lock this user. Checking after the user lock keeps
        // a concurrent grant from bypassing this boundary, without taking a
        // membership lock in the reverse order used by staff authentication.
        const [membership] = await tx.query(
          "SELECT id FROM admin_memberships WHERE telegram_user_id=$1",
          [identity[1]],
        );
        if (membership)
          throw new HttpError(
            409,
            "STAFF_IDENTITY_LOCKED",
            "Telegram сотрудника нельзя изменить в карточке клиента. Обратитесь к владельцу клуба.",
          );
      }
      const conflicts = await tx.query(
        "SELECT id FROM users WHERE id<>$1 AND (phone=$2 OR telegram_id=$3)",
        [identity[1], phone, input.telegramId],
      );
      if (conflicts.length)
        throw new HttpError(
          409,
          "IDENTITY_CONFLICT",
          "Номер или Telegram уже связан с другим профилем",
        );
      const [after] = await tx.query(
        "UPDATE users SET name=$2,phone=$3,telegram_id=$4,telegram_username=CASE WHEN telegram_id IS DISTINCT FROM $4::bigint THEN NULL ELSE telegram_username END,telegram_reachable=CASE WHEN telegram_id IS DISTINCT FROM $4::bigint THEN false ELSE telegram_reachable END,updated_at=now() WHERE id=$1 RETURNING *",
        [identity[1], input.name, phone, input.telegramId],
      );
      await tx.query(
        "UPDATE miniapp_sessions SET revoked_at=now() WHERE user_id=$1",
        [identity[1]],
      );
      const [account] = await tx.query<{ account_version: string }>(
        "UPDATE loyalty_accounts SET account_version=account_version+1 WHERE user_id=$1 RETURNING account_version",
        [identity[1]],
      );
      await tx.query(
        `INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,'admin','member.identity','user',$2,$3,$4,$5)`,
        [
          staff.id,
          identity[1],
          input.reason,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
      await tx.query(
        `INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,account_version,payload) VALUES($1,'MEMBER_DATA_CHANGED',$2::uuid,$2::text,$3,'{}')`,
        [
          "identity:" + identity[1] + ":" + account.account_version,
          identity[1],
          account.account_version,
        ],
      );
    });
    return json({ ok: true });
  }
  if (key === "admin/imports" && request.method === "GET") {
    await requireStaff(request);
    return json({
      items: await query(
        "SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 50",
      ),
    });
  }
  if (key === "admin/imports" && request.method === "POST") {
    requireOrigin(request);
    const staff = await requireStaff(request, "manager");
    await rateLimit("import:" + staff.id, 5);
    if (Number(request.headers.get("content-length") ?? 0) > 11 * 1024 * 1024)
      throw new HttpError(
        413,
        "FILE_SIZE",
        "Максимальный размер файла — 10 МБ",
      );
    const form = await formBody(request, 11 * 1024 * 1024),
      file = form.get("file");
    if (!(file instanceof File))
      throw new HttpError(422, "FILE_REQUIRED", "Выберите файл");
    const mode = z
      .enum(["historical", "operational"])
      .parse(form.get("mode") ?? "operational");
    return json(
      await previewImport(
        Buffer.from(await file.arrayBuffer()),
        file.name,
        mode,
        {
          delimiter: form.get("delimiter") === ";" ? ";" : ",",
          legacyCompletedPaid: form.get("legacyCompletedPaid") === "true",
        },
        { id: staff.id, role: staff.role as "manager" | "admin" },
      ),
      201,
    );
  }
  const batch = key.match(
    /^admin\/imports\/([a-f0-9-]{36})(?:\/(commit|errors))?$/,
  );
  if (batch) {
    const staff = await requireStaff(
      request,
      batch[2] === "commit" ? "manager" : "viewer",
    );
    if (request.method === "GET" && batch[2] === "errors") {
      const rows = await query<{ row_number: number; errors: string[] }>(
        "SELECT row_number,errors FROM import_rows WHERE batch_id=$1 AND status IN ('invalid','error') ORDER BY row_number",
        [batch[1]],
      );
      const escape = (s: string) =>
        '"' +
        (/^[=+@\-\t\r]/.test(s) ? "'" : "") +
        s.replaceAll('"', '""') +
        '"';
      return new Response(
        "\uFEFFСтрока;Ошибка\r\n" +
          rows
            .map((r) => `${r.row_number};${escape(r.errors.join("; "))}`)
            .join("\r\n"),
        {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="import-errors.csv"',
            "Cache-Control": "no-store",
          },
        },
      );
    }
    if (request.method === "GET") return json(await getImport(batch[1]));
    if (request.method === "POST" && batch[2] === "commit") {
      requireOrigin(request);
      return json(
        await commitImport(batch[1], {
          id: staff.id,
          role: staff.role as "manager" | "admin",
        }),
      );
    }
  }
  if (key === "admin/offers" && request.method === "GET") {
    await requireStaff(request);
    return json({
      items: await query(
        "SELECT * FROM offers ORDER BY created_at DESC LIMIT 100",
      ),
    });
  }
  const offer = key.match(/^admin\/offers(?:\/([a-f0-9-]{36}))?$/);
  if (offer && ["POST", "PATCH"].includes(request.method)) {
    requireOrigin(request);
    const staff = await requireStaff(request, "manager");
    const input = await body(request, offerSchema);
    const program = await getProgram();
    if (!program.tiers.some((tier) => tier.code === input.minimum_tier))
      throw new HttpError(
        422,
        "TIER_UNPUBLISHED",
        "Уровень ещё не опубликован в программе клуба",
      );
    if (input.start_at >= input.end_at)
      throw new HttpError(
        422,
        "OFFER_PERIOD",
        "Дата окончания должна быть позже начала",
      );
    if (
      (input.old_price === null) !== (input.new_price === null) ||
      (input.old_price &&
        input.new_price &&
        BigInt(input.new_price) > BigInt(input.old_price))
    )
      throw new HttpError(422, "OFFER_PRICE", "Проверьте старую и новую цену");
    const target = new URL(input.cta_url);
    if (
      target.protocol !== "https:" ||
      !(
        target.origin ===
          new URL(process.env.APP_URL ?? "https://rpmrent.ru").origin ||
        target.hostname === "rpmrent.ru" ||
        target.hostname.endsWith(".rpmrent.ru") ||
        target.hostname === "t.me"
      )
    )
      throw new HttpError(
        422,
        "OFFER_URL",
        "Используйте HTTPS-ссылку RPM или Telegram",
      );
    if (
      input.image_url &&
      !/^\/api\/media\/[a-f0-9-]+\.webp$|^\/images\/[a-z0-9-]+\.png$/.test(
        input.image_url,
      )
    ) {
      throw new HttpError(
        422,
        "IMAGE_URL",
        "Загрузите изображение через редактор",
      );
    }
    const id = offer[1] ?? randomUUID();
    await transaction(async (tx) => {
      const [before] = await tx.query(
        "SELECT * FROM offers WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (offer[1] && (!before || before.version !== input.expected_version))
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "Предложение изменено. Обновите страницу.",
        );
      const values = [
        id,
        input.title,
        input.subtitle,
        input.car_name,
        input.image_url,
        input.description,
        input.old_price,
        input.new_price,
        input.minimum_tier,
        input.start_at,
        input.end_at,
        input.cta_text,
        input.cta_url,
        input.active,
        staff.id,
      ];
      const [after] = await tx.query(
        `INSERT INTO offers(id,title,subtitle,car_name,image_url,description,old_price,new_price,minimum_tier,start_at,end_at,cta_text,cta_url,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO UPDATE SET title=$2,subtitle=$3,car_name=$4,image_url=$5,description=$6,old_price=$7,new_price=$8,minimum_tier=$9,start_at=$10,end_at=$11,cta_text=$12,cta_url=$13,active=$14,version=offers.version+1,updated_at=now() RETURNING *`,
        values,
      );
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data) VALUES($1,$2,'offer.save','offer',$3,'Редактирование предложения',$4,$5)",
        [
          staff.id,
          staff.role,
          id,
          JSON.stringify(before ?? null),
          JSON.stringify(after),
        ],
      );
    });
    return json({ id });
  }
  const campaign = key.match(/^admin\/offers\/([a-f0-9-]{36})\/campaigns$/);
  if (campaign) {
    const staff = await requireStaff(request, "manager");
    const [offer] = await query<{
      id: string;
      version: number;
      minimum_tier: (typeof TIER_CODES)[number];
      active: boolean;
      start_at: Date;
      end_at: Date;
    }>("SELECT * FROM offers WHERE id=$1", [campaign[1]]);
    if (!offer) return notFound();
    const allowed = TIER_CODES.slice(TIER_CODES.indexOf(offer.minimum_tier));
    const audience = await query<{ id: string }>(
      `SELECT u.id FROM users u JOIN loyalty_accounts a ON a.user_id=u.id WHERE u.status='active' AND u.marketing_consent AND u.telegram_reachable AND u.telegram_id IS NOT NULL AND a.achieved_tier=ANY($1::text[])`,
      [allowed],
    );
    const blockedReason = offerCampaignBlockReason(offer);
    if (request.method === "GET")
      return json({
        recipients: audience.length,
        offer_version: offer.version,
        available: !blockedReason,
        blocked_reason: blockedReason,
      });
    if (request.method === "POST") {
      requireOrigin(request);
      const { expectedVersion } = await body(
        request,
        z.object({ expectedVersion: z.number().int() }),
      );
      if (blockedReason)
        throw new HttpError(409, "OFFER_INACTIVE", blockedReason);
      if (expectedVersion !== offer.version)
        throw new HttpError(409, "VERSION_CONFLICT", "Предложение изменилось");
      const result = await transaction(async (tx) => {
        const [locked] = await tx.query<{
          version: number;
          active: boolean;
          start_at: Date;
          end_at: Date;
          minimum_tier: (typeof TIER_CODES)[number];
        }>("SELECT * FROM offers WHERE id=$1 FOR UPDATE", [offer.id]);
        if (!locked || locked.version !== expectedVersion)
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "Предложение изменилось. Проверьте аудиторию заново.",
          );
        const lockedReason = offerCampaignBlockReason(locked);
        if (lockedReason)
          throw new HttpError(409, "OFFER_INACTIVE", lockedReason);
        const audience = await tx.query<{ id: string }>(
          `SELECT u.id FROM users u JOIN loyalty_accounts a ON a.user_id=u.id WHERE u.status='active' AND u.marketing_consent AND u.telegram_reachable AND u.telegram_id IS NOT NULL AND a.achieved_tier=ANY($1::text[])`,
          [TIER_CODES.slice(TIER_CODES.indexOf(locked.minimum_tier))],
        );
        const [c] = await tx.query<{ id: string }>(
          "INSERT INTO offer_campaigns(offer_id,offer_version,audience,requested_by) VALUES($1,$2,$3,$4) ON CONFLICT(offer_id,offer_version) DO NOTHING RETURNING id",
          [
            offer.id,
            offer.version,
            JSON.stringify(audience.map((a) => a.id)),
            staff.id,
          ],
        );
        if (!c)
          throw new HttpError(
            409,
            "CAMPAIGN_EXISTS",
            "Эта версия предложения уже отправлена",
          );
        for (const u of audience)
          await tx.query(
            "INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,payload) VALUES($1,'RPM_DROP',$2,$3,$4)",
            [
              `campaign:${c.id}:${u.id}`,
              u.id,
              offer.id,
              JSON.stringify({
                offer_id: offer.id,
                offer_version: locked.version,
                campaign_id: c.id,
              }),
            ],
          );
        await tx.query(
          "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,$2,'offer.campaign','offer',$3,'Отправка участникам',$4)",
          [
            staff.id,
            staff.role,
            offer.id,
            JSON.stringify({ recipients: audience.length, campaign_id: c.id }),
          ],
        );
        return { campaignId: c.id, recipients: audience.length };
      });
      return json(result, 202);
    }
  }
  if (key === "admin/media" && request.method === "POST") {
    requireOrigin(request);
    await requireStaff(request, "manager");
    if (Number(request.headers.get("content-length") ?? 0) > 6 * 1024 * 1024)
      throw new HttpError(413, "IMAGE_SIZE", "Максимум 5 МБ");
    const form = await formBody(request, 11 * 1024 * 1024);
    const file = form.get("file");
    if (!(file instanceof File) || file.size > 5 * 1024 * 1024)
      throw new HttpError(
        422,
        "IMAGE_REQUIRED",
        "Выберите JPEG, PNG или WebP до 5 МБ",
      );
    const buffer = Buffer.from(await file.arrayBuffer());
    let output: Buffer;
    try {
      const image = sharp(buffer, { limitInputPixels: 25000000 });
      const metadata = await image.metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format ?? ""))
        throw new HttpError(
          422,
          "IMAGE_TYPE",
          "Поддерживаются JPEG, PNG и WebP",
        );
      output = await image
        .resize(1600, 1000, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        422,
        "IMAGE_INVALID",
        "Не удалось прочитать изображение. Выберите исправный JPEG, PNG или WebP размером до 25 мегапикселей.",
      );
    }
    const name = randomUUID() + ".webp";
    await saveMedia(name, output);
    return json({ url: "/api/media/" + name });
  }
  if (/^media\/[a-f0-9-]{36}\.webp$/.test(key) && request.method === "GET") {
    const data = await loadMedia(key.slice("media/".length));
    if (!data) return notFound();
    return new Response(data, {
      headers: {
        "Content-Type": "image/webp",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }
  if (key.startsWith("integrations/rentals") && request.method === "POST") {
    if (
      !secretMatches(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null,
        process.env.INTEGRATION_API_KEY,
      )
    )
      throw new HttpError(
        401,
        "INTEGRATION_UNAUTHORIZED",
        "Неверный ключ интеграции",
      );
    await rateLimit("integration:rentals", 300);
    const actor = { id: "integration:rpm", role: "integration" as const };
    const idempotencyKey = operationKey(request);
    if (key === "integrations/rentals") {
      const input = await body(request, z.record(z.string(), z.unknown()));
      const row = normalizeRentalRow(input);
      const userId = await resolveCustomer(row, "rpm");
      const result = await processRental(
        { ...row, userId, source: "rpm", idempotencyKey },
        actor,
      );
      return json(result, result.status === "duplicate" ? 200 : 201);
    }
    const action = key.match(
      /^integrations\/rentals\/([^/]+)\/(adjust|cancel)$/,
    );
    if (action) {
      const [rental] = await query<{ id: string }>(
        "SELECT id FROM rentals WHERE external_rental_id=$1 AND source='rpm'",
        [decodeURIComponent(action[1])],
      );
      if (!rental) return notFound();
      const data = await body(
        request,
        z.object({
          reason: z.string().min(3).max(1000),
          amountKopecks: z.string().regex(/^\d+$/).optional(),
        }),
      );
      const common = {
        rentalId: rental.id,
        reason: data.reason,
        idempotencyKey,
      };
      if (action[2] === "cancel")
        return json(await cancelRental(common, actor));
      if (!data.amountKopecks)
        throw new HttpError(422, "AMOUNT_REQUIRED", "Укажите сумму");
      return json(
        await adjustRental(
          { ...common, amountKopecks: data.amountKopecks },
          actor,
        ),
      );
    }
  }
  if (key === "admin/legal" && request.method === "GET") {
    await requireStaff(request, "admin");
    return json({
      items: await query(
        "SELECT * FROM legal_documents ORDER BY published_at DESC",
      ),
    });
  }
  if (key === "admin/legal" && request.method === "POST") {
    requireOrigin(request);
    const staff = await requireStaff(request, "admin");
    const input = await body(
      request,
      z.object({
        type: z.enum(["rules", "privacy", "personal-data"]),
        version: z.string().min(1).max(30),
        title: z.string().min(1).max(200),
        text: z.string().min(20).max(50000),
      }),
    );
    await transaction(async (tx) => {
      const [doc] = await tx.query(
        "INSERT INTO legal_documents(type,version,title,body) VALUES($1,$2,$3,$4) RETURNING id",
        [input.type, input.version, input.title, input.text],
      );
      await tx.query(
        "INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data) VALUES($1,$2,'legal.publish','legal',$3,'Публикация редакции',$4)",
        [staff.id, staff.role, String(doc.id), JSON.stringify(input)],
      );
    });
    return json({ ok: true });
  }
  return null;
}
