// Edge Function: telegram-payments-webhook
// Принимает вебхуки от Telegram Bot API: pre_checkout_query (подтвердить перед списанием) и
// message.successful_payment (списание прошло — активировать подписку). См. HANDOFF.md §15.
//
// ВАЖНО: эта функция вызывается САМИМ Telegram, не нашим клиентом — сессии/JWT у неё нет и быть
// не может. Деплоить с --no-verify-jwt. Вместо JWT — секретный токен, который Telegram присылает
// в заголовке X-Telegram-Bot-Api-Secret-Token (мы его сами задаём при регистрации вебхука через
// setWebhook, см. инструкцию в чате). Без этой проверки кто угодно мог бы дёрнуть эндпоинт и
// подделать «оплату» — TELEGRAM_WEBHOOK_SECRET обязателен.
//
// Секреты: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET. SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY —
// подставляются платформой автоматически.

import { createClient } from 'npm:@supabase/supabase-js@2';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function ok() {
  return new Response('ok', { status: 200 });
}

interface InvoicePayload {
  user_id: string;
  plan: 'personal' | 'family';
  family_size: number | null;
  discount_applied?: boolean;
}

interface TelegramUpdate {
  pre_checkout_query?: { id: string };
  message?: {
    successful_payment?: { invoice_payload: string; telegram_payment_charge_id: string };
  };
}

// Раздаёт активный доступ реальным членам семьи покупателя (принятые invites в любую сторону —
// та же симметричная связь, что и public.are_friends в db/phase3_family.sql). Не трогает тех, у
// кого уже есть СВОЙ активный план без family_owner_id (личная покупка) — не затираем её чужой
// семейной. Обратная синхронизация (отзыв при распаде семьи) — триггер на invites, см.
// db/phase9_family_access_sync.sql, здесь её дублировать не нужно.
// deno-lint-ignore no-explicit-any
async function grantFamilyAccess(admin: any, ownerId: string, expiresAt: string) {
  const { data: invites } = await admin
    .from('invites')
    .select('from_id, to_id')
    .eq('status', 'accepted')
    .or(`from_id.eq.${ownerId},to_id.eq.${ownerId}`);
  const inviteRows: { from_id: string; to_id: string }[] = invites || [];
  const memberIdSet = new Set<string>();
  for (const inv of inviteRows) {
    const other = inv.from_id === ownerId ? inv.to_id : inv.from_id;
    if (other !== ownerId) memberIdSet.add(other);
  }
  const memberIds = [...memberIdSet];
  if (!memberIds.length) return;

  const { data: existingRows } = await admin
    .from('subscriptions')
    .select('user_id, status, family_owner_id')
    .in('user_id', memberIds);
  const rows: { user_id: string; status: string; family_owner_id: string | null }[] = existingRows || [];
  const existingById: Record<string, { user_id: string; status: string; family_owner_id: string | null }> =
    Object.fromEntries(rows.map((r) => [r.user_id, r]));

  const now = new Date().toISOString();
  for (const memberId of memberIds) {
    const existing = existingById[memberId];
    if (existing && existing.status === 'active' && !existing.family_owner_id) continue; // своя активная подписка — не трогаем
    await admin.from('subscriptions').upsert({
      user_id: memberId,
      plan: 'family',
      status: 'active',
      expires_at: expiresAt,
      family_size: null, // размер покупки — только у владельца (payload.family_size выше)
      family_owner_id: ownerId,
      updated_at: now,
    });
  }
}

Deno.serve(async (req) => {
  // Проверка секрета — единственная защита эндпоинта без JWT
  const incomingSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!WEBHOOK_SECRET || incomingSecret !== WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch (_e) {
    return ok(); // мусор во входе — просто отвечаем 200, чтобы Telegram не долбил ретраями
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // 1) Предварительная проверка перед списанием — подтверждаем без вопросов, мы уже
    // зафиксировали цену/план на этапе create-invoice.
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: q.id, ok: true }),
      });
      return ok();
    }

    // 2) Оплата прошла — активируем/продлеваем подписку
    const payment = update.message?.successful_payment;
    if (payment) {
      const payload: InvoicePayload = JSON.parse(payment.invoice_payload);
      const chargeId: string = payment.telegram_payment_charge_id;

      const { data: existing } = await admin
        .from('subscriptions')
        .select('telegram_charge_id')
        .eq('user_id', payload.user_id)
        .maybeSingle();

      // Тот же charge уже обработан (повторная доставка вебхука Telegram) — не задваиваем.
      if (existing && existing.telegram_charge_id === chargeId) return ok();

      // discount_applied уже отражён в фактически списанной сумме Stars (см. create-invoice) —
      // здесь просто логируем для аудита, отдельно в subscriptions не храним.
      if (payload.discount_applied) console.log(`discount applied for user ${payload.user_id}, charge ${chargeId}`);

      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await admin.from('subscriptions').upsert({
        user_id: payload.user_id,
        plan: payload.plan,
        status: 'active',
        expires_at: expiresAt,
        family_size: payload.family_size,
        family_owner_id: null, // покупатель — всегда владелец своего плана, не чей-то член семьи
        telegram_charge_id: chargeId,
        updated_at: new Date().toISOString(),
      });

      // Family — доступ должны получить не только сам покупатель, но и его реальная семья
      // (принятые invites, см. db/phase3_family.sql). Раньше этого не было вовсе: family_owner_id
      // существовал в схеме (db/phase5_telegram.sql), но никто его не заполнял — члены семьи после
      // оплаты всё равно упирались в пейволл. См. db/phase9_family_access_sync.sql (и обратную
      // сторону — отзыв доступа при распаде семьи, там же триггером на invites).
      if (payload.plan === 'family') {
        await grantFamilyAccess(admin, payload.user_id, expiresAt);
      }
      return ok();
    }

    return ok(); // необрабатываемый тип апдейта — игнорируем, но подтверждаем получение
  } catch (e) {
    console.error('telegram-payments-webhook error:', e);
    return ok(); // всё равно 200 — иначе Telegram будет бесконечно ретраить сломанный апдейт
  }
});
