
-- ФАЗА 21 — «пуньк пуньк»: напоминание тому, кто не заходил в приложение дольше 12 часов.
-- Просьба юзера дословно: «сделай напоминалку для человека который не заходил в приложение дольше
-- 12 часов. пиши что то вроде "пуньк пуньк / где-же потерялся наш(а) сладкий пользователь <имя>"».
-- Выполнить в Supabase → SQL Editor → Run. Требует: Фазы 1 (profiles), Фазы 2 (stats.name — оттуда
-- берём имя, если юзер не задавал своё display_name), Фазы 5 (profiles.telegram_id), Фазы 8
-- (profiles.timezone / last_seen_at / last_reminder_sent_local_date).
--
-- ВАЖНО (как и в Фазах 8, 12, 13): планирование cron-задачи (cron.schedule) сюда НЕ входит — она
-- содержит секрет для аутентификации вызова Edge Function, а этот репозиторий публичный. Нужен ЕЩЁ
-- ОДИН отдельный pg_cron — каждые 15 минут (как у send-daily-reminders/send-daily-summary; окно тут
-- широкое, поминутная точность как у send-habit-reminders не нужна), дёргающий send-inactive-nudge
-- со своим X-Cron-Secret. Настраивается вручную через CLI, см. HANDOFF.md.

-- ДЕДУП ИДЁТ ПО last_reminder_sent_local_date (Фаза 8). Колонка last_summary_sent_local_date для
-- этого НЕ ГОДИТСЯ: с Фазы 20 там лежит ДАТА ОТЧЁТА (у «совы» с временем до полудня — вчерашняя),
-- а не дата отправки, так что сравнение с сегодняшним локальным днём давало бы ложные срабатывания.
--
-- Обе колонки пишет ТОЛЬКО сервер (Edge Function через service role внутри RPC ниже) — это анти-спам
-- память рассылки, а не пользовательские данные.
--   last_inactive_nudge_at  — когда последний раз пунькали;
--   inactive_nudge_count    — сколько пуньков уже ушло в ТЕКУЩЕЕ «отсутствие» (обнуляется само:
--                             если last_inactive_nudge_at < last_seen_at, значит юзер после пунька
--                             заходил, отсутствие новое, счёт начинается заново — отдельной
--                             операции сброса с клиента не нужно).
-- Наивная версия («last_seen_at старше 12 часов → шлём») перезапускалась бы на КАЖДОМ тике cron и
-- бомбила бы ушедшего юзера каждые 15 минут вечно — отсюда обе колонки и лимиты в WHERE ниже.
alter table public.profiles add column if not exists last_inactive_nudge_at timestamptz;
alter table public.profiles add column if not exists inactive_nudge_count int not null default 0;
-- Новых RLS-политик не нужно (как и в Фазе 8): "own profile update" из db/phase1_profiles.sql
-- позволяет владельцу писать любые колонки своей строки. Да, теоретически юзер может сам себе
-- проставить last_inactive_nudge_at в будущее и заглушить пуньки — это вред только самому себе,
-- отдельную column-level защиту ради этого не городим (тот же компромисс, что уже принят для
-- last_seen_at/timezone).

-- Атомарно выбирает всех, кому сейчас пора пунькнуть, и тут же помечает как отправленное —
-- FOR UPDATE ... SKIP LOCKED + UPDATE ... RETURNING в одном выражении защищают от двойной отправки,
-- если два тика cron когда-нибудь пересекутся (тот же приём, что в get_and_mark_due_reminders).
-- Имя тянем из profiles.display_name, а если юзер его не задавал — из stats.name (см. syncMyStats в
-- auth.js: туда всегда пишется display_name || defaultName(), то есть как минимум first_name из
-- Telegram). Может вернуться NULL — Edge Function на этот случай шлёт безымянный вариант текста.
create or replace function public.get_and_mark_due_inactive()
returns table(user_id uuid, telegram_id bigint, user_name text, nudge_count int)
language plpgsql security definer set search_path = public as $$
begin
  -- Как и в get_and_mark_due_reminders: имена OUT-параметров видны внутри тела наравне с колонками,
  -- поэтому всё обращение к колонкам — строго через алиасы p./pr./st./due., иначе Postgres падает
  -- с "column reference ... is ambiguous". OUT-параметры user_name/nudge_count названы НЕ так, как
  -- колонки (display_name/inactive_nudge_count), специально, чтобы конфликта не было вовсе.
  return query
  update public.profiles p
  set last_inactive_nudge_at = now(),
      -- В SET ссылки на p.* — это ещё СТАРЫЕ значения строки (а в RETURNING ниже — уже новые).
      inactive_nudge_count = case
        when p.last_inactive_nudge_at is null or p.last_inactive_nudge_at < p.last_seen_at then 1
        else p.inactive_nudge_count + 1
      end
  from (
    select pr.id,
           -- пустая строка/пробелы в display_name или stats.name — это фактически «имени нет»,
           -- поэтому nullif(btrim(...), ''), а не просто coalesce.
           coalesce(nullif(btrim(pr.display_name), ''), nullif(btrim(st.name), '')) as user_name
    from public.profiles pr
    left join public.stats st on st.id = pr.id
    where pr.timezone is not null
      and pr.telegram_id is not null
      -- Никогда не открывал приложение (last_seen_at null) — не пунькаем: от чего отсчитывать
      -- 12 часов, неизвестно, а сразу после регистрации это была бы просто грубость. Практически
      -- недостижимо: syncTimezoneAndActivity в auth.js пишет timezone и last_seen_at одним update.
      and pr.last_seen_at is not null
      and pr.last_seen_at < now() - interval '12 hours'
      -- ТИХИЕ ЧАСЫ. Юзер отсутствует сутками — момент отправки определяется тиком cron, а не
      -- поведением юзера, поэтому без этого условия «пуньк пуньк» прилетело бы кому-то в 04:00 по
      -- его времени. Шлём только 10:00–21:59 по ЛОКАЛЬНОМУ времени (profiles.timezone). Формат
      -- HH24:MI с ведущими нулями, поэтому строковое сравнение корректно ('09:59' < '10:00').
      and to_char(now() at time zone pr.timezone, 'HH24:MI') between '10:00' and '21:59'
      -- Не дублируем обычное вечернее напоминание 20:00 (Фаза 8): у него РОВНО та же аудитория
      -- («сегодня не заходил»), и без этого условия человек получил бы два сообщения за день.
      and (pr.last_reminder_sent_local_date is null
           or pr.last_reminder_sent_local_date < (now() at time zone pr.timezone)::date)
      -- АНТИ-СПАМ. Три случая, когда пунькать можно:
      --   1) ещё ни разу не пунькали;
      --   2) после последнего пунька юзер заходил (last_inactive_nudge_at < last_seen_at) — это уже
      --      НОВОЕ отсутствие, начинаем заново;
      --   3) отсутствие то же самое, но прошло больше 24 часов и пуньков в нём было меньше трёх.
      -- Итог: первый пуньк через 12 часов, потом максимум ещё два (примерно раз в сутки), дальше
      -- тишина до возвращения. Чисто «раз в 24 часа без лимита» превратило бы приложение в
      -- ежедневный спам для того, кто ушёл навсегда, — первый кандидат на блокировку бота.
      and (
        pr.last_inactive_nudge_at is null
        or pr.last_inactive_nudge_at < pr.last_seen_at
        or (pr.last_inactive_nudge_at < now() - interval '24 hours' and pr.inactive_nudge_count < 3)
      )
    -- FOR UPDATE OF pr (а не просто FOR UPDATE): блокировать нужно только строку profiles, а stats
    -- здесь на nullable-стороне LEFT JOIN — общий FOR UPDATE на такой стороне Postgres запрещает.
    for update of pr skip locked
  ) due
  where p.id = due.id
  returning p.id, p.telegram_id, due.user_name, p.inactive_nudge_count;
end $$;

-- Только Edge Function (service role) может дёргать эту функцию — обычным юзерам через RPC нельзя
-- (иначе кто угодно мог бы «сжечь» чужие пуньки, пометив их отправленными).
revoke execute on function public.get_and_mark_due_inactive() from public, anon, authenticated;
grant execute on function public.get_and_mark_due_inactive() to service_role;

-- === ОБРАТНАЯ СТОРОНА ДЕДУПА (выполнять вместе с блоком выше) ===
-- Обратная сторона дедупа: пуньк уже ушёл сегодня → вечернее напоминание 20:00 (Фаза 8) сегодня
-- пропускаем. Тело функции — точная копия из db/phase8_daily_reminders.sql, добавлено только
-- последнее условие. Держать ОБА файла в синхроне: если правишь окно 20:00 — правь здесь тоже.
create or replace function public.get_and_mark_due_reminders()
returns table(user_id uuid, telegram_id bigint)
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.profiles p
  set last_reminder_sent_local_date = (now() at time zone p.timezone)::date
  from (
    select pr.id from public.profiles pr
    where pr.timezone is not null and pr.telegram_id is not null
      and to_char(now() at time zone pr.timezone, 'HH24:MI') between '20:00' and '20:14'
      and (pr.last_seen_at is null or (pr.last_seen_at at time zone pr.timezone)::date < (now() at time zone pr.timezone)::date)
      and (pr.last_reminder_sent_local_date is null or pr.last_reminder_sent_local_date < (now() at time zone pr.timezone)::date)
      -- НОВОЕ (Фаза 21): сегодня уже пунькали — второй раз за день не трогаем.
      and (pr.last_inactive_nudge_at is null
           or (pr.last_inactive_nudge_at at time zone pr.timezone)::date < (now() at time zone pr.timezone)::date)
    for update skip locked
  ) due
  where p.id = due.id
  returning p.id, p.telegram_id;
end $$;

revoke execute on function public.get_and_mark_due_reminders() from public, anon, authenticated;
grant execute on function public.get_and_mark_due_reminders() to service_role;
