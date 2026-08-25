// Edge Function: send-summary-now
// Сводка «Итоги дня» ПО ЗАПРОСУ — юзер попросил «а еще сделай возможность получать эти сводки по
// запросу». Дёргается кнопкой «Прислать сводку сейчас» из профиля (см. requestSummaryNow в
// auth.js). Текст собирается ТЕМ ЖЕ buildSummaryText, что и ночная рассылка — он ради этого и
// вынесен в ../_shared/summaryText.ts, чтобы два формата отчёта не разъехались.
//
// Почему ОТДЕЛЬНАЯ функция, а не второй режим внутри send-daily-summary: та деплоится с
// --no-verify-jwt и защищена ТОЛЬКО секретным заголовком X-Cron-Secret. Чтобы дать к ней доступ
// клиенту, пришлось бы либо отдать этот секрет во фронтенд (тогда рассылку сможет дёргать кто
// угодно), либо проверять JWT руками внутри функции, у которой платформенная проверка выключена —
// одна ошибка в ветвлении, и открыт cron-путь. Отдельная функция с ВКЛЮЧЁННЫМ verify_jwt (как
// notify-mood-alert и create-invoice) разделяет эти два входа физически.
//
// Секреты: TELEGRAM_BOT_TOKEN (тот же, что у остальных функций). SUPABASE_URL/SUPABASE_ANON_KEY/
// SUPABASE_SERVICE_ROLE_KEY — платформа подставляет сама. Деплоить БЕЗ --no-verify-jwt.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';
import { buildSummaryText, formatFullDate } from '../_shared/summaryText.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!BOT_TOKEN) return json({ error: 'no_bot_token' }, 500);

  try {
    // Кто просит — строго из Authorization (verify_jwt включён платформой), а не из тела запроса:
    // иначе любой мог бы заказать сводку на чужой telegram_id. Тело мы НЕ читаем вовсе —
    // sb.functions.invoke без body шлёт пустой запрос, и req.json() на нём бросил бы исключение.
    const authHeader = req.headers.get('Authorization') ?? '';
    const sbUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await sbUser.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'not_authenticated' }, 401);
    const userId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Одним вызовом: проверить, что есть telegram_id/timezone, АТОМАРНО занять слот антиспама
    // (не чаще раза в минуту, таблица summary_ondemand_log) и получить дату отчёта по тому же
    // правилу, что у ночной рассылки — см. db/phase20_summary_time.sql. Слот занимается ДО
    // отправки: лучше «не пришло, нажми ещё раз через минуту», чем спам в чат при ретраях.
    const { data: claimRows, error: claimErr } = await admin.rpc('claim_summary_ondemand', { p_user: userId });
    if (claimErr) {
      await logError('send-summary-now', 'claim_summary_ondemand_failed', { userId, detail: claimErr.message });
      return json({ error: 'unexpected', detail: claimErr.message }, 500);
    }
    // RPC объявлена как returns table(...) — supabase-js отдаёт её массивом строк.
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    // Отказы вроде too_often/no_telegram — не сбой сервера, а нормальный ответ: отдаём 200 с полем
    // error, чтобы клиенту не пришлось выковыривать тело из error.context (см. readFunctionErrorBody
    // в auth.js — там этот костыль уже есть для non-2xx, и плодить его лишний раз незачем).
    if (!claim || !claim.ok) return json({ error: (claim && claim.reason) || 'unexpected' });
    const reportDate: string = claim.report_date;

    const { data: stateRow } = await admin.from('app_state').select('data').eq('user_id', userId).maybeSingle();
    // Отличие от ночной рассылки ровно одно: там пустой отчёт просто не шлётся (юзер ничего не
    // просил), а тут он НАЖАЛ кнопку и обязан получить ответ — молчание выглядело бы как «кнопка
    // сломана». Поэтому на пустой день шлём короткую заглушку с той же датой в заголовке.
    const text = (stateRow && stateRow.data ? buildSummaryText(stateRow.data, reportDate) : null)
      ?? `<b>Итоги дня, ${formatFullDate(reportDate)}:</b>\n\nПока ничего не отмечено — самое время открыть трекер.`;

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: claim.telegram_id,
        text,
        parse_mode: 'HTML', // заголовки блоков жирным — как и у ночной сводки, см. escHtml там
        reply_markup: { inline_keyboard: [[{ text: 'Открыть Live Life', web_app: { url: MINI_APP_URL } }]] },
      }),
    });
    const tgData = await res.json();
    if (!tgData.ok) {
      // Самая частая причина — юзер заблокировал бота. Это рутина, не сбой: в error_log не пишем
      // (иначе журнал захлебнётся), но клиенту причину вернуть надо — он ждёт ответа на нажатие.
      console.warn('sendMessage failed for', userId, tgData.description);
      return json({ error: 'telegram_send_failed', detail: tgData.description });
    }
    return json({ sent: 1, report_date: reportDate });
  } catch (e) {
    await logError('send-summary-now', 'unexpected', { detail: e });
    return json({ error: 'unexpected', detail: String(e) }, 500);
  }
});
