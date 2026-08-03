// Edge Function: create-invoice
// Вызывается уже АВТОРИЗОВАННЫМ клиентом (Telegram-сессия из telegram-auth уже установлена) —
// собирает Stars-инвойс через Bot API createInvoiceLink и отдаёт ссылку клиенту, которую тот
// открывает через Telegram.WebApp.openInvoice(). См. HANDOFF.md §15.
//
// Секреты: TELEGRAM_BOT_TOKEN (тот же, что и у telegram-auth). SUPABASE_URL/SUPABASE_ANON_KEY
// подставляются платформой автоматически.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ЦЕНЫ В STARS — заданы юзером напрямую (не привязаны к рублям). Если меняешь — поправь ТАКЖЕ
// отображаемые цены в index.html (.sub-price) и auth.js (PRICE_PERSONAL_STARS/
// PRICE_FAMILY_PER_PERSON_STARS), иначе юзер увидит одну цифру, а спишется другая.
const PRICE_PERSONAL_STARS = 250;
const PRICE_FAMILY_PER_PERSON_STARS = 300;

// Скидка 50% за «идеальный» предыдущий календарный месяц — 5+ задач КАЖДЫЙ день, отмеченных
// день-в-день (см. db/phase7_trial_referral_discount.sql: record_today_completion() физически не
// даёт задним числом попасть в daily_completions, так что здесь просто читаем готовый леджер).
// Всегда по СОБСТВЕННОЙ записи покупателя, даже для Family — не по записям всей семьи.
const MIN_TASKS_PER_DAY = 5;
async function isDiscountEligible(sb: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const now = new Date();
  const prevMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const prevMonthStart = new Date(Date.UTC(prevMonthEnd.getUTCFullYear(), prevMonthEnd.getUTCMonth(), 1));
  const daysInPrevMonth = prevMonthEnd.getUTCDate();
  const { data, error } = await sb
    .from('daily_completions')
    .select('day, completed_count')
    .eq('user_id', userId)
    .gte('day', prevMonthStart.toISOString().slice(0, 10))
    .lte('day', prevMonthEnd.toISOString().slice(0, 10));
  if (error || !data) return false;
  if (data.length < daysInPrevMonth) return false; // хотя бы один день без записи вообще
  return data.every((row) => (row.completed_count ?? 0) >= MIN_TASKS_PER_DAY);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!BOT_TOKEN) return json({ error: 'server_misconfigured_no_bot_token' }, 500);

  try {
    // Кто спрашивает — берём из Authorization заголовка (уже проверен платформой на верхнем
    // уровне, verify_jwt по умолчанию включён для этой функции), а не из тела запроса.
    const authHeader = req.headers.get('Authorization') ?? '';
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'not_authenticated' }, 401);
    const userId = userData.user.id;

    const { plan, familySize } = await req.json();
    if (plan !== 'personal' && plan !== 'family') return json({ error: 'bad_plan' }, 400);

    const discountApplied = await isDiscountEligible(sb, userId);
    const discountMul = discountApplied ? 0.5 : 1;

    let stars: number;
    let title: string;
    let description: string;
    let size: number | null = null;

    if (plan === 'personal') {
      stars = Math.round(PRICE_PERSONAL_STARS * discountMul);
      title = 'LiveLife Personal';
      description = discountApplied ? 'Личный план — 1 месяц (скидка 50% за идеальный месяц)' : 'Личный план — 1 месяц';
    } else {
      size = Math.max(2, Math.min(10, Math.round(Number(familySize)) || 2));
      stars = Math.round(PRICE_FAMILY_PER_PERSON_STARS * size * discountMul);
      title = 'LiveLife Family';
      description = discountApplied
        ? `Семейный план на ${size} человек — 1 месяц (скидка 50% за идеальный месяц)`
        : `Семейный план на ${size} человек — 1 месяц`;
    }

    // payload вернётся нам же в successful_payment (см. telegram-payments-webhook) — кодируем,
    // кто и что купил, чтобы правильно обновить subscriptions после оплаты.
    const payload = JSON.stringify({ user_id: userId, plan, family_size: size, discount_applied: discountApplied });

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        payload,
        currency: 'XTR', // Stars — provider_token НЕ передаём вовсе (обязательное правило для XTR)
        prices: [{ label: title, amount: stars }], // для XTR — ровно один элемент
        subscription_period: 2592000, // ровно 30 дней — Telegram сам продлевает и списывает
      }),
    });
    const tgData = await tgRes.json();
    if (!tgData.ok) {
      await logError('create-invoice', 'telegram_api_error', { userId, detail: tgData.description });
      return json({ error: 'telegram_api_error', detail: tgData.description }, 502);
    }

    return json({ link: tgData.result, discountApplied });
  } catch (e) {
    await logError('create-invoice', 'unexpected', { detail: e });
    return json({ error: 'unexpected', detail: String(e) }, 500);
  }
});
