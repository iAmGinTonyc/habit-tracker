-- ФАЗА 17 — юзер попросил показывать семье ещё и «событие дня» (текстовая заметка на сегодня,
-- см. dashState.dayEvents в habbittracker.js/renderDayEventAndTask), в дополнение к уже
-- существующим streak/week_pct/mood (Фаза 2). RLS у stats уже симметричная («свой — всё, друзья —
-- только чтение», см. db/phase3_family.sql) — новую колонку отдельно гейтить не нужно, она
-- покрывается теми же политиками. Выполнить в Supabase → SQL Editor → Run. Требует Фазы 2 (stats).

alter table public.stats add column if not exists day_event text;
