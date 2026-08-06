-- ФАЗА 15 — уведомление семье/друзьям при низком настроении (юзер попросил: если кто-то в семье
-- отметил настроение ниже 4, остальные должны об этом узнать). Выполнить в Supabase → SQL Editor.
--
-- Дедуп «не чаще раза в день» для notify-mood-alert (см. supabase/functions/notify-mood-alert) —
-- тот же паттерн, что last_summary_sent_local_date/last_reminder_sent_local_date (Фазы 8/12).
alter table public.profiles add column if not exists last_mood_alert_local_date date;
