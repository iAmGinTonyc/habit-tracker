-- ФАЗА 10 — журнал ошибок Edge Functions (без внешнего мониторинга вроде Sentry — юзер решил
-- обойтись без сторонних сервисов, см. переписку). Раньше ошибки в create-invoice/telegram-auth/
-- telegram-payments-webhook были видны ТОЛЬКО через `supabase functions logs` — то есть только
-- если разработчик сам зашёл смотреть. Теперь ключевые ошибки (не рутинные 400 от плохого ввода,
-- а реальные сбои — упавший Telegram API, не создался юзер и т.п.) дублируются сюда через
-- supabase/functions/_shared/logError.ts.
-- Выполнить в Supabase → SQL Editor → Run.

create table if not exists public.error_log (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  function_name text not null,
  user_id       uuid,
  message       text not null,
  detail        text
);
alter table public.error_log enable row level security;
-- Намеренно НЕТ политик для anon/authenticated — ни читать, ни писать с клиента нельзя. Пишет
-- только service_role (Edge Functions, обходит RLS), а смотреть сам разработчик будет из
-- Supabase → SQL Editor (тоже мимо RLS, там роль postgres) — см. запрос ниже.

-- Пример запроса для регулярной проверки (последние ошибки за сутки):
--   select created_at, function_name, user_id, message, detail
--   from public.error_log
--   where created_at > now() - interval '1 day'
--   order by created_at desc;
