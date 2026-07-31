-- ФАЗА 8 — ежедневное пуш-напоминание в 20:00 по локальному времени юзера, если не заходил
-- сегодня (по его дню). Выполнить в Supabase → SQL Editor → Run. Требует Фазы 1 (profiles).
--
-- ВАЖНО: планирование cron-задачи (cron.schedule) сюда НЕ входит — она содержит секрет для
-- аутентификации вызова Edge Function, а этот репозиторий публичный. Cron настраивается отдельной
-- командой напрямую через CLI, без сохранения в файл (см. HANDOFF.md).

-- IANA-имя зоны (напр. 'Europe/Moscow') — пишет клиент через обычный update; last_seen_at — тоже
-- клиент, при каждом успешном открытии приложения. last_reminder_sent_local_date — только сервер
-- (Edge Function через service role), защита от повторной отправки в один и тот же локальный день.
alter table public.profiles add column if not exists timezone text;
alter table public.profiles add column if not exists last_seen_at timestamptz;
alter table public.profiles add column if not exists last_reminder_sent_local_date date;
-- Новых RLS-политик не нужно: "own profile update" (db/phase1_profiles.sql, auth.uid() = id) уже
-- разрешает владельцу писать любые колонки своей строки, включая две новые клиентские.

-- Атомарно выбирает всех, кому сейчас пора (20:00–20:14 по ИХ времени, ещё не заходили сегодня по
-- своему дню, и напоминание сегодня ещё не отправлялось), и сразу же помечает как отправленное —
-- FOR UPDATE SKIP LOCKED + UPDATE...RETURNING в одном выражении защищают от двойной отправки, если
-- два тика cron когда-нибудь пересекутся.
create or replace function public.get_and_mark_due_reminders()
returns table(user_id uuid, telegram_id bigint)
language plpgsql security definer set search_path = public as $$
begin
  -- Внутри тела функции имена OUT-параметров (user_id, telegram_id) видны как переменные наравне
  -- с колонками таблицы — без алиаса pr. и полной квалификации telegram_id ниже Postgres не может
  -- понять, колонку или переменную имели в виду, и падает с "column reference is ambiguous".
  return query
  update public.profiles p
  set last_reminder_sent_local_date = (now() at time zone p.timezone)::date
  from (
    select pr.id from public.profiles pr
    where pr.timezone is not null and pr.telegram_id is not null
      and to_char(now() at time zone pr.timezone, 'HH24:MI') between '20:00' and '20:14'
      and (pr.last_seen_at is null or (pr.last_seen_at at time zone pr.timezone)::date < (now() at time zone pr.timezone)::date)
      and (pr.last_reminder_sent_local_date is null or pr.last_reminder_sent_local_date < (now() at time zone pr.timezone)::date)
    for update skip locked
  ) due
  where p.id = due.id
  returning p.id, p.telegram_id;
end $$;

-- Только Edge Function (service role) может дёргать эту функцию — обычным юзерам через RPC нельзя.
revoke execute on function public.get_and_mark_due_reminders() from public, anon, authenticated;
grant execute on function public.get_and_mark_due_reminders() to service_role;
