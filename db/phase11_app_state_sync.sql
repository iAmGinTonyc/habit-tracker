-- ФАЗА 11 — синхронизация ВСЕГО состояния трекера между устройствами. До сих пор облако (Фазы 1-3)
-- хранило только СВОДКУ для семьи (stats: уровень/серия/%/настроение) — сами привычки, история
-- выполнения, чек-апы, дневник питания и метрики Pro mode жили ТОЛЬКО в localStorage конкретного
-- браузера. Смена телефона/компьютера = потеря всего прогресса. Эта фаза зеркалит целиком
-- dashState (см. habbittracker.js) в одну jsonb-колонку — без нормализации на таблицы: юзер один,
-- конфликтов «два разных человека редактируют одновременно» не бывает, а нормализация ради одной
-- строки на пользователя была бы чистым усложнением.
-- Выполнить в Supabase → SQL Editor → Run. Требует уже применённой Фазы 1 (profiles/auth.users).

create table if not exists public.app_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security;

drop policy if exists "app_state self all" on public.app_state;
create policy "app_state self all" on public.app_state
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- updated_at всегда ставит СЕРВЕР, что бы клиент ни прислал — иначе last-write-wins (см. ниже)
-- зависел бы от точности часов конкретного телефона/компьютера, а рассинхрон в пару минут между
-- двумя устройствами — обычное дело. auth.js читает обратно именно это серверное значение
-- (.select('updated_at') после upsert), а не своё собственное.
create or replace function public.set_app_state_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists app_state_set_updated_at on public.app_state;
create trigger app_state_set_updated_at
  before insert or update on public.app_state
  for each row execute function public.set_app_state_updated_at();

-- Realtime — чтобы правка на одном устройстве сразу приезжала на другое (открытая вкладка/приложение)
-- без ручного обновления страницы, см. auth.js subscribeAppStateRealtime(). Если эта команда упадёт
-- (публикация называется иначе на вашем проекте) — включить то же самое можно вручную: Supabase
-- Dashboard → Database → Replication → найти таблицу app_state → включить тумблер.
alter publication supabase_realtime add table public.app_state;

-- Конфликты НЕ мержатся по полям — побеждает более свежая запись целиком (last-write-wins по
-- updated_at, см. auth.js loadAppState/applyCloudState). Для трекера одного человека этого
-- достаточно: одновременное редактирование с двух устройств — редкий и не критичный случай (просто
-- одна из двух правок победит), а честный merge потребовал бы версионирования каждого поля отдельно.
