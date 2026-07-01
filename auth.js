// === АККАУНТЫ (Supabase) — Фаза 1 ===
// Опциональный вход: трекер работает локально как раньше; вход добавляет облако/семью.
// Ключ publishable — публичный по дизайну (данные защищает RLS), его безопасно держать во фронте.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://sgsqgpthfufbbyukifbn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SpPL3tZYVTiUe1ViOkpi8g_VFoAfT9e';
// persistSession + autoRefreshToken → юзер остаётся залогинен между визитами:
// сессия хранится в localStorage, короткий access-токен сам обновляется по refresh-токену.
// Жёсткий лимит «сессия на месяц» задаётся в дашборде: Authentication → Sessions (time-box / inactivity).
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'habit_auth' }
});
window.sb = sb; // пригодится для следующих фаз (синк, семья)

const $ = (id) => document.getElementById(id);
let mode = 'login'; // 'login' | 'register'

function openModal() { $('auth-modal').classList.add('active'); }
function closeModal() { $('auth-modal').classList.remove('active'); }

function setMode(m) {
  mode = m;
  const reg = m === 'register';
  $('auth-title').textContent = reg ? 'Регистрация' : 'Вход';
  $('auth-submit').textContent = reg ? 'Создать аккаунт' : 'Войти';
  $('auth-toggle').textContent = reg ? 'Войти' : 'Зарегистрироваться';
  $('auth-switch-text').textContent = reg ? 'Уже есть аккаунт?' : 'Нет аккаунта?';
  $('auth-pass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  $('auth-err').textContent = '';
}

async function refresh() {
  const { data: { session } } = await sb.auth.getSession();
  const inUser = session && session.user;
  $('auth-form-wrap').style.display = inUser ? 'none' : 'block';
  $('auth-profile').style.display = inUser ? 'block' : 'none';
  $('profile-btn').classList.toggle('on', !!inUser);
  if (!inUser) return;
  $('prof-email').textContent = session.user.email || '';
  $('prof-id').textContent = '…';
  // профиль с invite_id создаётся триггером в БД при регистрации (см. SQL)
  const { data, error } = await sb.from('profiles').select('invite_id').eq('id', session.user.id).single();
  $('prof-id').textContent = (!error && data && data.invite_id) ? data.invite_id : 'нет профиля — запусти SQL в Supabase';
}

async function submit() {
  const email = $('auth-email').value.trim();
  const pass = $('auth-pass').value;
  const err = $('auth-err');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Введи email и пароль'; return; }
  if (mode === 'register' && pass.length < 6) { err.textContent = 'Пароль — минимум 6 символов'; return; }
  $('auth-submit').disabled = true;
  try {
    if (mode === 'register') {
      const { data, error } = await sb.auth.signUp({ email, password: pass });
      if (error) { err.textContent = error.message; return; }
      if (!data.session) { // включено подтверждение email
        err.textContent = 'Аккаунт создан. Подтверди email по ссылке из письма и войди.';
        setMode('login');
        return;
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) { err.textContent = error.message; return; }
    }
    await refresh();
  } catch (e) {
    err.textContent = 'Сеть недоступна, попробуй ещё раз';
  } finally {
    $('auth-submit').disabled = false;
  }
}

function wire() {
  $('profile-btn').addEventListener('click', openModal);
  $('auth-close').addEventListener('click', closeModal);
  $('auth-modal').addEventListener('click', (e) => { if (e.target === $('auth-modal')) closeModal(); });
  $('auth-toggle').addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
  $('auth-submit').addEventListener('click', submit);
  $('auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $('auth-logout').addEventListener('click', async () => { await sb.auth.signOut(); await refresh(); });
  $('prof-copy').addEventListener('click', () => {
    const id = $('prof-id').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(id);
    $('prof-copy').textContent = 'Скопировано';
    setTimeout(() => { $('prof-copy').textContent = 'Скопировать ID'; }, 1500);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  sb.auth.onAuthStateChange(() => refresh());
}

wire();
setMode('login');
refresh();
