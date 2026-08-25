// Edge Function: send-daily-summary
// Дёргается ОТДЕЛЬНЫМ pg_cron (каждые 15 минут, как и send-daily-reminders — см. db/phase12_…sql)
// в ЛИЧНОЕ время каждого юзера (profiles.summary_time, по умолчанию 22:45 — Фаза 20,
// db/phase20_summary_time.sql; раньше окно 22:45–22:59 было зашито в SQL сразу для всех) и
// присылает в бота сводку «что сегодня трогал»: привычки, метрики Pro mode, чек-ап, питание,
// событие дня. Источник данных — синхронизированный app_state (db/phase11_app_state_sync.sql);
// без этой синхронизации сервер вообще не видел бы прогресс юзера (раньше он жил только в
// localStorage браузера).
//
// ВАЖНО: за какой именно день отчёт, функция САМА НЕ СЧИТАЕТ — дату отдаёт RPC полем report_date
// (у «совы» с временем 04:00 это ВЧЕРАШНЯЯ дата, см. summary_report_date в Фазе 20). Не пытайся
// вернуть сюда localDateKey(): в 04:00 он дал бы только что начавшийся пустой день.
//
// Секреты: TELEGRAM_BOT_TOKEN (тот же, что у остальных функций), TELEGRAM_SUMMARY_CRON_SECRET
// (свой, отдельный от TELEGRAM_REMINDER_CRON_SECRET — на случай, если понадобится включать/выключать
// сводку независимо от обычных напоминаний). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — платформа
// подставляет сама. Деплоить с --no-verify-jwt (вызывает не юзер, а сама база).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';
// Сам текст сводки собирает общий модуль — тот же, что у сводки по запросу (send-summary-now),
// чтобы два формата отчёта не разъехались (Фаза 20).
import { buildSummaryText } from '../_shared/summaryText.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CRON_SECRET = Deno.env.get('TELEGRAM_SUMMARY_CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';

interface DueRow {
  user_id: string;
  telegram_id: number;
  timezone: string;
  // Дату отчёта считает SQL (summary_report_date, db/phase20_summary_time.sql), а не эта функция —
  // у «совы» с summary_time 04:00 тут будет ВЧЕРАШНЯЯ локальная дата. timezone оставлен только
  // для диагностики в логах.
  report_date: string;
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('X-Cron-Secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: 'no_bot_token' }), { status: 500 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    const { data, error } = await admin.rpc('get_and_mark_due_summaries');
    if (error) {
      await logError('send-daily-summary', 'get_and_mark_due_summaries_failed', { detail: error.message });
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    const due: DueRow[] = data || [];
    let sent = 0;
    for (const row of due) {
      try {
        const { data: stateRow } = await admin.from('app_state').select('data').eq('user_id', row.user_id).maybeSingle();
        if (!stateRow || !stateRow.data) continue; // ещё ни разу не синкал прогресс — нечего показывать

        // Дату берём из RPC (report_date), а не из локального времени — иначе сводка «совы» в
        // 04:00 читала бы ключи только что начавшегося дня и всегда была бы пустой.
        const text = buildSummaryText(stateRow.data, row.report_date);
        if (!text) continue; // в этот день ничего не трогал — пустой отчёт не шлём

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: row.telegram_id,
            text,
            parse_mode: 'HTML', // заголовки блоков жирным + эмодзи (см. buildSummaryText/escHtml)
            reply_markup: {
              inline_keyboard: [[{ text: 'Открыть Live Life', web_app: { url: MINI_APP_URL } }]],
            },
          }),
        });
        const tgData = await res.json();
        if (tgData.ok) sent++;
        else console.warn('sendMessage failed for', row.user_id, tgData.description); // рутина (юзер заблокировал бота и т.п.) — не в error_log
      } catch (e) {
        console.error('summary failed for', row.user_id, e);
      }
    }
    return new Response(JSON.stringify({ due: due.length, sent }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    await logError('send-daily-summary', 'unexpected', { detail: e });
    return new Response(JSON.stringify({ error: 'unexpected', detail: String(e) }), { status: 500 });
  }
});
