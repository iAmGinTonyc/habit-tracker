-- ФАЗА 7 — 2-недельный триал + скидка 50% за «идеальный месяц» + бонусные недели за рефералов.
-- Выполнить в Supabase → SQL Editor → Run. Требует уже применённых Фаз 3 (invites) и 5 (subscriptions).

-- 1) ЛЕДЖЕР ВЫПОЛНЕНИЯ ЗАДАЧ ПО ДНЯМ — источник правды для скидки (её считает create-invoice по
-- service role, минуя RLS). day проставляется СЕРВЕРОМ (current_date), а не клиентом — поэтому уже
-- существующая фича «отметить привычку задним числом» в хитмапе физически не может попасть в этот
-- леджер: «отметил позже — скидка за этот месяц не считается» реализуется самой структурой таблицы,
-- без отдельного флага «marked_late» и без доверия клиенту.
create table if not exists public.daily_completions (
  user_id         uuid not null references auth.users(id) on delete cascade,
  day             date not null,
  completed_count int not null default 0,
  updated_at      timestamptz default now(),
  primary key (user_id, day)
);
alter table public.daily_completions enable row level security;

drop policy if exists "daily_completions self read" on public.daily_completions;
create policy "daily_completions self read" on public.daily_completions
  for select using (user_id = auth.uid());
-- Намеренно нет insert/update политики для authenticated — запись только через RPC ниже.

-- Клиент вызывает это при каждом изменении количества выполненных на СЕГОДНЯ задач. p_count —
-- сколько всего отмечено на сегодня; day клиент передать не может вообще (не параметр функции).
create or replace function public.record_today_completion(p_count int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.daily_completions (user_id, day, completed_count, updated_at)
  values (auth.uid(), current_date, greatest(p_count, 0), now())
  on conflict (user_id, day) do update
    set completed_count = greatest(p_count, 0), updated_at = now();
end $$;

-- 2) БОНУСНЫЕ ДНИ ЗА РЕФЕРАЛОВ — банк, который только растёт, никогда не тратится по счётчику:
-- он сдвигает расчётный дедлайн доступа (см. auth.js loadSubscription/hasAppAccess), поэтому
-- бонусные недели одинаково работают и на триале, и поверх уже оплаченной подписки.
alter table public.subscriptions add column if not exists bonus_days int not null default 0;

-- +7 дней тому, чей код использовали (to_id) — ровно один раз на каждого РАЗНОГО друга, потому что
-- строка invites уникальна по (from_id,to_id) (см. phase3_family.sql): она вставляется один
-- единственный раз при первом использовании кода этим конкретным человеком. Последующие
-- «добавить/удалить из семьи» — это UPDATE того же ряда (accepted ⇄ pending), AFTER INSERT
-- триггер на них не срабатывает — принятие/удаление из семьи не начисляет и не отбирает бонус.
-- (Известный редкий edge-case: если оба уже успели вручную пригласить друг друга ДО перехода по
-- ссылке, send_invite() просто примет существующее встречное приглашение через UPDATE — без INSERT
-- новой строки, бонус в этом случае не начислится. Осознанно не усложняем ради этого редкого пути.)
create or replace function public.grant_referral_bonus() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.subscriptions set bonus_days = bonus_days + 7, updated_at = now()
    where user_id = new.to_id;
  return new;
end $$;

drop trigger if exists on_invite_created_grant_bonus on public.invites;
create trigger on_invite_created_grant_bonus
  after insert on public.invites
  for each row execute function public.grant_referral_bonus();
