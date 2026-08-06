-- ФАЗА 14 — реферальная награда: реальная неделя Personal вместо +7 дней к триалу.
-- Выполнить в Supabase → SQL Editor → Run. Заменяет grant_referral_bonus() из Фазы 7.
--
-- Раньше: +7 дней в bonus_days просто отодвигали расчётный дедлайн доступа (computeAppAccess в
-- auth.js) — во время ТРИАЛА это продлевало сам триал, но НЕ снимало Pro-mode-пейволл, потому что
-- Pro mode проверяет строго window.hasActiveSubscription = (status === 'active') (см. auth.js
-- loadSubscription — «не трогает free-триал/бонусные дни: это отдельный, более широкий гейт»).
-- Юзер попросил: пригласившему сразу давать НАСТОЯЩУЮ неделю Personal (status:'active',
-- plan:'personal'), а не просто более длинный триал — чтобы Pro mode тоже открывался.
--
-- Если у юзера УЖЕ активная оплаченная подписка (любой план, включая Family) — просто продлеваем
-- expires_at на 7 дней, план не трогаем (не превращаем Family-подписчика в Personal). Если подписки
-- нет или она не активна (триал/истёк) — выдаём status:'active', plan:'personal' на 7 дней от сейчас.
-- bonus_days по-прежнему растёт — это уже отдельный лайфтайм-счётчик в профиле («N бесплатных
-- дней»), не завязанный на то, как именно отработала текущая награда.
create or replace function public.grant_referral_bonus() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cur_status text;
  cur_expires timestamptz;
begin
  select status, expires_at into cur_status, cur_expires
    from public.subscriptions where user_id = new.to_id;

  if cur_status = 'active' and cur_expires is not null and cur_expires > now() then
    update public.subscriptions
      set expires_at = cur_expires + interval '7 days',
          bonus_days = bonus_days + 7,
          updated_at = now()
      where user_id = new.to_id;
  else
    update public.subscriptions
      set status = 'active',
          plan = 'personal',
          expires_at = now() + interval '7 days',
          bonus_days = bonus_days + 7,
          updated_at = now()
      where user_id = new.to_id;
  end if;
  return new;
end $$;
