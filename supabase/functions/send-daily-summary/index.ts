// Edge Function: send-daily-summary
// Дёргается ОТДЕЛЬНЫМ pg_cron (каждые 15 минут, как и send-daily-reminders — см. db/phase12_…sql)
// в конце локального дня юзера (22:45–22:59, см. get_and_mark_due_summaries) и присылает в бота
// сводку «что сегодня трогал»: привычки, метрики Pro mode, чек-ап, питание, событие дня. Источник
// данных — синхронизированный app_state (db/phase11_app_state_sync.sql); без этой синхронизации
// сервер вообще не видел бы прогресс юзера (раньше он жил только в localStorage браузера).
//
// Секреты: TELEGRAM_BOT_TOKEN (тот же, что у остальных функций), TELEGRAM_SUMMARY_CRON_SECRET
// (свой, отдельный от TELEGRAM_REMINDER_CRON_SECRET — на случай, если понадобится включать/выключать
// сводку независимо от обычных напоминаний). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — платформа
// подставляет сама. Деплоить с --no-verify-jwt (вызывает не юзер, а сама база).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CRON_SECRET = Deno.env.get('TELEGRAM_SUMMARY_CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';

interface DueRow {
  user_id: string;
  telegram_id: number;
  timezone: string;
}

// deno-lint-ignore no-explicit-any
type AnyState = Record<string, any>;

// Сегодняшний ключ ('YYYY-MM-DD') в ЛОКАЛЬНОМ дне юзера — тот же формат, что и todayKey()/fdt() в
// habbittracker.js, иначе не совпадёт с ключами внутри самого app_state.data.
function localDateKey(timeZone: string): string {
  // en-CA форматирует даты как YYYY-MM-DD "из коробки" — не нужно вручную собирать строку.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

// Собирает читаемый текст сводки из СЕГОДНЯШНЕГО среза dashState. Возвращает null, если сегодня
// вообще ничего не трогал — пустой отчёт слать не имеет смысла (см. вызов ниже).
function buildSummaryText(state: AnyState, todayKey: string): string | null {
  const sections: string[] = [];

  // Привычки, отмеченные сегодня (dashState.history[date][uid] = true)
  const historyToday = (state.history || {})[todayKey] || {};
  const habitLines = (state.habits || [])
    .filter((h: AnyState) => historyToday[h.uid])
    .map((h: AnyState) => `✅ ${h.text}`);
  if (habitLines.length) sections.push('Привычки:\n' + habitLines.join('\n'));

  // Числовые метрики Pro mode (dashState.metricLog[date][metricId] = число)
  const metricLogToday = (state.metricLog || {})[todayKey] || {};
  const metricLines = (state.metrics || [])
    .map((m: AnyState) => {
      const v = metricLogToday[m.id];
      if (v === undefined || v === null || v === '' || v === 0) return null;
      return `${m.name}: ${v}${m.unit ? ' ' + m.unit : ''}`;
    })
    .filter(Boolean);
  if (metricLines.length) sections.push('Показатели:\n' + metricLines.join('\n'));

  // Чек-ап дня (dashState.checkinHistory[date].morning)
  const morning = ((state.checkinHistory || {})[todayKey] || {}).morning;
  if (morning) {
    const parts: string[] = [];
    if (morning.sleepTime) parts.push(`лёг в ${morning.sleepTime}`);
    if (morning.wakeTime) parts.push(`встал в ${morning.wakeTime}`);
    if (morning.extraSleepHours) parts.push(`+${morning.extraSleepHours} ч сна урывками`);
    if (morning.mood) parts.push(`настроение ${morning.mood}/10`);
    if (morning.sleepQuality) parts.push(`сон ${morning.sleepQuality}/10`);
    if (morning.energy) parts.push(`энергия ${morning.energy}/10`);
    if (morning.health) parts.push(`здоровье ${morning.health}/10`);
    if (parts.length) sections.push('Чек-ап: ' + parts.join(', '));
  }

  // Питание (dashState.foodLog[date].{breakfast,lunch,dinner})
  const foodToday = (state.foodLog || {})[todayKey] || {};
  const mealNames: Record<string, string> = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин' };
  const foodLines = Object.keys(mealNames)
    .map((id) => {
      const rec = foodToday[id];
      if (!rec || (!rec.time && !rec.text)) return null;
      return `${mealNames[id]}${rec.time ? ` (${rec.time})` : ''}${rec.text ? `: ${rec.text}` : ''}`;
    })
    .filter(Boolean);
  if (foodLines.length) sections.push('Питание:\n' + foodLines.join('\n'));

  // Событие дня (dashState.dayEvents[date])
  const dayEvent = (state.dayEvents || {})[todayKey];
  if (dayEvent) sections.push(`Событие дня: ${dayEvent}`);

  if (!sections.length) return null;
  return 'Итоги дня:\n\n' + sections.join('\n\n');
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

        const todayKey = localDateKey(row.timezone);
        const text = buildSummaryText(stateRow.data, todayKey);
        if (!text) continue; // сегодня ничего не трогал — пустой отчёт не шлём

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: row.telegram_id,
            text,
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
