-- ФАЗА 1 — профили + короткий invite_id для приглашений.
-- Выполнить один раз в Supabase → SQL Editor → New query → Run.

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  invite_id  text unique not null,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- свой профиль: читать и обновлять может только владелец
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles
  for update using (auth.uid() = id);

-- короткий ID из 8 символов, без похожих 0/O/1/I
create or replace function public.gen_invite_id() returns text
language plpgsql volatile as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  r text := '';
  i int;
begin
  for i in 1..8 loop
    r := r || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return r;
end $$;

-- при регистрации автоматически создаём профиль с уникальным invite_id
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare code text;
begin
  loop
    code := public.gen_invite_id();
    exit when not exists (select 1 from public.profiles where invite_id = code);
  end loop;
  insert into public.profiles (id, email, invite_id) values (new.id, new.email, code);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
