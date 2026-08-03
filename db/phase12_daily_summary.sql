-- ФАЗА 12 — вечерняя сводка дня в Telegram: «что сегодня трогал» (привычки/метрики Pro mode/
-- чек-ап/питание/событие дня) — читает синхронизированный app_state (см. db/phase11_app_state_sync.sql,
-- без него читать на сервере было бы нечего — весь прогресс раньше жил только в localStorage).
-- Тот же паттерн, что и db/phase8_daily_reminders.sql (окно по локальному времени юзера,
-- FOR UPDATE SKIP LOCKED + отдельная колонка «уже отправлено сегодня»), но своё окно времени
-- (конец дня, не 20:00) и своя цель (отчёт, а не «зайди в приложение»).
-- Выполнить в Supabase → SQL Editor → Run. Требует Фазы 8 (profiles.timezone/telegram_id) и
-- Фазы 11 (app_state).

alter table public.profiles add column if not exists last_summary_sent_local_date date;

-- Окно 22:45–22:59 по локальному времени юзера — «конец дня», но ещё ДО полуночи (после полуночи
-- todayKey() на клиенте уже был бы другим днём, см. habbittracker.js todayKey()).
create or replace function public.get_and_mark_due_summaries()
returns table(user_id uuid, telegram_id bigint, timezone text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.profiles p
  set last_summary_sent_local_date = (now() at time zone p.timezone)::date
  from (
    select pr.id from public.profiles pr
    where pr.timezone is not null and pr.telegram_id is not null
      and to_char(now() at time zone pr.timezone, 'HH24:MI') between '22:45' and '22:59'
      and (pr.last_summary_sent_local_date is null or pr.last_summary_sent_local_date < (now() at time zone pr.timezone)::date)
    for update skip locked
  ) due
  where p.id = due.id
  returning p.id, p.telegram_id, p.timezone;
end $$;

revoke execute on function public.get_and_mark_due_summaries() from public, anon, authenticated;
grant execute on function public.get_and_mark_due_summaries() to service_role;

-- Читать чужой app_state с сервера тоже может только service_role (та же RLS-политика "app_state
-- self all" из Фазы 11 — обычному юзеру чужие данные и так недоступны, а Edge Function ходит через
-- service_role, который RLS не ограничивает).

-- НАПОМИНАНИЕ (как и в Фазе 8) — планирование cron-задачи (cron.schedule) сюда намеренно НЕ входит,
-- она содержит секрет, а этот репозиторий публичный. Нужен ОТДЕЛЬНЫЙ cron (каждые 15 минут, как и
-- у send-daily-reminders), дёргающий новую функцию send-daily-summary со своим X-Cron-Secret —
-- настраивается вручную через CLI/Dashboard, см. HANDOFF.md.
