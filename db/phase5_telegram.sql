-- ФАЗА 5 — Telegram Mini App: привязка profile к telegram_id + таблица подписок/триала.
-- Выполнить в Supabase → SQL Editor → Run. Требует уже применённой Фазы 1 (profiles).

alter table public.profiles add column if not exists telegram_id bigint unique;

-- Статус триала/подписки. Пишет и меняет статус ТОЛЬКО Edge Function через service role
-- (обходит RLS) — обычный юзер не может сам себе выставить status='active' через клиентский
-- запрос, потому что политик на insert/update для authenticated здесь намеренно нет.
create table if not exists public.subscriptions (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  plan              text not null default 'trial' check (plan in ('trial','personal','family')),
  status            text not null default 'trial' check (status in ('trial','active','expired')),
  trial_started_at  timestamptz not null default now(),
  expires_at        timestamptz,
  family_owner_id   uuid references auth.users(id) on delete set null, -- заполнено у участников семьи (не у владельца плана)
  family_size       int,          -- заполнено только у владельца семейного плана (куплено мест, до 10)
  updated_at        timestamptz default now()
);
alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions self read" on public.subscriptions;
create policy "subscriptions self read" on public.subscriptions
  for select using (user_id = auth.uid());
