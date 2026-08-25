
-- ФАЗА 19 — «Редактировать доступ»: юзер сам выбирает, ЧТО именно из его трекера видит семья.
-- Юзер попросил: «сделай в блоке семьи, возможность нажать "редактировать доступ" и там сделай
-- попап, в котором можно выбрать что именно показывать семья, и еще сделай внутри кнопку "дать
-- полный доступ"». До сих пор семья видела ровно одно и то же у всех и без спроса: строку в
-- public.stats (серия / % за неделю / настроение / событие дня, Фазы 2-3 и 17) — её пускала
-- читать RLS-политика "stats friends read". Сам прогресс (app_state, Фаза 11) не был доступен
-- никому, кроме владельца, — политика "app_state self all".
--
-- ВАЖНО ПРО ГРАНУЛЯРНОСТЬ: настройка ОДНА НА ВСЮ СЕМЬЮ (одна строка на пользователя), а не
-- «отдельно для каждого члена семьи». Так это сформулировал юзер («что именно показывать
-- семья» — про семью целиком), и так честнее по UI: в семье обычно 1-3 человека, а отдельный
-- набор галочек на каждого превратил бы простой попап в матрицу 7×N. Тредофф осознанный: нельзя
-- показать сон жене и спрятать его от друга. Если это понадобится — расширяемся БЕЗ переделки:
-- добавляется nullable колонка member_id + уникальный индекс (user_id, member_id), строка с
-- member_id IS NULL остаётся дефолтом «для всей семьи», а family_allowed_keys() ниже получает
-- второй аргумент и предпочитает точечную строку общей. Ни RPC, ни клиент контракт не меняют.
--
-- Выполнить в Supabase → SQL Editor → New query → Run. Требует Фазы 1 (profiles), Фазы 2-3
-- (stats/invites/are_friends) и Фазы 11 (app_state).

-- 1) НАСТРОЙКИ ДОСТУПА. Отдельные boolean-колонки, а не одна jsonb-мапа: разделов мало и они
-- фиксированные, boolean-колонки самодокументированы, их видно в дашборде Supabase глазами и по
-- ним можно фильтровать/индексировать. Плата за это — новый раздел = новая миграция (alter table
-- add column), но именно так этот проект и живёт (Фазы 4/5/8/12/17 — сплошные add column).
create table if not exists public.family_share (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  -- «Дать полный доступ» из попапа. Отдельный флаг, а не «все галочки разом»: он значит «показывай
  -- ВСЁ, включая разделы, которых ещё нет» — новый раздел, добавленный будущей фазой, у такого
  -- юзера включится автоматически, а у остальных останется выключенным (privacy by default).
  full_access     boolean not null default false,
  -- Дефолты подобраны так, чтобы НИЧЕГО не сломать существующим семьям и при этом НЕ расширить
  -- доступ задним числом: включено ровно то, что семья и так уже видела до Фазы 19 (строка stats
  -- + СЕГОДНЯШНЕЕ событие дня из Фазы 17); всё остальное — данные, которые никогда никому не
  -- показывались, — выключено.
  share_stats     boolean not null default true,   -- серия / % за неделю / настроение (public.stats)
  -- ВНИМАНИЕ, тут ДВА разных флага, и путать их нельзя:
  --   share_day_event         — только СЕГОДНЯШНЯЯ заметка, та самая stats.day_event (Фаза 17),
  --                             которую семья видит в карточке профиля. Это ровно текущее
  --                             поведение, поэтому default true — выкатка ничего не меняет.
  --   share_day_event_history — ВЕСЬ архив app_state.dayEvents (дата → заметка) за всё время.
  --                             Совсем другой объём приватности: это личный дневник за год, а не
  --                             одна строка за сегодня. Только явное согласие, поэтому default false.
  -- Если склеить их в один флаг, применение этой миграции молча раскрыло бы семье всю историю
  -- заметок у КАЖДОГО, кто ни разу не открывал попап. Именно это и был бы «сломать существующим».
  share_day_event boolean not null default true,
  share_day_event_history boolean not null default false,
  share_habits    boolean not null default false,  -- задачи + история выполнения (habits/history)
  share_metrics   boolean not null default false,  -- показатели Pro mode (metrics/metricLog/metricTargets)
  share_checkin   boolean not null default false,  -- чек-ап: сон/настроение/энергия/здоровье (checkinHistory)
  share_food      boolean not null default false,  -- питание (foodLog/foodMealSlots/calorieLog/calorieTarget)
  share_day_tasks boolean not null default false,  -- задачи дня (dayTasks)
  updated_at      timestamptz not null default now()
);
alter table public.family_share enable row level security;

-- Читать/писать свою строку может только владелец. Политики «друзья читают» тут НАМЕРЕННО нет:
-- члену семьи незачем видеть чужие настройки приватности напрямую — всё, что ему положено знать
-- («какие разделы мне разрешены»), отдают SECURITY DEFINER-функции ниже уже в готовом виде.
drop policy if exists "family_share self all" on public.family_share;
create policy "family_share self all" on public.family_share
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.family_share from anon;
grant select, insert, update on public.family_share to authenticated;

-- updated_at ставит сервер, как и у app_state (Фаза 11) — клиенту незачем его слать.
create or replace function public.set_family_share_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists family_share_set_updated_at on public.family_share;
create trigger family_share_set_updated_at
  before insert or update on public.family_share
  for each row execute function public.set_family_share_updated_at();

-- 2) РАЗРЕШЁННЫЕ РАЗДЕЛЫ одним массивом ключей — ЕДИНСТВЕННОЕ место, где галочки превращаются в
-- список того, что реально отдаётся семье (её зовут и get_family_stats, и get_family_state ниже).
-- Ключи СОВПАДАЮТ с FAMILY_SHARE_CATS в auth.js и FAMILY_VIEW_TABS в habbittracker.js — один
-- словарь на три места, меняешь тут — правь и там.
-- Строки в family_share может ещё не быть (юзер ни разу не открывал попап) — тогда подставляем
-- ТЕ ЖЕ дефолты, что стоят в DDL выше (держать в синхроне!): семья продолжает видеть ровно то,
-- что видела до Фазы 19, и выкатка никому ничего не ломает.
-- Скалярные переменные, а не %rowtype-запись: композитный тип пришлось бы держать в публичном
-- API функции, а любое будущее `alter table ... add column` меняло бы её сигнатуру.
create or replace function public.family_allowed_keys(p_user uuid)
returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  v_full boolean; v_stats boolean; v_event boolean; v_event_hist boolean; v_habits boolean;
  v_metrics boolean; v_checkin boolean; v_food boolean; v_day_tasks boolean;
  keys text[] := '{}';
begin
  select fs.full_access, fs.share_stats, fs.share_day_event, fs.share_day_event_history,
         fs.share_habits, fs.share_metrics, fs.share_checkin, fs.share_food, fs.share_day_tasks
    into v_full, v_stats, v_event, v_event_hist,
         v_habits, v_metrics, v_checkin, v_food, v_day_tasks
    from public.family_share fs where fs.user_id = p_user;
  if not found then
    v_full := false; v_stats := true; v_event := true; v_event_hist := false; v_habits := false;
    v_metrics := false; v_checkin := false; v_food := false; v_day_tasks := false;
  end if;
  -- ::text ОБЯЗАТЕЛЕН у каждого литерала. Без него Postgres видит слева text[], справа строку
  -- НЕИЗВЕСТНОГО типа и выбирает перегрузку «массив ‖ массив», то есть пытается разобрать 'stats'
  -- как литерал массива — и падает в рантайме с «malformed array literal: "stats"». Синтаксически
  -- код при этом безупречен, никакой линтер/парсер это не поймает: ошибка проявляется только при
  -- вызове функции. Ровно на этом сломался список семьи после первого выката Фазы 19.
  if v_full or v_stats      then keys := keys || 'stats'::text;           end if;
  if v_full or v_event      then keys := keys || 'dayEvent'::text;        end if;
  if v_full or v_event_hist then keys := keys || 'dayEventHistory'::text; end if;
  if v_full or v_habits     then keys := keys || 'habits'::text;          end if;
  if v_full or v_metrics    then keys := keys || 'metrics'::text;         end if;
  if v_full or v_checkin    then keys := keys || 'checkin'::text;         end if;
  if v_full or v_food       then keys := keys || 'food'::text;            end if;
  if v_full or v_day_tasks  then keys := keys || 'dayTasks'::text;        end if;
  return keys;
end $$;

revoke execute on function public.family_allowed_keys(uuid) from public, anon, authenticated;

-- 3) СПИСОК СЕМЬИ ДЛЯ ПРОФИЛЯ. Раньше auth.js loadFamily() читал чужие строки напрямую:
-- sb.from('stats').select('*').in('id', acceptedIds) — это работало на политике
-- "stats friends read" (db/phase3_family.sql). Если оставить её, галочки в попапе будут
-- ДЕКОРАТИВНЫМИ: любой клиент (или просто curl с чужим JWT) всё равно получит полную строку
-- stats. Поэтому политику надо снять, а чтение перевести сюда — функция сама зануляет то, что
-- владелец запретил. Имя (name) отдаём ВСЕГДА: без него в списке семьи остались бы безымянные
-- строки, а имя юзер и так вводит в профиле именно как «Имя — видят друзья в семье».
--
-- СНЯТИЕ ПОЛИТИКИ ВЫНЕСЕНО В ОТДЕЛЬНЫЙ ФАЙЛ — db/phase19b_drop_stats_friends_read.sql.
-- Причина: пока Telegram-вебвью раздаёт СТАРЫЙ auth.js (он читает stats напрямую), снятая
-- политика опустошит список семьи у всех. Этот файл безопасно прогнать в любой момент: он только
-- ДОБАВЛЯЕТ таблицу и функции, ничего не ломая. Второй файл — уже после выката статики.

create or replace function public.get_family_stats()
returns table(
  member_id uuid,
  name      text,
  streak    int,
  week_pct  int,
  mood      int,
  day_event text,
  allowed   text[]
)
language sql stable security definer set search_path = public as $$
  select
    s.id,
    s.name,
    case when 'stats'    = any(ak.keys) then s.streak    end,
    case when 'stats'    = any(ak.keys) then s.week_pct  end,
    case when 'stats'    = any(ak.keys) then s.mood      end,
    case when 'dayEvent' = any(ak.keys) then s.day_event end,
    ak.keys
  from public.stats s
  -- lateral, а не семь вызовов family_allowed_keys(s.id) подряд — иначе функция считалась бы
  -- заново на каждую колонку каждой строки.
  cross join lateral (select public.family_allowed_keys(s.id) as keys) ak
  where public.are_friends(auth.uid(), s.id);
$$;

revoke execute on function public.get_family_stats() from public, anon;
grant execute on function public.get_family_stats() to authenticated;

-- 4) ЧУЖОЙ ПРОГРЕСС СРЕЗАМИ — то, что зовёт read-only вьюер «Посмотреть».
-- app_state — ОДИН jsonb-блоб под политикой "app_state self all" (Фаза 11): обычный юзер не может
-- прочитать чужую строку вообще никак, и это правильно — там лежит всё, включая то, что человек
-- показывать не собирался. Поэтому доступ идёт только через эту SECURITY DEFINER-функцию, и она
-- собирает ответ по БЕЛОМУ СПИСКУ ключей: любой новый ключ в dashState (см. habbittracker.js)
-- по умолчанию НЕ уедет в семью, пока его сюда явно не добавят. Чёрный список («отдать всё,
-- кроме…») тут был бы дырой на будущее.
-- Контракт (на него завязан вьюер):
--   аргумент: member_id uuid — id члена семьи;
--   возврат: null, если member_id пустой / это я сам / мы не семья (are_friends = false);
--   иначе jsonb: { member_id, name, allowed: [...ключи...], updated_at, data: { ...срез... } }
--   data пустой объект {}, если разделов не разрешено или человек ещё ни разу не синкал прогресс.
create or replace function public.get_family_state(member_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  keys     text[];
  src      jsonb;
  src_at   timestamptz;
  out_data jsonb := '{}'::jsonb;
  m_name   text;
begin
  if member_id is null then return null; end if;
  -- Свой же стейт читается напрямую (политика "app_state self all"), гонять его через RPC незачем;
  -- заодно это отсекает попытку «посмотреть себя чужими глазами» и получить лишнее.
  if member_id = auth.uid() then return null; end if;
  if not public.are_friends(auth.uid(), member_id) then return null; end if;

  keys := public.family_allowed_keys(member_id);
  select a.data, a.updated_at into src, src_at from public.app_state a where a.user_id = member_id;
  select s.name into m_name from public.stats s where s.id = member_id;

  if src is not null then
    -- Задачи: сам список (habits, включая разовые с type/date) + лог выполнения по дням.
    if 'habits' = any(keys) then
      out_data := out_data
        || jsonb_build_object('habits',  coalesce(src->'habits',  '[]'::jsonb))
        || jsonb_build_object('history', coalesce(src->'history', '{}'::jsonb));
    end if;
    -- Показатели Pro mode: список метрик, значения по дням и переопределённые цели.
    if 'metrics' = any(keys) then
      out_data := out_data
        || jsonb_build_object('metrics',       coalesce(src->'metrics',       '[]'::jsonb))
        || jsonb_build_object('metricLog',     coalesce(src->'metricLog',     '{}'::jsonb))
        || jsonb_build_object('metricTargets', coalesce(src->'metricTargets', '{}'::jsonb));
    end if;
    -- Чек-ап: только checkinHistory (постоянный лог). dashState.checkins — это ЧЕРНОВИК текущего
    -- дня, autoSaveCheckin коммитит его в checkinHistory[сегодня] сразу же (см. habbittracker.js),
    -- так что черновик семье не нужен и не отдаётся.
    if 'checkin' = any(keys) then
      out_data := out_data || jsonb_build_object('checkinHistory', coalesce(src->'checkinHistory', '{}'::jsonb));
    end if;
    -- Питание: обычный дневник (foodLog + порядок блоков) и калории Pro mode.
    if 'food' = any(keys) then
      out_data := out_data
        || jsonb_build_object('foodLog',       coalesce(src->'foodLog',       '{}'::jsonb))
        || jsonb_build_object('foodMealSlots', coalesce(src->'foodMealSlots', '{}'::jsonb))
        || jsonb_build_object('calorieLog',    coalesce(src->'calorieLog',    '{}'::jsonb))
        || jsonb_build_object('calorieTarget', coalesce(src->'calorieTarget', 'null'::jsonb));
    end if;
    -- ВЕСЬ архив заметок — только по отдельному флагу (см. share_day_event_history в DDL выше).
    -- 'dayEvent' сам по себе сюда НЕ пускает: он про одну сегодняшнюю строку в stats.day_event,
    -- которую отдаёт get_family_stats, а не про дневник за всё время.
    if 'dayEventHistory' = any(keys) then
      out_data := out_data || jsonb_build_object('dayEvents', coalesce(src->'dayEvents', '{}'::jsonb));
    end if;
    if 'dayTasks' = any(keys) then
      out_data := out_data || jsonb_build_object('dayTasks', coalesce(src->'dayTasks', '{}'::jsonb));
    end if;
    -- НЕ отдаётся никогда (и не должно): level/currentXP, unlockedGames/gameRecords, psychoMode,
    -- onboardingDone/seenHints, lastActiveDate, checkins-черновик.
  end if;

  return jsonb_build_object(
    'member_id',  member_id,
    'name',       m_name,
    'allowed',    to_jsonb(keys),
    'updated_at', src_at,
    'data',       out_data
  );
end $$;

revoke execute on function public.get_family_state(uuid) from public, anon;
grant execute on function public.get_family_state(uuid) to authenticated;

-- ПРИМЕЧАНИЕ: syncMyStats() в auth.js продолжает заливать в public.stats ВСЕ поля независимо от
-- галочек — и это правильно: фильтровать приватность на клиенте бессмысленно (клиент можно
-- подменить), а если юзер вернёт галочку обратно, семья сразу увидит актуальные цифры, а не
-- дырку за период, пока доступ был закрыт. Гейт живёт ровно в двух функциях выше.
-- ПРИМЕЧАНИЕ 2: notify-mood-alert (Фаза 15) ходит под service_role и RLS/эти функции не читает —
-- уведомление «отметил(а) низкое настроение» продолжит уходить семье даже при выключенной
-- «базовой статистике». Если это нежелательно — отдельная правка Edge Function (отдельная фаза).
