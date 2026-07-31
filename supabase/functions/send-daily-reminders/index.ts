// Edge Function: send-daily-reminders
// Дёргается pg_cron (через pg_net http_post) каждые 15 минут — см. HANDOFF.md, Фаза 8. Не имеет
// пользовательской JWT-сессии (вызывает не юзер, а сама база), поэтому деплоится с
// --no-verify-jwt, а единственная защита эндпоинта — секретный заголовок X-Cron-Secret (тот же
// подход, что и у telegram-payments-webhook с TELEGRAM_WEBHOOK_SECRET).
//
// Секреты: TELEGRAM_BOT_TOKEN, TELEGRAM_REMINDER_CRON_SECRET. SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY — платформа подставляет сама.

import { createClient } from 'npm:@supabase/supabase-js@2';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CRON_SECRET = Deno.env.get('TELEGRAM_REMINDER_CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';

// ДЕРЖАТЬ В СИНХРОНЕ с `phrases` в habbittracker.js (тот же список, что и на интро-экране) —
// дублирование сознательное, тот же компромисс, что уже принят в проекте для цен Stars
// (PRICE_PERSONAL_STARS и т.п. дублируются между auth.js и create-invoice/index.ts).
const PHRASES = [
  'Побеждает тот, кто не останавливается',
  'У самурая только путь',
  'Дисциплина сильнее мотивации',
  'Маленькие шаги каждый день — вот и весь секрет',
  'Не жди вдохновения. Начни — и оно придёт',
  'Сила не в том, чтобы не падать, а в том, чтобы вставать снова',
  'Каждый день — ещё один шаг к тому, кем ты хочешь стать',
  'Путь важнее цели',
  'Тот, кто ждёт идеального момента, не начинает никогда',
  'Слабость — это отказ подняться, а не само падение',
  'Величие строится из повторений, которых никто не видит',
  'Сравнивай себя не с другими, а с собой вчерашним',
  'Тренируй тело — закаляй дух',
  'Воин не выбирает, тренироваться сегодня или нет — он просто тренируется',
  'Привычка — тихий голос, который однажды станет судьбой',
  'Комфорт — враг роста',
  'Иди медленно, но не останавливайся',
  'Сегодняшнее усилие — завтрашняя сила',
  'Никто не увидит тренировки — все увидят результат',
  'Спокойствие сильнее суеты',
  'Просто продолжай',
];

interface DueRow {
  user_id: string;
  telegram_id: number;
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('X-Cron-Secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: 'no_bot_token' }), { status: 500 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await admin.rpc('get_and_mark_due_reminders');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const due: DueRow[] = data || [];
  let sent = 0;
  for (const row of due) {
    const text = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    try {
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
      else console.warn('sendMessage failed for', row.user_id, tgData.description);
    } catch (e) {
      // Частая причина — юзер заблокировал бота; не роняем весь батч из-за одного.
      console.error('send failed for', row.user_id, e);
    }
  }
  return new Response(JSON.stringify({ due: due.length, sent }), { headers: { 'Content-Type': 'application/json' } });
});
