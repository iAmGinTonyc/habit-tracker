-- ФАЗА 20 — своё время вечерней сводки у каждого юзера + сводка «по запросу».
-- Просьба юзера дословно: «сделай возможность контролировать во сколько отправляется отчет за
-- день, некоторые люди ложаться спать в 4 ночи, нужно чтоб они во время получали уведомления о
-- статистике за день. А еще сделай возможность получать эти сводки по запросу.»
-- Раньше время было ЖЁСТКО зашито в get_and_mark_due_summaries (окно 22:45–22:59 по локали, см.
-- db/phase12_daily_summary.sql). Выполнить в Supabase → SQL Editor → Run. Требует Фазы 8
-- (profiles.timezone/telegram_id), Фазы 11 (app_state) и Фазы 12 (last_summary_sent_local_date).
--
-- НАПОМИНАНИЕ (как в Фазах 8, 12, 13): планирование cron сюда НЕ входит — команда содержит
-- секрет, а репозиторий публичный. Существующий cron на send-daily-summary (каждые 15 минут)
-- менять НЕ надо: он и дальше тикает раз в 15 минут, просто теперь раздаёт сводки по личному
-- времени каждого, а не всем скопом в 22:45.

alter table public.profiles add column if not exists summary_time    time    not null default '22:45';
alter table public.profiles add column if not exists summary_enabled boolean not null default true;
-- Новых RLS-политик не нужно: "own profile update" (db/phase1_profiles.sql, auth.uid() = id) уже
-- разрешает владельцу писать любые колонки СВОЕЙ строки — ровно так же клиент уже пишет
-- display_name и timezone (см. saveName/syncTimezoneAndActivity в auth.js). Дефолт '22:45' у всех
-- существующих строк означает, что поведение старых юзеров не меняется ни на минуту.

-- ПРАВИЛО «ЗА КАКОЙ ДЕНЬ ОТЧЁТ» — самое неочевидное место всей фазы, поэтому вынесено в отдельную
-- функцию, а не размазано по условиям: её зовут и ночная рассылка, и (через claim_summary_ondemand)
-- сводка по кнопке. Ключи внутри app_state.data (history/metricLog/checkinHistory/foodLog/
-- dayEvents/dayTasks) — обычные КАЛЕНДАРНЫЕ локальные даты: todayKey() в habbittracker.js
-- (`fdt(t.getFullYear(), t.getMonth(), t.getDate())`) переключается ровно в полночь. Поэтому для
-- «совы», которая просит сводку в 04:00, отчёт за (now)::date был бы отчётом за только что
-- начавшийся, почти пустой день. Правило: время РАНЬШЕ 12:00 понимается как «сводка за прошедший
-- день» (лёг под утро — его день закончился), 12:00 и позже — «за сегодня». Полдень взят границей
-- потому, что «итоги дня» в 11 утра за ещё не прожитый день бессмысленны при любом образе жизни,
-- а всё вечернее время (включая дефолтные 22:45) попадает в ветку «за сегодня».
create or replace function public.summary_report_date(p_local_date date, p_summary_time time)
returns date language sql immutable set search_path = public as $$
  select p_local_date - (case when p_summary_time < time '12:00' then 1 else 0 end);
$$;
revoke execute on function public.summary_report_date(date, time) from public, anon, authenticated;
grant execute on function public.summary_report_date(date, time) to service_role;

-- «Сколько минут прошло с момента отправки» — базовая арифметика для двух функций ниже; вынесена
-- отдельно ИМЕННО чтобы они не разъехались (см. баг с 23:45–23:59 в комментарии к
-- summary_anchor_date). Возвращает минуты от заданного времени до тика: 0 — точно в момент,
-- положительное — тик позже, -1 — тик на минуту раньше.
-- mod(..., 1440) нужен, чтобы счёт корректно переезжал через полночь (при summary_time = 23:55
-- тик в 00:00 «арифметически» на 1435 минут раньше, а не на 5 позже). Смещение +1441 (а не +1440)
-- сдвигает диапазон на минуту назад, чтобы «на минуту раньше» тоже считалось попаданием.
create or replace function public.summary_minutes_since(p_local_ts timestamp, p_summary_time time)
returns int language sql immutable set search_path = public as $$
  select mod(
    (extract(hour from p_local_ts)::int * 60 + extract(minute from p_local_ts)::int)
    - (extract(hour from p_summary_time)::int * 60 + extract(minute from p_summary_time)::int)
    + 1441, 1440) - 1;
$$;
revoke execute on function public.summary_minutes_since(timestamp, time) from public, anon, authenticated;
grant execute on function public.summary_minutes_since(timestamp, time) to service_role;

-- «Пора ли сейчас» — окно вокруг индивидуального summary_time. Cron тикает раз в 15 минут, а время
-- юзер может выбрать любое (в т.ч. 04:07), поэтому сравнивать «ровно равно» нельзя — нужно окно.
-- Ширина 17 минут ([-1 … +15]) = период cron (15) + 2 минуты запаса на дрейф/долгий холодный старт
-- функции: окно УЖЕ периода cron означало бы «в некоторые дни сводка просто не придёт», а это
-- худшая из двух возможных ошибок. Обратной проблемы (два тика попали в одно окно → два сообщения)
-- нет вовсе — от неё защищает last_summary_sent_local_date + FOR UPDATE SKIP LOCKED ниже.
create or replace function public.summary_due_now(p_local_ts timestamp, p_summary_time time)
returns boolean language sql immutable set search_path = public as $$
  select public.summary_minutes_since(p_local_ts, p_summary_time) < 16;
$$;
revoke execute on function public.summary_due_now(timestamp, time) from public, anon, authenticated;
grant execute on function public.summary_due_now(timestamp, time) to service_role;

-- ДАТА, К КОТОРОЙ ОТНОСИТСЯ ЭТОТ ТИК. Считать дату отчёта напрямую от даты тика НЕЛЬЗЯ, и это не
-- педантизм, а реальный баг: cron тикает в :00/:15/:30/:45, поэтому для любого summary_time из
-- 23:45–23:59 единственный тик, попадающий в окно, — это 00:00 УЖЕ СЛЕДУЮЩЕГО локального дня.
-- От даты тика отчёт получался бы за день, которому от роду полминуты (в нём ничего нет →
-- buildSummaryText вернёт null → сообщение не уйдёт), метка при этом сдвигалась бы вперёд, и юзер
-- не получал бы сводку НИКОГДА и молча. Поэтому сначала «отматываем» тик назад на те самые
-- summary_minutes_since минут — попадаем ровно в назначенный момент — и уже от него берём дату.
create or replace function public.summary_anchor_date(p_local_ts timestamp, p_summary_time time)
returns date language sql immutable set search_path = public as $$
  select (p_local_ts - make_interval(mins => public.summary_minutes_since(p_local_ts, p_summary_time)))::date;
$$;
revoke execute on function public.summary_anchor_date(timestamp, time) from public, anon, authenticated;
grant execute on function public.summary_anchor_date(timestamp, time) to service_role;

-- ГЛАВНЫЙ ИНВАРИАНТ ФАЗЫ: в last_summary_sent_local_date пишем НЕ текущую локальную дату (как
-- делала Фаза 12), а ДАТУ ОТЧЁТА. Только так «ровно один раз в день» продолжает работать при
-- времени после полуночи и — что важнее — при СМЕНЕ времени юзером на лету:
--   • сова, 04:00: 26-го в 04:00 отчёт за 25-е, метка = 25-е. 27-го в 04:00 дата отчёта 26-е > 25-е
--     → отправится. Повторный тик в то же окно даёт ту же дату 25-е, «< метки» ложно → не задвоится;
--   • переключился с 22:45 на 04:00 вечером 25-го, УЖЕ получив сводку за 25-е (метка = 25-е):
--     26-го в 04:00 дата отчёта = 25-е, не больше метки → второй отчёт за тот же день НЕ придёт;
--   • переключился с 04:00 на 22:45 днём 25-го (метка = 24-е после утренней отправки): вечером
--     25-го дата отчёта = 25-е > 24-е → отчёт за 25-е придёт, день не потеряется.
-- Если бы метка хранила календарную дату, оба перехода давали бы либо дубль, либо пропуск дня.
--
-- Возвращаемый тип поменялся (добавилась report_date), а CREATE OR REPLACE менять сигнатуру не
-- умеет («cannot change return type of existing function») — старую надо снести. DROP безопасен:
-- функцию зовёт только Edge Function send-daily-summary, ни триггеров, ни вьюх на ней нет.
drop function if exists public.get_and_mark_due_summaries();

create or replace function public.get_and_mark_due_summaries()
returns table(user_id uuid, telegram_id bigint, timezone text, report_date date)
language plpgsql security definer set search_path = public as $$
begin
  -- Как и в Фазе 8/12: имена OUT-параметров видны внутри тела наравне с колонками, поэтому всё
  -- квалифицируем через p./pr./due., иначе Postgres падает с "column reference is ambiguous".
  return query
  update public.profiles p
  set last_summary_sent_local_date = due.rep_date
  from (
    -- summary_anchor_date, а НЕ (now() at time zone tz)::date: см. коммент к ней выше — иначе
    -- «совы наоборот» (23:45–23:59) не получают сводку вообще никогда.
    select pr.id,
           public.summary_report_date(
             public.summary_anchor_date(now() at time zone pr.timezone, pr.summary_time),
             pr.summary_time) as rep_date
    from public.profiles pr
    where pr.timezone is not null
      and pr.telegram_id is not null
      and pr.summary_enabled
      and public.summary_due_now(now() at time zone pr.timezone, pr.summary_time)
      and (pr.last_summary_sent_local_date is null
           or pr.last_summary_sent_local_date
              < public.summary_report_date(
                  public.summary_anchor_date(now() at time zone pr.timezone, pr.summary_time),
                  pr.summary_time))
    for update skip locked
  ) due
  where p.id = due.id
  returning p.id, p.telegram_id, p.timezone, due.rep_date;
end $$;

revoke execute on function public.get_and_mark_due_summaries() from public, anon, authenticated;
grant execute on function public.get_and_mark_due_summaries() to service_role;

-- === СВОДКА ПО ЗАПРОСУ (кнопка «Прислать сводку сейчас» в профиле) ===
-- Антиспам живёт в ОТДЕЛЬНОЙ таблице, а не колонкой в profiles: у profiles есть политика
-- "own profile update", то есть юзер может писать в свою строку что угодно — включая обнуление
-- собственного лимита. Здесь политик нет ВООБЩЕ (тот же приём, что и у habit_reminder_sent,
-- Фаза 13) — доступ только у service_role (Edge Function), обойти лимит с клиента нельзя.
create table if not exists public.summary_ondemand_log (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now()
);
alter table public.summary_ondemand_log enable row level security;

-- Один вызов делает сразу три вещи: проверяет, что юзеру вообще есть куда слать, АТОМАРНО
-- занимает слот антиспама и отдаёт дату отчёта. Всё вместе — чтобы правило «за какой день»
-- и лимит не расползлись по TypeScript-у второй копией.
create or replace function public.claim_summary_ondemand(p_user uuid)
returns table(ok boolean, reason text, telegram_id bigint, report_date date)
language plpgsql security definer set search_path = public as $$
declare
  v_tg bigint;
  v_tz text;
  v_time time;
  v_local timestamp;
  v_claimed uuid;
begin
  select p.telegram_id, p.timezone, p.summary_time into v_tg, v_tz, v_time
  from public.profiles p where p.id = p_user;
  if not found then return query select false, 'no_profile'::text, null::bigint, null::date; return; end if;
  if v_tg is null then return query select false, 'no_telegram'::text, null::bigint, null::date; return; end if;
  if v_tz is null then return query select false, 'no_timezone'::text, null::bigint, null::date; return; end if;

  -- Атомарный «захват слота»: если строка уже есть и свежее минуты — ON CONFLICT ... WHERE не
  -- обновит ничего, RETURNING ничего не вернёт, v_claimed останется NULL. Именно INSERT ... ON
  -- CONFLICT, а не «сначала select, потом update» — два одновременных тапа по кнопке (дабл-тап по
  -- инерции на телефоне — реальный сценарий, см. историю с drag-ом в HANDOFF.md) иначе прошли бы оба.
  insert into public.summary_ondemand_log (user_id, sent_at) values (p_user, now())
  on conflict (user_id) do update set sent_at = now()
    where summary_ondemand_log.sent_at < now() - interval '60 seconds'
  returning summary_ondemand_log.user_id into v_claimed;
  if v_claimed is null then return query select false, 'too_often'::text, null::bigint, null::date; return; end if;

  v_local := now() at time zone v_tz;
  -- Правило «за какой день» для КНОПКИ чуть шире, чем для ночной рассылки: сове важно, нажав
  -- кнопку в 02:00, увидеть итоги вчерашнего (по её меркам ещё не закрытого) дня, а не пустой
  -- новый. Поэтому «прошедший день» берём, только если юзер и правда сова (summary_time < 12:00)
  -- И его время отсечки ещё не наступило. Днём и вечером кнопка всегда отдаёт ТЕКУЩИЙ день.
  -- Путаницы «а за какой это день?» не возникает в любом случае: дата написана прямо в заголовке
  -- сообщения (formatFullDate в supabase/functions/_shared/summaryText.ts).
  return query select true, null::text, v_tg,
    (v_local::date - case when v_time < time '12:00' and v_local::time < v_time then 1 else 0 end)::date;
end $$;

revoke execute on function public.claim_summary_ondemand(uuid) from public, anon, authenticated;
grant execute on function public.claim_summary_ondemand(uuid) to service_role;
