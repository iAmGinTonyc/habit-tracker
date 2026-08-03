-- ФАЗА 13 — реальные push-напоминания по привычкам (не только в открытой вкладке). Раньше
-- напоминание для привычки («Напомнить в:» в настройках, см. habit.reminderTime) проверялось ТОЛЬКО
-- клиентским setInterval (см. checkReminders в habbittracker.js) — если Mini App не открыт, юзер
-- ничего не получал. Теперь отдельный cron (каждую МИНУТУ — время у привычки с точностью до минуты,
-- не 15-минутным окном, как у остальных напоминаний) читает синхронизированный app_state
-- (db/phase11_app_state_sync.sql) и шлёт настоящее сообщение в Telegram.
-- Выполнить в Supabase → SQL Editor → Run. Требует Фазы 8 (profiles.timezone/telegram_id) и
-- Фазы 11 (app_state).

-- Дедуп по (user_id, habit_uid, дата) — без него пуш мог бы задвоиться, если cron когда-нибудь
-- дёрнется дважды за одну и ту же минуту (retry/оverlap). Edge Function делает
-- upsert(..., {ignoreDuplicates:true}) — если строка на сегодня уже есть, ничего не вставится и
-- второй пуш не уйдёт.
create table if not exists public.habit_reminder_sent (
  user_id    uuid not null references auth.users(id) on delete cascade,
  habit_uid  text not null,
  sent_date  date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, habit_uid, sent_date)
);
alter table public.habit_reminder_sent enable row level security;
-- Намеренно ни одной политики для anon/authenticated — доступ только через service_role (Edge Function).

-- НАПОМИНАНИЕ (как и в Фазах 8, 12) — планирование cron-задачи сюда не входит (секрет, публичный
-- репозиторий). Нужен ОТДЕЛЬНЫЙ pg_cron, тикающий КАЖДУЮ МИНУТУ (не раз в 15 минут!), дёргающий
-- send-habit-reminders со своим X-Cron-Secret.
