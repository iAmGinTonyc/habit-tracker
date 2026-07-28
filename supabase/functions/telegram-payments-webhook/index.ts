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
}

interface TelegramUpdate {
  pre_checkout_query?: { id: string };
  message?: {
    successful_payment?: { invoice_payload: string; telegram_payment_charge_id: string };
  };
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

      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await admin.from('subscriptions').upsert({
        user_id: payload.user_id,
        plan: payload.plan,
        status: 'active',
        expires_at: expiresAt,
        family_size: payload.family_size,
        telegram_charge_id: chargeId,
        updated_at: new Date().toISOString(),
      });
      return ok();
    }

    return ok(); // необрабатываемый тип апдейта — игнорируем, но подтверждаем получение
  } catch (e) {
    console.error('telegram-payments-webhook error:', e);
    return ok(); // всё равно 200 — иначе Telegram будет бесконечно ретраить сломанный апдейт
  }
});
