
// Edge Function: send-inactive-nudge
// Дёргается ОТДЕЛЬНЫМ pg_cron каждые 15 минут (как send-daily-reminders/send-daily-summary; каждую
// минуту, как send-habit-reminders, тут не нужно — окно широкое, 10:00–21:59 по локали юзера, см.
// db/phase21_inactive_nudge.sql). Просьба юзера: «напоминалка для человека, который не заходил в
// приложение дольше 12 часов» с игривым текстом «пуньк пуньк / где-же потерялся наш(а) сладкий
// пользователь "имя"». Всю логику «кому и когда» держит SQL (get_and_mark_due_inactive: 12 часов,
// тихие часы, анти-спам-лимиты, дедуп с напоминанием 20:00) — здесь только текст и отправка.
//
// Секреты: TELEGRAM_BOT_TOKEN (тот же, что у остальных функций), TELEGRAM_INACTIVE_NUDGE_CRON_SECRET
// (свой, отдельный от TELEGRAM_REMINDER_CRON_SECRET/TELEGRAM_SUMMARY_CRON_SECRET/
// TELEGRAM_HABIT_REMINDER_CRON_SECRET — чтобы пуньки можно было выключить, не трогая остальные
// рассылки). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY подставляет платформа. Деплоить с
// --no-verify-jwt (вызывает не юзер, а сама база), единственная защита эндпоинта — заголовок
// X-Cron-Secret (тот же подход, что у send-daily-reminders и telegram-payments-webhook).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CRON_SECRET = Deno.env.get('TELEGRAM_INACTIVE_NUDGE_CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';

interface DueRow {
  user_id: string;
  telegram_id: number;
  user_name: string | null; // null = имени нет ни в profiles.display_name, ни в stats.name
  nudge_count: number;      // 1, 2 или 3 — какой это пуньк в текущем «отсутствии»
}

// Экранирование для parse_mode:'HTML' — как в send-daily-summary/index.ts. Имя приходит из
// пользовательского ввода (prof-name-input в профиле), символы < > & сломали бы разметку или вообще
// уронили бы отправку.
function escHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Формулировка первого пунька — дословно из просьбы юзера (включая его «где-же» и «наш(а)»: пол
// юзера мы не знаем, а он сам написал именно так — не «исправляем» без спроса). Второй и третий
// пуньк отличаются текстом, чтобы три одинаковых сообщения подряд не выглядели как заевший бот —
// тот же приём, что PHRASES в send-daily-reminders/index.ts. %NAME% подставляется ниже.
const NUDGE_TEXTS = [
  'пуньк пуньк\nгде-же потерялся наш(а) сладкий пользователь «%NAME%»?',
  'пуньк пуньк пуньк\nмы всё ещё ищем нашего сладкого пользователя «%NAME%» — без тебя тут скучно',
  'пуньк…\n«%NAME%», это последний пуньк — дальше молчим и ждём 🐺',
];
// Имени может не быть вовсе (юзер не сохранял display_name и по какой-то причине нет строки в stats)
// — тогда та же интонация, но без обращения. Порядок строк ДОЛЖЕН совпадать с NUDGE_TEXTS.
const NUDGE_TEXTS_NO_NAME = [
  'пуньк пуньк\nгде-же потерялся наш(а) сладкий пользователь?',
  'пуньк пуньк пуньк\nмы всё ещё ищем нашего сладкого пользователя — без тебя тут скучно',
  'пуньк…\nэто последний пуньк — дальше молчим и ждём 🐺',
];

function buildNudgeText(name: string | null, nudgeCount: number): string {
  const clean = (name || '').trim();
  // nudgeCount приходит из SQL уже 1..3, но подстраховываемся: если лимит в миграции когда-нибудь
  // поднимут, а массив текстов забудут расширить — берём последний текст, а не undefined.
  const idx = Math.min(Math.max(nudgeCount, 1), NUDGE_TEXTS.length) - 1;
  if (!clean) return NUDGE_TEXTS_NO_NAME[idx];
  // Колбэк, а не строка-замена: в String.replace строка-замена трактует $& / $1 / $` как
  // спецпоследовательности, а имя — это произвольный пользовательский ввод, где такие символы
  // вполне могут оказаться. Колбэк возвращает текст как есть.
  return NUDGE_TEXTS[idx].replace('%NAME%', () => `<b>${escHtml(clean)}</b>`);
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('X-Cron-Secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: 'no_bot_token' }), { status: 500 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    const { data, error } = await admin.rpc('get_and_mark_due_inactive');
    if (error) {
      await logError('send-inactive-nudge', 'get_and_mark_due_inactive_failed', { detail: error.message });
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    const due: DueRow[] = data || [];
    let sent = 0;
    for (const row of due) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: row.telegram_id,
            text: buildNudgeText(row.user_name, row.nudge_count),
            parse_mode: 'HTML', // имя жирным (см. buildNudgeText/escHtml)
            reply_markup: {
              inline_keyboard: [[{ text: 'Открыть Live Life', web_app: { url: MINI_APP_URL } }]],
            },
          }),
        });
        const tgData = await res.json();
        if (tgData.ok) sent++;
        // Частая причина отказа — юзер заблокировал бота (для ЭТОЙ рассылки, по определению
        // адресованной ушедшим, — самый вероятный исход). Это рутина, не сбой: в error_log не
        // пишем, иначе журнал захлебнётся (та же логика, что в send-daily-reminders).
        else console.warn('sendMessage failed for', row.user_id, tgData.description);
      } catch (e) {
        console.error('nudge failed for', row.user_id, e); // не роняем весь батч из-за одного
      }
    }
    return new Response(JSON.stringify({ due: due.length, sent }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    await logError('send-inactive-nudge', 'unexpected', { detail: e });
    return new Response(JSON.stringify({ error: 'unexpected', detail: String(e) }), { status: 500 });
  }
});
