-- ФАЗА 9 — Family-план был неполным: оплата ставила status='active' ТОЛЬКО покупателю
-- (family_owner_id из Фазы 5 существовал в схеме, но никогда не заполнялся). Эта фаза добивает
-- две вещи, решённые ещё в §15 HANDOFF.md, но не реализованные:
--   1) реальные члены семьи (принятые invites, см. Фаза 3) получают доступ, когда владелец платит
--      за Family (см. supabase/functions/telegram-payments-webhook/index.ts);
--   2) если семья распадается (кто-то удалён/вышел — invites.status уходит с 'accepted'), у
--      ушедшего доступ по семье отзывается, а у владельца план автоматически переключается на
--      Personal, если семьи не осталось совсем ('Если семья тает до 1 человека — план
--      автоматически переключается на Personal', см. HANDOFF.md §15).
-- Выполнить в Supabase → SQL Editor → Run. Требует Фазы 3 (invites/are_friends) и Фазы 5
-- (subscriptions/family_owner_id).

-- Разрыв семейной связи между member_id и owner_id: снимает family_owner_id у члена и
-- откатывает его статус на обычный триальный расчёт (тот же, что делает клиент в
-- computeAppAccess/auth.js — TRIAL_DAYS=14, держим в синхроне, если поменяешь константу там).
-- Если у member_id уже нет подписки от ЭТОГО владельца (family_owner_id не совпадает) —
-- ничего не делает, значит доступ пришёл не отсюда (свой Personal и т.п.) и трогать нельзя.
create or replace function public.revoke_family_access(member_id uuid, owner_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.subscriptions
    set family_owner_id = null,
        plan = 'trial',
        status = case when now() < trial_started_at + interval '14 days' then 'trial' else 'expired' end,
        updated_at = now()
    where user_id = member_id and family_owner_id = owner_id;
end; $$;

-- Триггер: как только пара перестаёт быть «семьёй» (accepted -> любой другой статус), с обеих
-- сторон возможной семейной подписки синхронизируем доступ. Проверяем ОБЕ стороны, потому что
-- семейный план мог купить любой из двух (в invites нет понятия «кто платит»).
create or replace function public.on_family_link_broken() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pair record;
  remaining int;
begin
  for pair in select * from (values (old.from_id, old.to_id), (old.to_id, old.from_id)) as t(member_id, owner_id)
  loop
    if not public.are_friends(pair.member_id, pair.owner_id) then
      perform public.revoke_family_access(pair.member_id, pair.owner_id);
    end if;

    -- владелец потерял ВСЮ семью — семейный план дороже смысла не имеет, откатываем ярлык плана
    -- на Personal (доступ/expires_at не трогаем — за оплаченный период он остаётся).
    select count(*) into remaining from public.invites
      where status = 'accepted' and (from_id = pair.owner_id or to_id = pair.owner_id);
    if remaining = 0 then
      update public.subscriptions set plan = 'personal', family_size = null, updated_at = now()
        where user_id = pair.owner_id and plan = 'family';
    end if;
  end loop;
  return null;
end; $$;

drop trigger if exists invites_family_link_broken on public.invites;
create trigger invites_family_link_broken
  after update on public.invites
  for each row
  when (old.status = 'accepted' and new.status is distinct from 'accepted')
  execute function public.on_family_link_broken();
