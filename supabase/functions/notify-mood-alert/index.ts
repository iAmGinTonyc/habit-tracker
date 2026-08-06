// Edge Function: notify-mood-alert
// Вызывается КЛИЕНТОМ напрямую (не cron) сразу при сохранении чек-апа, если настроение < 4 — см.
// autoSaveCheckin в habbittracker.js. Шлёт Telegram-сообщение всем «семье/друзьям» (принятые
// invites, см. db/phase3_family.sql — та же группа, что видна юзеру в профиле как «Приглашённые
// друзья» со статусом accepted, туда же уходит и текущий mood в fam-stats) юзера, отметившего
// низкое настроение. Дедуп — не чаще раза в локальный день на самого юзера
// (last_mood_alert_local_date в profiles, см. db/phase15_mood_alert.sql), иначе клик несколько
// раз по шкале настроения зашлёт родным кучу одинаковых сообщений подряд.
//
// Секреты: TELEGRAM_BOT_TOKEN (тот же, что у остальных функций). SUPABASE_URL/
// SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY — платформа сама. Деплоить БЕЗ --no-verify-jwt —
// вызывает авторизованный клиент своим JWT, не cron.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';
const MOOD_THRESHOLD = 4; // юзер попросил ровно «ниже 4»

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
// en-CA форматирует как YYYY-MM-DD — тот же формат, что и в остальных cron-функциях/habbittracker.js.
function localDateKey(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC' }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!BOT_TOKEN) return json({ error: 'no_bot_token' }, 500);

  try {
    // Кто отметил — из Authorization заголовка (verify_jwt включён платформой), не из тела запроса.
    const authHeader = req.headers.get('Authorization') ?? '';
    const sbUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await sbUser.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'not_authenticated' }, 401);
    const userId = userData.user.id;

    const { mood } = await req.json();
    const moodNum = Number(mood);
    if (!Number.isFinite(moodNum) || moodNum >= MOOD_THRESHOLD) return json({ skipped: 'mood_not_low' });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: me } = await admin
      .from('profiles')
      .select('display_name, timezone, last_mood_alert_local_date')
      .eq('id', userId)
      .maybeSingle();
    const todayKey = localDateKey(me?.timezone || 'UTC');
    if (me?.last_mood_alert_local_date === todayKey) return json({ skipped: 'already_sent_today' });

    // Имя для сообщения — свой display_name (юзер мог задать вручную в профиле), иначе
    // first_name/username из Telegram-метаданных, сохранённых при входе (см. telegram-auth).
    let name = me?.display_name || '';
    if (!name) {
      const { data: authUser } = await admin.auth.admin.getUserById(userId);
      const meta = (authUser?.user?.user_metadata || {}) as Record<string, unknown>;
      name = (meta.first_name as string) || (meta.username as string) || 'близкий человек';
    }

    // «Семья/друзья» — обе стороны принятых invites (см. db/phase3_family.sql), та же группа, что
    // юзер уже видит в профиле как «Приглашённые друзья».
    const { data: invites, error: invitesErr } = await admin
      .from('invites')
      .select('from_id, to_id')
      .eq('status', 'accepted')
      .or(`from_id.eq.${userId},to_id.eq.${userId}`);
    if (invitesErr) {
      await logError('notify-mood-alert', 'invites_query_failed', { userId, detail: invitesErr.message });
      return json({ error: invitesErr.message }, 500);
    }
    const familyIds = Array.from(new Set((invites || []).map((i) => (i.from_id === userId ? i.to_id : i.from_id))));
    if (!familyIds.length) return json({ sent: 0, reason: 'no_family' });

    const { data: familyProfiles } = await admin
      .from('profiles')
      .select('id, telegram_id')
      .in('id', familyIds)
      .not('telegram_id', 'is', null);

    let sent = 0;
    for (const fp of familyProfiles || []) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: fp.telegram_id,
            text: `💙 ${name} отметил(а) низкое настроение сегодня (${moodNum}/10) — может, стоит написать?`,
            reply_markup: { inline_keyboard: [[{ text: 'Открыть Live Life', web_app: { url: MINI_APP_URL } }]] },
          }),
        });
        const tgData = await res.json();
        if (tgData.ok) sent++;
        else console.warn('sendMessage failed for', fp.id, tgData.description);
      } catch (e) {
        console.error('mood alert failed for', fp.id, e);
      }
    }

    // Помечаем ПОСЛЕ рассылки — если что-то упало выше, лучше попробовать снова при следующем
    // сохранении чек-апа, чем молча остаться без уведомления на весь день.
    await admin.from('profiles').update({ last_mood_alert_local_date: todayKey }).eq('id', userId);

    return json({ sent });
  } catch (e) {
    await logError('notify-mood-alert', 'unexpected', { detail: e });
    return json({ error: 'unexpected', detail: String(e) }, 500);
  }
});
