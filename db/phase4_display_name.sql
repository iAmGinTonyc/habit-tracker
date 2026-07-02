-- ФАЗА 4 — редактируемое отображаемое имя (видят члены семьи).
-- Выполнить в Supabase → SQL Editor → Run. Требует уже применённой Фазы 1 (profiles).

alter table public.profiles add column if not exists display_name text;
-- RLS уже покрывает: "own profile read"/"own profile update" (см. db/phase1_profiles.sql)
-- позволяют владельцу читать и обновлять свою строку, включая новую колонку — доп. политик не нужно.
