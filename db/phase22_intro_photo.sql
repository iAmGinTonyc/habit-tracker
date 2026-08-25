-- ФАЗА 22 — фото главного экрана переезжает вместе с юзером на другое устройство.
-- Юзер попросил: «сделай возможность в профиле настроить фотку главного экрана при открытии
-- приложения, где крупными буквами написано "live life". и сделай чтобы эта фотка была вместо
-- белого экрана при открытии приложения. её можно настраивать неограниченное кол-во раз».
-- Выполнить в Supabase → SQL Editor → Run. Требует Фазы 1 (auth.users/profiles).
--
-- ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ ПОЛЕ В app_state. app_state.data (Фаза 11) — это ВЕСЬ dashState
-- одним jsonb, и он уходит на сервер при КАЖДОМ изменении состояния (saveProgress →
-- window.syncAppState → pushAppState, дебаунс 1.5 с), а обратно прилетает realtime-событием на
-- все открытые устройства. Base64-картинка на 150-250 КБ внутри него означала бы эти же сотни
-- килобайт трафика на каждый поставленный чек-бокс — в мобильном интернете это заметно.
-- Здесь же строка читается ОДИН раз за сессию (loadIntroPhoto в auth.js) и пишется только когда
-- юзер реально сменил фото, поэтому размер картинки никого не беспокоит.
--
-- Почему не Supabase Storage: бакет нужно заводить руками в дашборде и настраивать ему отдельные
-- policies, а весь остальной проект настраивается ровно одним «прогони SQL в редакторе» (см. все
-- db/phase*.sql). Фото у нас и так уже сжато до 1080px/JPEG q=0.82 (readIntroPhotoAsDataUrl в
-- habbittracker.js) — это единицы сотен килобайт, для колонки text это нормально. Если снимков
-- когда-нибудь станет много (галерея заставок и т.п.) — вот тогда Storage.

create table if not exists public.user_media (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  -- data:image/jpeg;base64,… ; пустая строка/NULL = фото убрано, клиент вернётся к белому экрану.
  intro_photo text,
  updated_at  timestamptz not null default now()
);
alter table public.user_media enable row level security;

-- Строго своё и только своё: фото главного экрана — личная вещь, семье оно не показывается
-- (в отличие от stats/app_state, см. Фазу 19). Отдельной политики «друзья читают» тут нет намеренно.
drop policy if exists "user_media self all" on public.user_media;
create policy "user_media self all" on public.user_media
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.user_media from anon;
grant select, insert, update, delete on public.user_media to authenticated;

-- updated_at всегда ставит сервер — как и у app_state (Фаза 11) и family_share (Фаза 19):
-- полагаться на часы конкретного телефона нельзя.
create or replace function public.set_user_media_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists user_media_set_updated_at on public.user_media;
create trigger user_media_set_updated_at
  before insert or update on public.user_media
  for each row execute function public.set_user_media_updated_at();

-- ПРИМЕЧАНИЕ ПРО КОНФЛИКТЫ: мержа нет, побеждает последняя запись — как и у app_state. Для одной
-- картинки одного человека это ровно то, что нужно: поставил новое фото — оно и стоит везде.
-- Локальная копия в localStorage ('habbittracker_intro_photo') остаётся главным источником для
-- ПЕРВОЙ отрисовки (инлайн-скрипт в <head> index.html — иначе на старте мелькнёт белый экран),
-- а облако лишь досылает её на новом устройстве, уже после входа.
