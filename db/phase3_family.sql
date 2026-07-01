-- ФАЗА 2+3 — сводка-статистика (шарится семье) + приглашения/семья (взаимно).
-- Выполнить в Supabase → SQL Editor → Run. Требует уже применённой Фазы 1 (profiles).

-- 1) СВОДКА, которую видят члены семьи (read-only). Юзер апсертит только свою строку.
create table if not exists public.stats (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text,            -- отображаемое имя (по умолчанию из email)
  level      int  default 1,
  streak     int  default 0,  -- лучшая текущая серия
  week_pct   int  default 0,  -- % выполнения привычек за 7 дней
  mood       int,             -- последнее утреннее настроение (1..10) или null
  updated_at timestamptz default now()
);
alter table public.stats enable row level security;

-- 2) ПРИГЛАШЕНИЯ / СВЯЗИ. Принятое приглашение = дружба в обе стороны.
create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid references auth.users(id) on delete cascade,
  to_id      uuid references auth.users(id) on delete cascade,
  from_code  text,            -- invite_id отправителя (чтобы получатель видел, кто зовёт)
  status     text default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz default now(),
  unique (from_id, to_id)
);
alter table public.invites enable row level security;

-- друзья ли двое (есть принятое приглашение в любую сторону). SECURITY DEFINER → без рекурсии RLS.
create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.invites
    where status = 'accepted'
      and ((from_id = a and to_id = b) or (from_id = b and to_id = a))
  );
$$;

-- RLS stats: свой — всё; друзья — только чтение
drop policy if exists "stats self all" on public.stats;
create policy "stats self all" on public.stats
  for all using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "stats friends read" on public.stats;
create policy "stats friends read" on public.stats
  for select using (public.are_friends(auth.uid(), id));

-- RLS invites: видеть свои (от меня или мне); менять статус — получатель
drop policy if exists "invites read own" on public.invites;
create policy "invites read own" on public.invites
  for select using (from_id = auth.uid() or to_id = auth.uid());
drop policy if exists "invites respond" on public.invites;
create policy "invites respond" on public.invites
  for update using (to_id = auth.uid()) with check (to_id = auth.uid());

-- отправка приглашения по короткому ID. Встречное pending — авто-принимаем (сразу дружба).
create or replace function public.send_invite(target_code text)
returns text language plpgsql security definer set search_path = public as $$
declare target uuid; my_code text;
begin
  select id into target from public.profiles where invite_id = upper(trim(target_code));
  if target is null then return 'not_found'; end if;
  if target = auth.uid() then return 'self'; end if;
  if public.are_friends(auth.uid(), target) then return 'already_friends'; end if;
  if exists (select 1 from public.invites where from_id = target and to_id = auth.uid() and status = 'pending') then
    update public.invites set status = 'accepted' where from_id = target and to_id = auth.uid();
    return 'accepted';
  end if;
  select invite_id into my_code from public.profiles where id = auth.uid();
  insert into public.invites (from_id, to_id, from_code) values (auth.uid(), target, my_code)
    on conflict (from_id, to_id) do update set status = 'pending';
  return 'sent';
end; $$;
