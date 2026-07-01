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
let me = null, myEmail = null; // id/email залогиненного

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
  me = inUser ? session.user.id : null;
  myEmail = inUser ? (session.user.email || '') : null;
  if (!inUser) return;
  $('prof-email').textContent = myEmail;
  $('prof-id').textContent = '…';
  // профиль с invite_id создаётся триггером в БД при регистрации (см. db/phase1_profiles.sql)
  const { data, error } = await sb.from('profiles').select('invite_id').eq('id', me).single();
  $('prof-id').textContent = (!error && data && data.invite_id) ? data.invite_id : 'нет профиля — запусти SQL в Supabase';
  syncMyStats();  // отправить свою сводку в облако
  loadFamily();   // входящие приглашения + семья
}

// === СИНК СВОДКИ (Фаза 2) ===
let syncTimer = null;
function syncStats() { clearTimeout(syncTimer); syncTimer = setTimeout(syncMyStats, 1500); } // дебаунс
window.syncStats = syncStats;
async function syncMyStats() {
  if (!me || !window.getSummary) return;
  const s = window.getSummary();
  await sb.from('stats').upsert({
    id: me,
    name: myEmail ? myEmail.split('@')[0] : 'без имени',
    level: s.level, streak: s.streak, week_pct: s.weekPct, mood: s.mood,
    updated_at: new Date().toISOString()
  });
}

// === СЕМЬЯ (Фаза 3) ===
async function loadFamily() {
  if (!me) return;
  const { data: incoming } = await sb.from('invites').select('id, from_code').eq('to_id', me).eq('status', 'pending');
  renderIncoming(incoming || []);
  const { data: acc } = await sb.from('invites').select('from_id, to_id').eq('status', 'accepted'); // RLS вернёт только мои
  const friendIds = (acc || []).map(r => r.from_id === me ? r.to_id : r.from_id);
  if (!friendIds.length) { renderFamily([]); return; }
  const { data: fstats } = await sb.from('stats').select('*').in('id', friendIds);
  renderFamily(fstats || []);
}
async function sendInvite() {
  const code = $('fam-invite-input').value.trim().toUpperCase();
  const msg = $('fam-invite-msg');
  if (!code) return;
  msg.textContent = '…';
  const { data, error } = await sb.rpc('send_invite', { target_code: code });
  if (error) { msg.textContent = 'ошибка: ' + error.message; return; }
  const m = { sent: 'Приглашение отправлено', accepted: 'Он(а) уже звал(а) — теперь вы семья!', not_found: 'ID не найден', self: 'Это твой ID', already_friends: 'Вы уже семья' };
  msg.textContent = m[data] || data;
  $('fam-invite-input').value = '';
  loadFamily();
}
async function respondInvite(id, accept) {
  await sb.from('invites').update({ status: accept ? 'accepted' : 'declined' }).eq('id', id);
  loadFamily();
}
function renderIncoming(list) {
  const box = $('fam-incoming');
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="fam-h">Входящие приглашения</div>' + list.map(inv =>
    `<div class="fam-inv"><span>от <b>${inv.from_code || '—'}</b></span><span class="fam-inv-btns"><button class="fam-yes" data-id="${inv.id}" type="button">Принять</button><button class="fam-no" data-id="${inv.id}" type="button">Отклонить</button></span></div>`
  ).join('');
  box.querySelectorAll('.fam-yes').forEach(b => b.addEventListener('click', () => respondInvite(b.dataset.id, true)));
  box.querySelectorAll('.fam-no').forEach(b => b.addEventListener('click', () => respondInvite(b.dataset.id, false)));
}
function renderFamily(list) {
  const box = $('fam-list');
  if (!list.length) { box.innerHTML = '<div class="fam-empty">Пока никого. Пригласи по ID выше.</div>'; return; }
  box.innerHTML = '<div class="fam-h">Моя семья</div>' + list.map(s =>
    `<div class="fam-member"><div class="fam-name">${s.name || '—'}</div><div class="fam-stats"><span>ур. ${s.level ?? 0}</span><span>серия ${s.streak ?? 0}</span><span>${s.week_pct ?? 0}% за неделю</span>${s.mood != null ? `<span>настроение ${s.mood}/10</span>` : ''}</div></div>`
  ).join('');
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
  $('fam-invite-btn').addEventListener('click', sendInvite);
  $('fam-invite-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendInvite(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  sb.auth.onAuthStateChange(() => refresh());
}

wire();
setMode('login');
refresh();
