// Edge Function: send-habit-reminders
// Дёргается ОТДЕЛЬНЫМ pg_cron КАЖДУЮ МИНУТУ (не раз в 15 минут, как send-daily-reminders/
// send-daily-summary — время у привычки задано с точностью до минуты, см. setting-time-input в
// habbittracker.js). Раньше напоминание по привычке проверялось ТОЛЬКО клиентским setInterval
// (checkReminders в habbittracker.js) — если Mini App не открыт, юзер ничего не получал. Теперь
// читает синхронизированный app_state (db/phase11_app_state_sync.sql) и шлёт настоящий пуш.
//
// Секреты: TELEGRAM_BOT_TOKEN, TELEGRAM_HABIT_REMINDER_CRON_SECRET. SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY — платформа сама. Деплоить с --no-verify-jwt.
//
// Масштаб: на каждый тик читает app_state ПО ОДНОМУ юзеру за раз (без единого SQL-запроса на всех
// сразу) — при считанных десятках юзеров это не проблема, при заметном росте аудитории стоит
// переписать на один SQL-запрос с jsonb_array_elements (см. обсуждение в чате про масштаб рассылок).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CRON_SECRET = Deno.env.get('TELEGRAM_HABIT_REMINDER_CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';

interface ProfileRow {
  id: string;
  telegram_id: number;
  timezone: string;
}
interface Habit {
  uid: string;
  text: string;
  reminderTime?: string | null;
}
// deno-lint-ignore no-explicit-any
type AnyState = Record<string, any>;

function localHHMM(timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}
// en-CA форматирует как YYYY-MM-DD — тот же формат ключей, что и fdt()/todayKey() в habbittracker.js.
function localDateKey(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('X-Cron-Secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: 'no_bot_token' }), { status: 500 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    const { data: profiles, error } = await admin
      .from('profiles')
      .select('id, telegram_id, timezone')
      .not('telegram_id', 'is', null)
      .not('timezone', 'is', null);
    if (error) {
      await logError('send-habit-reminders', 'profiles_query_failed', { detail: error.message });
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    const rows: ProfileRow[] = profiles || [];
    let sent = 0;
    for (const row of rows) {
      try {
        const nowHHMM = localHHMM(row.timezone);
        const { data: stateRow } = await admin.from('app_state').select('data').eq('user_id', row.id).maybeSingle();
        const state: AnyState | undefined = stateRow?.data;
        if (!state || !Array.isArray(state.habits)) continue;

        const todayKey = localDateKey(row.timezone);
        const doneToday = (state.history || {})[todayKey] || {};

        for (const habit of state.habits as Habit[]) {
          if (!habit.reminderTime || habit.reminderTime !== nowHHMM) continue;
          if (doneToday[habit.uid]) continue; // уже отмечена сегодня — не дёргаем зря

          // Дедуп: если этот хабит уже получил пуш сегодня (напр., cron дёрнулся дважды за одну
          // минуту) — ignoreDuplicates ничего не вставит, .maybeSingle() вернёт null, пропускаем.
          const { data: inserted } = await admin
            .from('habit_reminder_sent')
            .upsert({ user_id: row.id, habit_uid: habit.uid, sent_date: todayKey }, { onConflict: 'user_id,habit_uid,sent_date', ignoreDuplicates: true })
            .select()
            .maybeSingle();
          if (!inserted) continue;

          const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: row.telegram_id,
              text: `🔔 Время действовать: ${habit.text}`,
              reply_markup: { inline_keyboard: [[{ text: 'Открыть Live Life', web_app: { url: MINI_APP_URL } }]] },
            }),
          });
          const tgData = await res.json();
          if (tgData.ok) sent++;
          else console.warn('sendMessage failed for', row.id, habit.uid, tgData.description);
        }
      } catch (e) {
        console.error('habit reminder failed for', row.id, e);
      }
    }
    return new Response(JSON.stringify({ checked: rows.length, sent }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    await logError('send-habit-reminders', 'unexpected', { detail: e });
    return new Response(JSON.stringify({ error: 'unexpected', detail: String(e) }), { status: 500 });
  }
});
