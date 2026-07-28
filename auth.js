// === АККАУНТЫ (Supabase) — Фаза 1 ===
// Опциональный вход: трекер работает локально как раньше; вход добавляет облако/семью.
// Ключ publishable — публичный по дизайну (данные защищает RLS), его безопасно держать во фронте.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://sgsqgpthfufbbyukifbn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SpPL3tZYVTiUe1ViOkpi8g_VFoAfT9e';
let sb; // создаётся отложенно в boot() — см. причину ниже

const $ = (id) => document.getElementById(id);
let mode = 'login'; // 'login' | 'register'
let me = null, myEmail = null, myDisplayName = null; // id/email/кастомное имя залогиненного
let mandatory = false, onAuthed = null; // принудительный вход после тапа по заставке
window.familyMemberCount = 0; // до загрузки семьи/до входа — считаем «никого нет» (см. renderFamily)

const TIMED_OUT = Symbol('timeout');
// Защита от зависшего запроса к Supabase (см. коммент у boot()): если промис не резолвится за
// ms — не блокируем UI навсегда, продолжаем с TIMED_OUT вместо ответа.
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(TIMED_OUT), ms))]);
}
// Резервное чтение сессии напрямую из localStorage — на случай, если sb.auth.getSession() завис.
// Формат стабилен (стандартный Supabase-сейв под storageKey 'habit_auth').
function readStoredSession() {
  try {
    const raw = localStorage.getItem('habit_auth');
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && p.user && p.expires_at && p.expires_at > Date.now() / 1000) return p;
  } catch (e) {}
  return null;
}

function openModal() { $('auth-modal').classList.add('active'); }
function closeModal() { if (mandatory) return; $('auth-modal').classList.remove('active'); } // в mandatory-режиме не закрыть мимо входа

// === TELEGRAM MINI APP: обмен initData на настоящую Supabase-сессию ===
// Вызывается из habbittracker.js, когда приложение открыто внутри Telegram (см. HANDOFF.md §15).
// Дёргает Edge Function telegram-auth (supabase/functions/telegram-auth) — она проверяет initData
// на сервере (HMAC через токен бота, никогда не покидает бэкенд) и создаёт/находит Supabase-юзера
// по telegram_id, возвращает одноразовый token_hash. Клиент сам завершает вход через verifyOtp —
// так у Telegram-юзера появляется обычная Supabase-сессия, и уже готовые функции семьи/сводки
// (Фаза 2-3) работают БЕЗ изменений, как для обычного email-юзера.
// Объявлена на верхнем уровне модуля (не внутри boot()) — habbittracker.js может вызвать её раньше,
// чем отработает отложенный boot(); сама функция дожидается готовности sb внутри.
function waitForSb(triesLeft) {
  if (triesLeft === undefined) triesLeft = 100;
  return new Promise((resolve) => {
    (function check(n) {
      if (sb) { resolve(true); return; }
      if (n <= 0) { resolve(false); return; }
      setTimeout(() => check(n - 1), 100);
    })(triesLeft);
  });
}
async function telegramSignIn(initData) {
  const ready = await waitForSb();
  if (!ready) return { ok: false, error: 'sb_timeout' };
  try {
    const { data, error } = await sb.functions.invoke('telegram-auth', { body: { initData } });
    if (error || !data || data.error) return { ok: false, error: (error && error.message) || (data && data.error) || 'invoke_failed' };
    // ПРИМЕЧАНИЕ: type здесь должен соответствовать типу, с которым бэкенд вызвал generateLink
    // ('magiclink'). Если после деплоя verifyOtp падает с ошибкой типа — свериться с актуальной
    // документацией supabase-js (API этого угла менялась между версиями).
    const { error: otpErr } = await sb.auth.verifyOtp({ email: data.email, token_hash: data.hashed_token, type: 'magiclink' });
    if (otpErr) return { ok: false, error: otpErr.message };
    await refresh(); // подтягивает профиль/семью в UI, как после обычного логина
    // Открыт по реферальной ссылке (t.me/.../LiveLife?startapp=CODE) — start_param пришёл через
    // initData, Edge Function его просто передала обратно. send_invite должен идти С КЛИЕНТА
    // (под только что созданной сессией), не из Edge Function — RPC читает auth.uid() вызывающего,
    // а у service-role его нет. Тихо игнорируем ошибку (напр. "это свой же ID") — не критично.
    if (data.start_param) {
      try { await sb.rpc('send_invite', { target_code: data.start_param }); } catch (e) {}
    }
    return { ok: true, subscription: data.subscription };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
window.telegramSignIn = telegramSignIn;

// Кнопка «Повторить попытку входа» в #auth-checking (см. index.html) — на случай, если первая
// попытка при тапе по интро не удалась (сеть, ошибка Edge Function и т.п.), см. HANDOFF.md/refresh().
async function retryTelegramSignIn() {
  const btn = $('auth-retry-btn');
  btn.disabled = true;
  $('auth-checking-text').textContent = 'Входим через Telegram…';
  btn.style.display = 'none';
  try {
    const initData = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData;
    if (initData) await telegramSignIn(initData);
    else await refresh();
  } finally {
    btn.disabled = false;
  }
}

// Вызывается из habbittracker.js после тапа по заставке: показывает форму и НЕ пускает дальше,
// пока юзер не авторизуется (закрыть модалку X/бэкдропом/Esc нельзя, пока mandatory=true).
function requireAuth(cb) {
  if (me) { cb(); return; } // уже залогинен (напр., сбросил локальный прогресс) — не мучаем повторным входом
  mandatory = true;
  onAuthed = cb;
  $('auth-modal').classList.add('mandatory');
  setMode('register'); // новый юзер — по умолчанию регистрация; переключиться на вход можно
  openModal();
}

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

// Продукт — Telegram-only (решено 22.07.2026): идентичность всегда из Telegram initData, форма
// email/пароля (auth-form-wrap) больше НИКОГДА не показывается — код оставлен нетронутым
// (hide, не delete), просто недостижим, т.к. habbittracker.js блокирует не-Telegram визиты
// экраном-заглушкой раньше, чем эта модалка вообще может открыться.
function tgUser() {
  try { return window.Telegram.WebApp.initDataUnsafe.user || null; } catch (e) { return null; }
}
function tgDisplayId() {
  const tu = tgUser();
  if (tu) return tu.username ? ('@' + tu.username) : (tu.first_name || 'Telegram');
  return myEmail || '—';
}

async function refresh() {
  // Пока не знаем статус входа — показываем нейтральное «Входим…», а НЕ форму входа по
  // умолчанию. Иначе при быстром клике на «Профиль» (модалка открывается раньше, чем refresh()
  // успевает отработать) юзер видит форму входа, которая через секунду подменяется профилем —
  // выглядит как «перелогинь меня» (баг, о котором сообщил юзер).
  $('auth-checking').style.display = 'block';
  $('auth-checking-text').textContent = 'Входим через Telegram…';
  $('auth-retry-btn').style.display = 'none';
  $('auth-form-wrap').style.display = 'none';
  $('auth-profile').style.display = 'none';

  let session = null;
  const r = await withTimeout(sb.auth.getSession(), 4000);
  if (r === TIMED_OUT) {
    console.warn('⚠️ sb.auth.getSession() завис — читаю сессию напрямую из localStorage');
    session = readStoredSession();
  } else {
    session = r.data.session;
  }
  const inUser = session && session.user;
  $('auth-form-wrap').style.display = 'none';
  $('auth-profile').style.display = inUser ? 'block' : 'none';
  $('profile-btn').classList.toggle('on', !!inUser);
  me = inUser ? session.user.id : null;
  myEmail = inUser ? (session.user.email || '') : null;
  if (!inUser) {
    // Раньше тут навсегда оставался текст «Входим…» — если сессия так и не появилась (сеть,
    // ошибка Edge Function telegram-auth и т.п.), юзер видел бесконечный спиннер без выхода
    // (баг, на который пожаловался юзер). Теперь — понятная ошибка + кнопка повторить.
    $('auth-checking').style.display = 'block';
    $('auth-checking-text').textContent = 'Не удалось подтвердить вход через Telegram. Проверь соединение и попробуй ещё раз.';
    $('auth-retry-btn').style.display = 'block';
    return;
  }
  $('auth-checking').style.display = 'none';
  $('prof-email').textContent = tgDisplayId();
  $('prof-id').textContent = '…';
  // профиль с invite_id создаётся триггером в БД при регистрации (см. db/phase1_profiles.sql)
  const pr = await withTimeout(sb.from('profiles').select('invite_id, display_name').eq('id', me).single(), 4000);
  if (pr === TIMED_OUT) { $('prof-id').textContent = 'не удалось загрузить (обнови страницу)'; }
  else {
    const { data, error } = pr;
    $('prof-id').textContent = (!error && data && data.invite_id) ? data.invite_id : 'нет профиля — запусти SQL в Supabase';
    myDisplayName = (!error && data && data.display_name) ? data.display_name : null;
    $('prof-name-input').value = myDisplayName || defaultName();
  }
  syncMyStats();  // отправить свою сводку в облако
  loadFamily();   // входящие приглашения + семья
  loadSubscription(); // статус триала/подписки
}

const defaultName = () => {
  const tu = tgUser();
  if (tu) return tu.first_name || tu.username || 'без имени';
  return myEmail ? myEmail.split('@')[0] : 'без имени';
};

async function saveName() {
  const val = $('prof-name-input').value.trim();
  const msg = $('prof-name-msg');
  if (!val) { msg.textContent = 'Имя не может быть пустым'; return; }
  $('prof-name-save').disabled = true;
  const { error } = await sb.from('profiles').update({ display_name: val }).eq('id', me);
  $('prof-name-save').disabled = false;
  if (error) { msg.textContent = 'Ошибка: ' + error.message; return; }
  myDisplayName = val;
  msg.textContent = 'Сохранено';
  setTimeout(() => { if (msg.textContent === 'Сохранено') msg.textContent = ''; }, 2000);
  syncMyStats(); // сразу обновить имя в сводке, которую видит семья
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
    name: myDisplayName || defaultName(),
    level: s.level, streak: s.streak, week_pct: s.weekPct, mood: s.mood,
    updated_at: new Date().toISOString()
  });
}

// === ПОДПИСКА (Stars) ===
// Цены здесь — ТОЛЬКО для отображения юзеру; реальная сумма списывается на бэке
// (create-invoice/index.ts) — если меняешь цену, поправь ОБА места (см. HANDOFF.md §15).
const PRICE_PERSONAL_STARS = 250;
const PRICE_FAMILY_PER_PERSON_STARS = 300;
let selectedPlan = null;

async function loadSubscription() {
  if (!me) return;
  const r = await withTimeout(sb.from('subscriptions').select('*').eq('user_id', me).maybeSingle(), 4000);
  if (r === TIMED_OUT || !r.data) { $('sub-status').textContent = '—'; window.hasActiveSubscription = false; return; }
  const s = r.data;
  const fmt = (iso) => iso ? new Date(iso).toLocaleDateString('ru-RU') : '';
  // Pro mode (habbittracker.js) читает этот флаг напрямую — активная подписка (любой план)
  // снимает пейволл с тумблера. Не трогает free-триал: он про сам трекер, не про Pro mode.
  window.hasActiveSubscription = s.status === 'active';
  if (s.status === 'active') {
    $('sub-status').textContent = s.plan === 'family'
      ? `Family (${s.family_size} чел.) до ${fmt(s.expires_at)}`
      : `Personal до ${fmt(s.expires_at)}`;
  } else if (s.status === 'trial') {
    const started = new Date(s.trial_started_at).getTime();
    const daysLeft = 7 - Math.floor((Date.now() - started) / 86400000);
    $('sub-status').textContent = daysLeft > 0 ? `Триал — ещё ${daysLeft} дн.` : 'Триал закончился';
  } else {
    $('sub-status').textContent = 'Подписка истекла';
  }
}

function updateFamilyPriceLabel() {
  const size = Math.max(2, Math.min(10, Number($('sub-family-size').value) || 2));
  const total = size * PRICE_FAMILY_PER_PERSON_STARS;
  $('sub-plan-family').querySelector('.sub-price').textContent = `${size}×${PRICE_FAMILY_PER_PERSON_STARS} = ${total} Stars/мес`;
}

function selectPlan(plan) {
  selectedPlan = plan;
  $('sub-plan-personal').classList.toggle('active', plan === 'personal');
  $('sub-plan-family').classList.toggle('active', plan === 'family');
  $('sub-family-size-row').style.display = plan === 'family' ? 'flex' : 'none';
  $('sub-buy-btn').style.display = 'block';
  $('sub-msg').textContent = '';
  if (plan === 'family') updateFamilyPriceLabel();
}

// Понятные тексты для кодов ошибок, которые отдают create-invoice/telegram-auth (см. их index.ts).
// Без этой карты юзер видел только общее "Edge Function returned a non-2xx status code" —
// supabase-js всегда пишет именно эту фразу в error.message при non-2xx, реальная причина лежит в
// теле ответа (error.context — исходный Response), а не в error.message.
const FUNCTION_ERROR_MESSAGES = {
  not_authenticated: 'Не удалось подтвердить вход через Telegram. Открой профиль (значок сверху), дождись, пока пропадёт «Входим через Telegram…», и попробуй снова',
  server_misconfigured_no_bot_token: 'Оплата временно недоступна на сервере',
  bad_plan: 'Неверный план подписки',
  telegram_api_error: 'Telegram отклонил создание счёта',
  unexpected: 'Непредвиденная ошибка сервера',
};
async function readFunctionErrorBody(error) {
  if (!error || !error.context || typeof error.context.json !== 'function') return null;
  try { return await error.context.clone().json(); } catch (e) { return null; }
}

// Общая покупка — используется и профильной формой (Personal/Family с выбором размера), и
// одноклиночным пейволлом Pro mode (см. openProModePaywall в habbittracker.js). msgEl/btnEl —
// опциональные DOM-элементы для статуса/дизейбла, можно вызывать вообще без UI-обвязки.
async function purchasePlan(plan, familySize, msgEl, btnEl) {
  if (btnEl) btnEl.disabled = true;
  if (msgEl) msgEl.textContent = 'Готовим счёт…';
  try {
    const body = { plan };
    if (plan === 'family') body.familySize = familySize || 2;
    const { data, error } = await sb.functions.invoke('create-invoice', { body });
    if (error || !data || data.error) {
      let code = data && data.error;
      let detail = data && data.detail;
      if (error && !code) { const errBody = await readFunctionErrorBody(error); if (errBody) { code = errBody.error; detail = errBody.detail; } }
      const friendly = FUNCTION_ERROR_MESSAGES[code];
      if (msgEl) msgEl.textContent = 'Ошибка: ' + (friendly || detail || code || (error && error.message) || 'не удалось создать счёт');
      return;
    }
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openInvoice) {
      window.Telegram.WebApp.openInvoice(data.link, (status) => {
        if (status === 'paid') { if (msgEl) msgEl.textContent = 'Оплачено! Обновляем статус…'; setTimeout(loadSubscription, 1500); }
        else if (status === 'cancelled') { if (msgEl) msgEl.textContent = 'Отменено'; }
        else if (status === 'failed') { if (msgEl) msgEl.textContent = 'Платёж не прошёл'; }
        else if (msgEl) msgEl.textContent = '';
      });
    } else {
      window.open(data.link, '_blank'); // вне Telegram (тестирование) — просто открыть ссылку
    }
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Сеть недоступна, попробуй ещё раз';
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}
async function buySubscription() {
  if (!selectedPlan) return;
  const size = selectedPlan === 'family' ? (Number($('sub-family-size').value) || 2) : null;
  await purchasePlan(selectedPlan, size, $('sub-msg'), $('sub-buy-btn'));
}
// Вызывается из пейволла Pro mode (habbittracker.js) — покупка в один клик, без открытия
// профильной формы. Family всё равно просит размер семьи (цена от него зависит), но остаётся
// в том же модальном окне — не «в один клик» в буквальном смысле, а в два (задать число, купить).
window.buyPersonalPlanOneClick = (msgElId, btnElId) => purchasePlan('personal', null, document.getElementById(msgElId), document.getElementById(btnElId));
window.buyFamilyPlanOneClick = (familySize, msgElId, btnElId) => purchasePlan('family', familySize, document.getElementById(msgElId), document.getElementById(btnElId));
window.shareInviteLink = shareInviteLink;

// === РЕФЕРАЛЬНАЯ ССЫЛКА ЧЕРЕЗ TELEGRAM (заменяет ручной ввод ID для приглашения близкого) ===
// Ссылка вида t.me/BOT/APP?startapp=CODE — при открытии Telegram передаёт CODE в initData как
// start_param, дальше telegramSignIn() сам примет приглашение через send_invite (см. выше).
const BOT_USERNAME = 'livelife_tracker_bot';
const APP_SHORT_NAME = 'LiveLife';
function shareInviteLink() {
  const inviteId = $('prof-id').textContent;
  if (!inviteId || inviteId === '…' || inviteId.indexOf(' ') !== -1) return; // не готово/ошибка — не шарим мусор
  const link = `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${inviteId}`;
  const text = 'Присоединяйся ко мне в LiveLife — трекере жизни';
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openTelegramLink) {
    window.Telegram.WebApp.openTelegramLink(shareUrl);
  } else {
    window.open(shareUrl, '_blank');
  }
}

// === СЕМЬЯ (Фаза 3) ===
async function loadFamily() {
  if (!me) return;
  const r1 = await withTimeout(sb.from('invites').select('id, from_code').eq('to_id', me).eq('status', 'pending'), 4000);
  if (r1 === TIMED_OUT) return; // сеть подвисла — тихо выходим, следующий refresh() попробует снова
  renderIncoming(r1.data || []);
  const r2 = await withTimeout(sb.from('invites').select('from_id, to_id').eq('status', 'accepted'), 4000); // RLS вернёт только мои
  if (r2 === TIMED_OUT) return;
  const friendIds = (r2.data || []).map(r => r.from_id === me ? r.to_id : r.from_id);
  if (!friendIds.length) { renderFamily([]); return; }
  const r3 = await withTimeout(sb.from('stats').select('*').in('id', friendIds), 4000);
  if (r3 === TIMED_OUT) return;
  renderFamily(r3.data || []);
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
  // Читается пейволлом Pro mode (habbittracker.js) — пока в семье никого нет, покупка Family
  // недоступна (план дешевле именно ЗА СЧЁТ нескольких человек, покупать его в одиночку не имеет
  // смысла): кнопка получает текст «Купить Family недоступно» и дизейблится.
  window.familyMemberCount = list.length;
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
    if (mandatory) { // вход пройден — снимаем принудительный режим и пускаем дальше
      const cb = onAuthed;
      mandatory = false; onAuthed = null;
      $('auth-modal').classList.remove('mandatory');
      closeModal();
      if (cb) cb();
    }
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
  $('auth-retry-btn').addEventListener('click', retryTelegramSignIn);
  $('sub-plan-personal').addEventListener('click', () => selectPlan('personal'));
  $('sub-plan-family').addEventListener('click', () => selectPlan('family'));
  $('sub-family-size').addEventListener('input', updateFamilyPriceLabel);
  $('sub-buy-btn').addEventListener('click', buySubscription);
  $('prof-share').addEventListener('click', shareInviteLink);
  $('prof-copy').addEventListener('click', () => {
    const id = $('prof-id').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(id);
    $('prof-copy').textContent = 'Скопировано';
    setTimeout(() => { $('prof-copy').textContent = 'Скопировать ID'; }, 1500);
  });
  $('prof-name-save').addEventListener('click', saveName);
  $('prof-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
  $('fam-invite-btn').addEventListener('click', sendInvite);
  $('fam-invite-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendInvite(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  sb.auth.onAuthStateChange(() => refresh());
}

// Клиент создаём ОТЛОЖЕННО (после window 'load' + доп. задержка), а не сразу при выполнении
// модуля. Эмпирически подтверждено (2 CDN-сборки, повторяемо): если создать Supabase-клиент
// синхронно в теле module-скрипта и сразу восстановить сессию из localStorage, ВСЕ его вызовы
// (getSession/.from/.rpc) зависают НАВСЕГДА — без ошибки, без сетевого запроса, без Web Lock
// (navigator.locks.query() пуст). Тот же клиент, созданный чуть позже (после полной загрузки
// страницы), работает мгновенно. Причина похожа на баг браузерного окружения/CDP-таймингов,
// не в нашем коде — воспроизводили точечно через navigator.locks.request() (работает изолированно)
// и autoRefreshToken:false (не помогает само по себе). Если апстрим починят — можно попробовать убрать.
function boot() {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'habit_auth' }
  });
  window.sb = sb;
  window.requireAuth = requireAuth;
  wire();
  setMode('login');
  refresh();
}
if (document.readyState === 'complete') setTimeout(boot, 0);
else window.addEventListener('load', () => setTimeout(boot, 0));
