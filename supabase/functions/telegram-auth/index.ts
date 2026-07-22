// Edge Function: telegram-auth
// Проверяет Telegram Mini App initData на сервере (HMAC, токен бота никогда не покидает бэкенд),
// находит или создаёт Supabase-юзера по telegram_id, стартует триал при первом входе, отдаёт
// клиенту одноразовый token_hash для завершения входа через supabase.auth.verifyOtp().
// См. HANDOFF.md §15. НЕ протестировано в реальном Telegram — деплой и первый прогон см. README
// в конце этого файла / ответ в чате.
//
// Секреты/env (Supabase подставляет SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY автоматически в
// каждую Edge Function — руками их выставлять не нужно; TELEGRAM_BOT_TOKEN — единственный секрет,
// который нужно задать вручную: supabase secrets set TELEGRAM_BOT_TOKEN=...).

import { createClient } from 'npm:@supabase/supabase-js@2';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// === Проверка подписи initData ===
// Алгоритм по официальной доке Telegram (core.telegram.org/bots/webapps):
//   secret_key = HMAC_SHA256(key="WebAppData", message=<bot_token>)
//   hash       = hex(HMAC_SHA256(key=secret_key, message=<data_check_string>))
// data_check_string — все поля initData КРОМЕ hash, отсортированные по ключу, "key=value" через \n.
async function hmacSha256(key: string | Uint8Array, message: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  // `as BufferSource` — обходит чрезмерно строгую типизацию Uint8Array<ArrayBufferLike> в
  // свежих версиях TS (не влияет на рантайм, Web Crypto принимает Uint8Array как есть).
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message) as BufferSource);
  return new Uint8Array(sig);
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

async function validateInitData(initData: string, botToken: string): Promise<{ ok: boolean; user?: TelegramUser }> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false };
  params.delete('hash');

  const keys = Array.from(params.keys()).sort();
  const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join('\n');

  const secretKey = await hmacSha256('WebAppData', botToken);
  const computed = toHex(await hmacSha256(secretKey, dataCheckString));
  if (computed !== hash) return { ok: false };

  // initData старше суток — подозрительно (перепройденная/протухшая ссылка), отклоняем
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return { ok: false };

  const userJson = params.get('user');
  if (!userJson) return { ok: false };
  return { ok: true, user: JSON.parse(userJson) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!BOT_TOKEN) return json({ error: 'server_misconfigured_no_bot_token' }, 500);

  try {
    const { initData } = await req.json();
    if (!initData) return json({ error: 'no_init_data' }, 400);

    const { ok, user } = await validateInitData(initData, BOT_TOKEN);
    if (!ok || !user?.id) return json({ error: 'invalid_init_data' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const telegramId: number = user.id;

    const { data: existingProfile } = await admin
      .from('profiles')
      .select('id, email')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    let userId: string;
    let email: string;

    if (existingProfile) {
      userId = existingProfile.id;
      email = existingProfile.email;
    } else {
      // Новый Telegram-юзер: заводим настоящего Supabase Auth юзера с синтетическим email —
      // существующий триггер handle_new_user() (db/phase1_profiles.sql) сам создаст строку
      // в profiles с уникальным invite_id, дальше только дописываем telegram_id.
      email = `tg_${telegramId}@telegram.local`;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { telegram_id: telegramId, first_name: user.first_name, username: user.username },
      });
      if (createErr || !created?.user) return json({ error: 'create_user_failed', detail: createErr?.message }, 500);
      userId = created.user.id;

      await admin.from('profiles').update({ telegram_id: telegramId }).eq('id', userId);
      // trial_started_at = now() по умолчанию в схеме (db/phase5_telegram.sql) — фиксируется здесь,
      // один раз, при первом появлении юзера. Второй вызов сюда не попадёт (найдётся existingProfile).
      await admin.from('subscriptions').insert({ user_id: userId });
    }

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (linkErr || !link) return json({ error: 'link_failed', detail: linkErr?.message }, 500);

    const { data: subscription } = await admin.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();

    return json({
      email,
      hashed_token: link.properties?.hashed_token,
      subscription,
    });
  } catch (e) {
    return json({ error: 'unexpected', detail: String(e) }, 500);
  }
});

// === Как задеплоить и проверить (см. полную версию в ответе в чате) ===
// 1. supabase login
// 2. supabase secrets set TELEGRAM_BOT_TOKEN=<токен от BotFather> --project-ref sgsqgpthfufbbyukifbn
// 3. Выполнить db/phase5_telegram.sql в Supabase → SQL Editor
// 4. supabase functions deploy telegram-auth --project-ref sgsqgpthfufbbyukifbn
// 5. Открыть Mini App в реальном Telegram, проверить в логах функции (supabase functions logs
//    telegram-auth), что запрос дошёл и не упал.
