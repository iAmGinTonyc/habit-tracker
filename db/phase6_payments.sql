-- ФАЗА 6 — Stars-оплата: колонка для идемпотентности вебхука платежей.
-- Выполнить в Supabase → SQL Editor → Run. Требует уже применённой Фазы 5 (subscriptions).

alter table public.subscriptions add column if not exists telegram_charge_id text;
