-- ФАЗА 16 — «семья» была видна только одной стороне связи. invites.to_id = владелец кода,
-- from_id = тот, кто этот код ввёл; loadFamily() в auth.js читал ТОЛЬКО to_id=я, поэтому у
-- человека, который сам ввёл чужой код, счастливая половина отношений оседала на профиле
-- ДРУГОГО — с его стороны всё было видно, со своей стороны список был пуст. are_friends() и
-- синхронизация доступа (Фаза 9, revoke_family_access) и так всегда были симметричны — не
-- хватало только зеркального отображения в UI. Выполнить в Supabase → SQL Editor → Run. Требует
-- Фазы 3 (invites/are_friends) и Фазы 9 (revoke_family_access-триггер).

-- Раньше статус (принять/удалить из семьи) мог менять только to_id — RLS-политика "invites
-- respond" ниже. При двусторонней связи выйти из семьи или вернуться в неё должна мочь ЛЮБАЯ из
-- сторон, не только владелец кода. SECURITY DEFINER-функция вместо расширения RLS — так не
-- открываем клиенту прямой UPDATE над from_id/to_id (можно было бы переписать связь на чужого
-- пользователя), меняется только status, и только у своей же строки.
create or replace function public.set_family_status(row_id uuid, new_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if new_status not in ('accepted', 'pending') then
    raise exception 'invalid status: %', new_status;
  end if;
  update public.invites
    set status = new_status
    where id = row_id and (from_id = auth.uid() or to_id = auth.uid());
end; $$;
