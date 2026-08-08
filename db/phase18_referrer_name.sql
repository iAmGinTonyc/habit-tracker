-- ФАЗА 18 — юзер попросил дефолтный показатель Pro mode «Поблагодарить <имя> за Live Life
-- трекер», где <имя> — тот, кто позвал (пригласил) нового юзера по реферальной ссылке. Клиент в
-- момент регистрации (telegramSignIn, auth.js) уже знает КОД пригласившего (start_param), но не
-- его отображаемое имя — RLS у stats/profiles не пускает читать чужие данные, пока связь не
-- 'accepted' (see db/phase3_family.sql), а свежий переход по ссылке создаёт только 'pending'.
-- Эта SECURITY DEFINER-функция — узкий, безопасный обход именно для этого случая: код приглашения
-- и так уже был публично передан новому юзеру (по ссылке), отдать по нему только ИМЯ владельца —
-- не большая утечка, чем сама механика приглашений. Выполнить в Supabase → SQL Editor → Run.
-- Требует Фазы 1 (profiles) и Фазы 2 (stats).

create or replace function public.get_referrer_name(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select s.name from public.stats s
  join public.profiles p on p.id = s.id
  where p.invite_id = upper(trim(p_code))
  limit 1;
$$;
