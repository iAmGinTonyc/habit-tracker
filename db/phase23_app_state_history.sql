-- ФАЗА 23 — история версий app_state: страховка от «синхронизировался с другим устройством и
-- потерял месяц».
--
-- ЧТО СЛУЧИЛОСЬ 25.08.2026 (не повторять и не забывать). Синхронизация состояния (Фаза 11) —
-- last-write-wins по одной строке на пользователя: побеждает более свежая запись ЦЕЛИКОМ, без
-- мержа по полям. Юзер случайно открыл приложение на втором устройстве с почти пустым состоянием,
-- оно оказалось «свежее», и облако вместе со всеми устройствами уехало на урезанную версию:
-- в app_state остались 1-10 августа и 25-е, а 11-24 исчезли во ВСЕХ разделах сразу (чек-ап,
-- задачи, питание, события дня, показатели). Размер состояния упал до 3.5 КБ.
--
-- Единственной защитой был ОДИН слот в localStorage (habbittracker_progress_backup, см.
-- applyCloudState/checkForBackupRestore в habbittracker.js). Он не спас по двум причинам:
-- живёт только на том устройстве, где произошла перезапись, и САМ СЕБЯ затирает при каждой
-- следующей синхронизации — то есть окно на восстановление измеряется часами.
-- На сервере же не хранилось НИЧЕГО: одна строка, без версий. Откатывать было физически неоткуда.
--
-- Эта фаза добавляет серверную историю. Прошлые потери она не вернёт — только закрывает дыру на
-- будущее. Выполнить в Supabase → SQL Editor → Run. Требует Фазы 11 (app_state).

create table if not exists public.app_state_history (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  data         jsonb not null,        -- ПРЕДЫДУЩАЯ версия состояния, та, которую перезаписали
  prev_updated_at timestamptz,        -- каким был app_state.updated_at у этой версии
  replaced_at  timestamptz not null default now(),
  -- Длина в символах JSON — грубый, но честный индикатор «состояние резко похудело». Держим
  -- колонкой, чтобы искать подозрительные перезаписи одним взглядом, без разворачивания jsonb.
  size_chars   int not null
);
create index if not exists app_state_history_user_time
  on public.app_state_history (user_id, replaced_at desc);

alter table public.app_state_history enable row level security;

-- Читать свою историю владелец может (на этом можно построить экран «версии» в приложении).
-- Писать/удалять — НИКТО: строки кладёт только триггер ниже, он SECURITY DEFINER. Политики на
-- insert/update/delete нет намеренно — иначе клиент мог бы подчистить собственную страховку.
drop policy if exists "app_state_history self read" on public.app_state_history;
create policy "app_state_history self read" on public.app_state_history
  for select using (user_id = auth.uid());

revoke all on public.app_state_history from anon;
grant select on public.app_state_history to authenticated;

-- КОГДА СНИМАЕМ СЛЕПОК. Наивное «на каждый UPDATE» не годится: app_state перезаписывается на
-- каждое сохранение прогресса (дебаунс 1.5 с, см. pushAppState в auth.js), и за день активного
-- пользования набежали бы тысячи строк по 3-100 КБ. Правило из двух условий:
--   1) прошёл час с прошлого слепка — обычная периодическая страховка;
--   2) состояние РЕЗКО ПОХУДЕЛО (>10% символов) — ровно тот случай, ради которого фаза и написана;
--      такой слепок делаем ВСЕГДА, даже если предыдущий был минуту назад.
-- Итого: спокойный день — до 24 строк, подозрительная перезапись — гарантированно зафиксирована.
create or replace function public.snapshot_app_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  old_len int;
  new_len int;
  last_at timestamptz;
  shrank  boolean;
begin
  -- Клиент иногда пишет то же самое (повторный push после реалтайма) — такие UPDATE пропускаем.
  if old.data is not distinct from new.data then
    return new;
  end if;

  old_len := length(old.data::text);
  new_len := length(new.data::text);
  shrank  := new_len < old_len * 0.9;

  select h.replaced_at into last_at
    from public.app_state_history h
   where h.user_id = old.user_id
   order by h.replaced_at desc
   limit 1;

  if shrank or last_at is null or last_at < now() - interval '1 hour' then
    insert into public.app_state_history (user_id, data, prev_updated_at, size_chars)
    values (old.user_id, old.data, old.updated_at, old_len);

    -- Держим последние 50 слепков на человека. Удаляем ТОЛЬКО свои строки (user_id в подзапросе) —
    -- без этого условия чистка одного юзера выносила бы историю всех остальных.
    delete from public.app_state_history h
     where h.user_id = old.user_id
       and h.id not in (
         select h2.id from public.app_state_history h2
          where h2.user_id = old.user_id
          order by h2.replaced_at desc, h2.id desc
          limit 50
       );
  end if;

  return new;
end $$;

-- AFTER, а не BEFORE: история — побочный эффект, ей незачем вмешиваться в саму записываемую
-- строку. Отдельный триггер от app_state_set_updated_at (Фаза 11) — тот BEFORE и ставит updated_at,
-- их порядок и назначение не пересекаются.
drop trigger if exists app_state_snapshot on public.app_state;
create trigger app_state_snapshot
  after update on public.app_state
  for each row execute function public.snapshot_app_state();

-- === КАК ВОССТАНАВЛИВАТЬСЯ (держать под рукой, это и есть смысл фазы) ===
--
-- 1) Посмотреть версии конкретного человека, самые свежие сверху. Резкое падение size_chars —
--    это и есть момент, когда что-то затёрло состояние:
--
--    select id, replaced_at, prev_updated_at, size_chars
--    from public.app_state_history
--    where user_id = 'UUID'
--    order by replaced_at desc;
--
-- 2) Заглянуть внутрь конкретной версии, не восстанавливая её:
--
--    select k as день from public.app_state_history h,
--      lateral jsonb_object_keys(h.data->'checkinHistory') k
--    where h.id = ЧИСЛО order by 1 desc;
--
-- 3) Откатить состояние на выбранную версию. Текущая версия при этом сама уедет в историю
--    (сработает триггер выше), так что шаг обратим:
--
--    update public.app_state a
--    set data = (select h.data from public.app_state_history h where h.id = ЧИСЛО)
--    where a.user_id = 'UUID';
--
--    ВАЖНО: после этого на КАЖДОМ устройстве юзера нужно открыть приложение — оно увидит, что
--    облако свежее локального, и подтянет восстановленную версию (applyCloudState, Фаза 11).
--    Пока устройство не открыли, оно продолжает держать свою старую копию и при следующем
--    сохранении может снова перезаписать облако — last-write-wins никуда не делся.
