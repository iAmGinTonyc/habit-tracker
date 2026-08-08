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
window.familyMemberCount = 0; // до загрузки семьи/до входа — считаем «никого нет» (см. renderFamilyMembers)

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
// Причина последней неудачной попытки входа — читается в refresh(), чтобы показать её прямо в
// UI (не только в консоли), т.к. юзер сообщил «всё ещё не могу зайти», а без текста причины
// невозможно понять, это HMAC/бот-токен/сеть/что-то ещё, не имея доступа к логам его Supabase.
let lastTelegramSignInError = null;
async function telegramSignIn(initData) {
  const ready = await waitForSb();
  if (!ready) { lastTelegramSignInError = 'sb_timeout'; return { ok: false, error: 'sb_timeout' }; }
  try {
    // Оба вызова ниже — sb.functions.invoke и sb.auth.verifyOtp — раньше не были ничем ограничены
    // по времени. Есть задокументированный баг окружения (см. коммент у boot()): самый первый
    // sb.auth.* вызов может зависнуть навсегда (проблема с navigator.locks в самом supabase-js/
    // браузере, не в нашем коде) — без таймаута юзер застревал на «Входим через Telegram…»
    // НАВСЕГДА, без текста ошибки и кнопки повтора (репортнутый баг «не грузит, не открыть
    // профиль» после жалобы юзера 30.07.2026).
    const invokeRes = await withTimeout(sb.functions.invoke('telegram-auth', { body: { initData } }), 8000);
    if (invokeRes === TIMED_OUT) { lastTelegramSignInError = 'Сервер входа не ответил за 8 секунд (сеть/бэкенд)'; return { ok: false, error: lastTelegramSignInError }; }
    const { data, error } = invokeRes;
    if (error || !data || data.error) {
      // Как и в purchasePlan — error.message тут почти всегда общее "Edge Function returned a
      // non-2xx status code" (см. FUNCTION_ERROR_MESSAGES ниже), реальный код лежит в теле ответа
      // (error.context), а не в message. Достаём его, иначе не видно, ПОЧЕМУ вход не прошёл —
      // именно это мешало диагностировать баг «всё ещё не могу зайти через телеграм».
      let code = data && data.error;
      let detail = data && data.detail;
      if (error && !code) { const errBody = await readFunctionErrorBody(error); if (errBody) { code = errBody.error; detail = errBody.detail; } }
      const reason = FUNCTION_ERROR_MESSAGES[code] || detail || code || (error && error.message) || 'invoke_failed';
      console.warn('telegramSignIn: ошибка telegram-auth —', code || '(нет кода)', '/', reason);
      lastTelegramSignInError = reason;
      return { ok: false, error: reason };
    }
    // ПРИМЕЧАНИЕ: type здесь должен соответствовать типу, с которым бэкенд вызвал generateLink
    // ('magiclink'). НЕ передавать email вместе с token_hash — текущий supabase-js (грузится с
    // CDN как @2, т.е. всегда последняя minor-версия) валидирует их как ВЗАИМОИСКЛЮЧАЮЩИЕ пути
    // верификации (email+token — для 6-значного OTP-кода, token_hash — сам по себе) и падает с
    // «Only the token_hash and type should be provided», если оба присутствуют одновременно —
    // это и было настоящей причиной «не входит через Telegram» (баг 30.07.2026, найден по тексту
    // ошибки, который стал виден только после того, как verifyOtp обернули в withTimeout выше).
    const otpRes = await withTimeout(sb.auth.verifyOtp({ token_hash: data.hashed_token, type: 'magiclink' }), 8000);
    if (otpRes === TIMED_OUT) { lastTelegramSignInError = 'Подтверждение сессии зависло (verifyOtp не ответил за 8 секунд)'; return { ok: false, error: lastTelegramSignInError }; }
    const { error: otpErr } = otpRes;
    if (otpErr) { console.warn('telegramSignIn: verifyOtp упал —', otpErr.message); lastTelegramSignInError = otpErr.message; return { ok: false, error: otpErr.message }; }
    lastTelegramSignInError = null;
    await refresh(); // подтягивает профиль/семью в UI, как после обычного логина
    // Открыт по реферальной ссылке (t.me/.../LiveLife?startapp=CODE) — start_param пришёл через
    // initData, Edge Function его просто передала обратно. send_invite должен идти С КЛИЕНТА
    // (под только что созданной сессией), не из Edge Function — RPC читает auth.uid() вызывающего,
    // а у service-role его нет. Тихо игнорируем ошибку (напр. "это свой же ID") — не критично.
    if (data.start_param) {
      try { await sb.rpc('send_invite', { target_code: data.start_param }); } catch (e) {}
      // Имя пригласившего — для дефолтного показателя Pro mode «Поблагодарить <имя> за Live Life
      // трекер» (см. createDefaultState/DEFAULT_METRICS в habbittracker.js). get_referrer_name —
      // SECURITY DEFINER (db/phase18_…sql): свежая связь ещё 'pending', обычные RLS-политики
      // stats/profiles новому юзеру её читать не дадут. window.referrerName читается ТОЛЬКО в
      // момент создания дефолтного состояния — до этой строки его нет смысла ставить раньше.
      try {
        const { data: nameData } = await sb.rpc('get_referrer_name', { p_code: data.start_param });
        if (nameData) window.referrerName = nameData;
      } catch (e) {}
    }
    return { ok: true, subscription: data.subscription };
  } catch (e) {
    lastTelegramSignInError = String(e);
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
    if (initData) {
      // telegramSignIn сам зовёт refresh() только при УСПЕХЕ — если попытка снова провалилась
      // (см. таймауты внутри telegramSignIn), без явного refresh() тут юзер остался бы на тексте
      // «Входим…», выставленном строкой выше, с невидимой (display:none) кнопкой повтора — то же
      // самое зависание, только после уже нажатой попытки. Зовём refresh() всегда, она сама
      // покажет актуальное состояние (профиль либо «не удалось / причина», см. lastTelegramSignInError).
      await telegramSignIn(initData);
      await refresh();
    } else {
      await refresh();
    }
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

  // Всё тело — в try/catch: раньше необработанное исключение ЛЮБОЙ строки ниже молча роняло
  // промис (boot() зовёт refresh() без .catch), и юзер навсегда застревал ровно на тексте
  // «Входим через Telegram…», выставленном строкой выше — без ошибки и кнопки повтора (репорт
  // юзера 30.07.2026, скриншот именно с этим текстом и без кнопки). Теперь падение тоже ведёт
  // в понятное состояние «не удалось / причина / повторить», а не в тишину.
  try {
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
      // Причина (lastTelegramSignInError, см. telegramSignIn) показывается прямо тут — юзер сможет
      // прислать её текстом, не открывая консоль разработчика.
      $('auth-checking').style.display = 'block';
      $('auth-checking-text').textContent = 'Не удалось подтвердить вход через Telegram. Проверь соединение и попробуй ещё раз.'
        + (lastTelegramSignInError ? `\n\nПричина: ${lastTelegramSignInError}` : '');
      $('auth-retry-btn').style.display = 'block';
      return;
    }
    $('auth-checking').style.display = 'none';
    $('prof-id').textContent = '…';
    // профиль с invite_id создаётся триггером в БД при регистрации (см. db/phase1_profiles.sql).
    // Один повтор через 800мс, если первый запрос упал (не таймаут) — данные в базе почти
    // наверняка уже есть (см. handle_new_user), падение сразу после verifyOtp обычно значит
    // просто «сессия ещё не до конца устаканилась», а не реальное отсутствие профиля (репорт
    // юзера 30.07.2026: «нет профиля», хотя строка в profiles на самом деле была).
    let pr = await withTimeout(sb.from('profiles').select('invite_id, display_name').eq('id', me).single(), 4000);
    if (pr !== TIMED_OUT && pr.error) {
      await new Promise(r => setTimeout(r, 800));
      pr = await withTimeout(sb.from('profiles').select('invite_id, display_name').eq('id', me).single(), 4000);
    }
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
    syncTimezoneAndActivity(); // для ежедневного пуш-напоминания в 20:00 по локали (Фаза 8)
    loadAppState(); // синхронизация всего прогресса между устройствами (Фаза 11)
  } catch (e) {
    console.error('refresh() упал —', e);
    $('auth-checking').style.display = 'block';
    $('auth-checking-text').textContent = 'Не удалось подтвердить вход через Telegram. Проверь соединение и попробуй ещё раз.'
      + `\n\nПричина: ${String(e && e.message || e)}`;
    $('auth-retry-btn').style.display = 'block';
  }
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
  // level больше не шлём — механика уровней убрана из семейного вида по просьбе юзера (в самом
  // приложении она и так уже скрыта FEATURES.xpLevels, семья была единственной оставшейся утечкой).
  await sb.from('stats').upsert({
    id: me,
    name: myDisplayName || defaultName(),
    streak: s.streak, week_pct: s.weekPct, mood: s.mood, day_event: s.dayEvent,
    updated_at: new Date().toISOString()
  });
}

// === УВЕДОМЛЕНИЕ СЕМЬИ/ДРУЗЕЙ ПРИ НИЗКОМ НАСТРОЕНИИ (Фаза 15) ===
// Вызывается из habbittracker.js сразу по клику на шкале настроения, если значение < 4 — сама
// функция (notify-mood-alert) решает, кому слать и дедупит «раз в день» на сервере, тут просто
// fire-and-forget, чтобы не блокировать UI ожиданием сети.
function notifyMoodAlert(mood) {
  if (!me) return;
  sb.functions.invoke('notify-mood-alert', { body: { mood } }).catch((e) => console.error('notify-mood-alert:', e));
}
window.notifyMoodAlert = notifyMoodAlert;

// === СИНХРОНИЗАЦИЯ ВСЕГО ПРОГРЕССА МЕЖДУ УСТРОЙСТВАМИ (Фаза 11) ===
// Раньше синкалась только сводка (stats выше) — сами привычки/история/чек-апы/питание/метрики жили
// только в localStorage конкретного браузера (см. db/phase11_app_state_sync.sql). Конфликты не
// мержатся по полям — побеждает более свежая запись целиком (last-write-wins по updated_at): для
// трекера одного человека этого достаточно, честный merge — overkill.
let appStateSyncTimer = null;
function syncAppState(state) { clearTimeout(appStateSyncTimer); appStateSyncTimer = setTimeout(() => pushAppState(state), 1500); } // дебаунс, как syncStats
window.syncAppState = syncAppState;

async function pushAppState(state) {
  if (!me) return;
  // updated_at не передаём — его всегда ставит сервер (триггер, см. db/phase11_app_state_sync.sql),
  // чтобы last-write-wins не зависел от точности часов конкретного устройства. Читаем обратно
  // именно серверное значение через .select().
  const { data, error } = await sb.from('app_state').upsert({ user_id: me, data: state }).select('updated_at').single();
  if (error) { console.error('pushAppState:', error.message); return; }
  // Помечаем, ЧТО мы сами только что отправили — используется, чтобы не среагировать на своё же
  // realtime-событие как на «пришли новые данные с другого устройства» (см. subscribeAppStateRealtime).
  if (data) localStorage.setItem('habbittracker_local_synced_at', data.updated_at);
}

let appStateChannel = null;
// Тянет состояние из облака при входе — решает, чья версия свежее (см. комментарий в начале блока).
// Если в облаке пока пусто (первое включение синка для существующего юзера) — ничего не перезаписываем,
// просто зальём туда то, что уже есть локально.
async function loadAppState() {
  if (!me) return;
  const r = await withTimeout(sb.from('app_state').select('data, updated_at').eq('user_id', me).maybeSingle(), 4000);
  if (r === TIMED_OUT) return;
  const { data, error } = r;
  if (error) { console.error('loadAppState:', error.message); return; }
  if (data) {
    const localSyncedAt = localStorage.getItem('habbittracker_local_synced_at');
    const remoteIsNewer = !localSyncedAt || new Date(data.updated_at) > new Date(localSyncedAt);
    if (remoteIsNewer && typeof window.applyCloudState === 'function') window.applyCloudState(data.data, data.updated_at);
  } else if (window.dashState) {
    syncAppState(window.dashState); // в облаке ещё ничего нет — заливаем то, что есть локально
  }
  subscribeAppStateRealtime();
}

function subscribeAppStateRealtime() {
  if (!me || appStateChannel) return;
  appStateChannel = sb.channel('app_state_' + me)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_state', filter: `user_id=eq.${me}` }, (payload) => {
      const localSyncedAt = localStorage.getItem('habbittracker_local_synced_at');
      // Своё же изменение (после pushAppState) тоже прилетит этим событием — не перезатираем им
      // локальное состояние заново, иначе интерфейс будет «мигать» перезагрузкой на каждое сохранение.
      if (localSyncedAt && new Date(payload.new.updated_at) <= new Date(localSyncedAt)) return;
      if (typeof window.applyCloudState === 'function') window.applyCloudState(payload.new.data, payload.new.updated_at);
    })
    .subscribe();
}
function unsubscribeAppStateRealtime() {
  if (appStateChannel) { sb.removeChannel(appStateChannel); appStateChannel = null; }
}

// === ТАЙМЗОНА + АКТИВНОСТЬ (Фаза 8 — ежедневное пуш-напоминание в 20:00 по локали) ===
// Пишем при каждом успешном входе (см. refresh()) — обычный update, доп. RLS не нужна (own
// profile update из phase1 уже разрешает владельцу писать любые колонки своей строки). Серверный
// cron (get_and_mark_due_reminders, db/phase8_…sql) сам решает, кому и когда слать сообщение —
// клиент только сообщает часовой пояс и факт «был здесь только что».
function syncTimezoneAndActivity() {
  if (!me) return;
  let tz;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return; }
  if (!tz) return;
  sb.from('profiles').update({ timezone: tz, last_seen_at: new Date().toISOString() }).eq('id', me)
    .then(({ error }) => { if (error) console.error('syncTimezoneAndActivity:', error.message); });
}

// === ПОДПИСКА (Stars) ===
// Цены здесь — ТОЛЬКО для отображения юзеру; реальная сумма списывается на бэке
// (create-invoice/index.ts) — если меняешь цену, поправь ОБА места (см. HANDOFF.md §15).
const PRICE_PERSONAL_STARS = 250;
const PRICE_FAMILY_PER_PERSON_STARS = 300;
let selectedPlan = null;
const TRIAL_DAYS = 14; // 2 недели — см. HANDOFF.md, Фаза 7 (было 7 дней в исходном плане)
const DAY_MS = 86400000;

// Сырые поля последней загруженной подписки — держим, чтобы пересчитывать доступ на
// visibilitychange БЕЗ повторного похода в сеть (сами поля со временем не меняются, меняется
// только текущее время, с которым их сравниваем — см. applyAccess()).
window.lastSubscription = null;

// Доступ ко всему приложению (не путать с window.hasActiveSubscription — тот только про Pro mode,
// см. ниже) — жив, пока активна платная подписка, ИЛИ не вышли 14 дней триала, ИЛИ банк bonus_days
// (недели за рефералов, см. db/phase7_…sql) отодвигает этот дедлайн дальше. bonus_days никогда не
// тратится счётчиком — это просто сдвиг даты, поэтому одинаково работает и на триале, и поверх уже
// оплаченного периода (см. HANDOFF.md).
function computeAppAccess(s) {
  if (!s) return { hasAccess: true, daysLeft: TRIAL_DAYS }; // подписка ещё не загрузилась — не блокируем понапрасну
  if (s.status === 'active') return { hasAccess: true, daysLeft: null };
  const trialEnd = new Date(s.trial_started_at).getTime() + TRIAL_DAYS * DAY_MS;
  const paidEnd = s.expires_at ? new Date(s.expires_at).getTime() : 0;
  const deadline = Math.max(trialEnd, paidEnd) + (s.bonus_days || 0) * DAY_MS;
  const daysLeft = Math.ceil((deadline - Date.now()) / DAY_MS);
  return { hasAccess: Date.now() < deadline, daysLeft };
}
function applyAccess() {
  const { hasAccess } = computeAppAccess(window.lastSubscription);
  if (typeof window.applyAppAccessGate === 'function') window.applyAppAccessGate(hasAccess);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  applyAccess();
  // На мобильных фоновая вкладка часто теряет realtime-соединение (браузер приостанавливает JS/сеть) —
  // при возврате на всякий случай перепроверяем облако напрямую, а не полагаемся только на websocket.
  if (me) loadAppState();
});

async function loadSubscription() {
  if (!me) return;
  const r = await withTimeout(sb.from('subscriptions').select('*').eq('user_id', me).maybeSingle(), 4000);
  if (r === TIMED_OUT || !r.data) {
    $('sub-status').textContent = '—';
    window.hasActiveSubscription = false;
    if (typeof window.syncPromodeStripes === 'function') window.syncPromodeStripes();
    return;
  }
  const s = r.data;
  window.lastSubscription = s;
  const fmt = (iso) => iso ? new Date(iso).toLocaleDateString('ru-RU') : '';
  // Pro mode (habbittracker.js) читает этот флаг напрямую — активная подписка (любой план)
  // снимает пейволл с тумблера. Не трогает free-триал/бонусные дни: это отдельный, более широкий
  // гейт на доступ ко всему приложению (см. computeAppAccess/applyAccess выше).
  window.hasActiveSubscription = s.status === 'active';
  // «Задачи»/«Питание» подменяют собой отдельный тумблер Pro mode, пока есть активная подписка
  // (см. syncPromodeStripes в habbittracker.js) — статус подписки меняется асинхронно после того,
  // как дашборд уже отрисован, поэтому дёргаем пересчёт явно, а не полагаемся на то, что кто-то
  // ещё вызовет syncProModeTab() к этому моменту.
  if (typeof window.syncPromodeStripes === 'function') window.syncPromodeStripes();
  const { hasAccess, daysLeft } = computeAppAccess(s);
  if (s.status === 'active') {
    // family_owner_id заполнен только у ЧЛЕНОВ семьи (не у самого покупателя, см.
    // db/phase9_family_access_sync.sql) — у них нет своего family_size, показываем иначе.
    $('sub-status').textContent = s.family_owner_id
      ? `Family — в семье, доступ до ${fmt(s.expires_at)}`
      : s.plan === 'family'
        ? `Family (${s.family_size} чел.) до ${fmt(s.expires_at)}`
        : `Personal до ${fmt(s.expires_at)}`;
  } else if (hasAccess) {
    $('sub-status').textContent = `Триал — ещё ${daysLeft} дн.${s.bonus_days ? ` (включая ${s.bonus_days} бонусных)` : ''}`;
  } else {
    $('sub-status').textContent = 'Бесплатный период закончился';
  }
  if (typeof window.applyAppAccessGate === 'function') window.applyAppAccessGate(hasAccess);
  updateBonusStats(); // bonus_days только что обновился — обновим и цифру в профиле (см. ниже)
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
  server_misconfigured_no_bot_token: 'Сервер входа не настроен (нет токена бота)',
  bad_plan: 'Неверный план подписки',
  telegram_api_error: 'Telegram отклонил создание счёта',
  // Коды из telegram-auth/index.ts:
  no_init_data: 'Telegram не передал данные для входа',
  invalid_init_data: 'Telegram не подтвердил подлинность данных входа (устаревшая или повреждённая ссылка)',
  create_user_failed: 'Не удалось создать аккаунт на сервере',
  link_failed: 'Не удалось выдать вход на сервере',
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

// === ПРИГЛАШЁННЫЕ ДРУЗЬЯ / СЕМЬЯ (Фаза 3 + Фаза 7 + Фаза 16) ===
// invites.to_id — владелец введённого кода, from_id — тот, кто его ввёл (см. send_invite,
// db/phase3_family.sql). Раньше «Семья» на экране профиля читала ТОЛЬКО to_id=я — то есть у
// человека, который сам ввёл чужой код, связь была видна лишь на профиле ДРУГОЙ стороны, а свой
// список выглядел пустым (юзер репортил «пропал член семьи» — на деле никогда не появлялся с
// его стороны). are_friends()/revoke_family_access (Фаза 9) и так уже были симметричны — не
// хватало зеркального отображения. Теперь читаем обе стороны (`from_id=я OR to_id=я`) и
// схлопываем в единый список по counterpart (собеседнику).
//
// «Приглашён» (бонус за реферала, см. db/phase7_…sql) — отдельный счётчик, ТОЛЬКО to_id=я (кто-то
// использовал именно МОЙ код) — не путать со «семьёй»: приглашение засчитывается один раз,
// независимо от направления связи и от того, добавлен ли человек в семью впоследствии.
async function loadFamily() {
  if (!me) return;
  const r1 = await withTimeout(sb.from('invites').select('id, from_id, to_id, from_code, status').or(`from_id.eq.${me},to_id.eq.${me}`), 4000);
  if (r1 === TIMED_OUT) return; // сеть подвисла — тихо выходим, следующий refresh() попробует снова
  const rows = r1.data || [];
  window.invitedFriendsCount = rows.filter(r => r.to_id === me).length; // читает профиль (бонус-статистика) и пейволл

  // iAmApprover — я to_id (владелец кода), только владелец может подтвердить pending-заявку
  // кнопкой «Добавить в семью» (см. send_invite — approve всегда делает тот, чей код ввели).
  // Обратную сторону (from_id=я, pending) показываем как «жду подтверждения», без кнопки.
  const items = rows.map(r => ({
    id: r.id,
    counterpart: r.from_id === me ? r.to_id : r.from_id,
    isFamily: r.status === 'accepted',
    iAmApprover: r.to_id === me,
    // from_code — это код САМОГО from_id, а не собеседника; как имя годится только когда я
    // сам to_id (тогда from_code принадлежит собеседнику), в обратную сторону это мой же код.
    fallbackName: r.from_id === me ? null : r.from_code,
  }));

  const acceptedIds = items.filter(i => i.isFamily).map(i => i.counterpart);
  // Читается пейволлом Pro mode/после триала (habbittracker.js) — пока в семье никого нет,
  // покупка Family недоступна (план дешевле именно ЗА СЧЁТ нескольких человек).
  window.familyMemberCount = acceptedIds.length;
  let statsById = {};
  if (acceptedIds.length) {
    const r2 = await withTimeout(sb.from('stats').select('*').in('id', acceptedIds), 4000);
    if (r2 !== TIMED_OUT) statsById = Object.fromEntries((r2.data || []).map(s => [s.id, s]));
  }
  // Юзер попросил разделить единый список на две секции экрана: «Семья» (принятые, с живой
  // статистикой) сразу под подпиской, «Приглашённые друзья» (ещё не в семье) — в самом низу.
  renderFamilyMembers(items.filter(it => it.isFamily), statsById);
  renderPendingFriends(items.filter(it => !it.isFamily));
  updateBonusStats();
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
// set_family_status (Фаза 16, SECURITY DEFINER) вместо прямого update — раньше RLS "invites
// respond" пускала менять статус только to_id, из-за чего сторона from_id не могла ни выйти из
// семьи, ни вернуться в нём со своей половины экрана. RPC пускает любую сторону связи.
async function addToFamily(id) {
  await sb.rpc('set_family_status', { row_id: id, new_status: 'accepted' });
  loadFamily();
}
async function removeFromFamily(id) {
  // 'pending' переиспользуется как «приглашён, но не в семье» (не «ожидает ответа») — бонус за
  // реферала при этом не трогается, он был начислен один раз при первом появлении строки.
  await sb.rpc('set_family_status', { row_id: id, new_status: 'pending' });
  loadFamily();
}
function updateBonusStats() {
  const s = window.lastSubscription;
  const friendsEl = $('bonus-friends-count'); if (friendsEl) friendsEl.textContent = window.invitedFriendsCount || 0;
  const daysEl = $('bonus-days-count'); if (daysEl) daysEl.textContent = (s && s.bonus_days) || 0;
}
// name/day_event — свободный текст с чужого устройства (имя до 30 символов, событие дня до 200,
// см. index.html #prof-name-input/#day-event-input) — экранируем перед вставкой в innerHTML,
// иначе член семьи мог бы вписать себе в имя/событие дня разметку, которая выполнится в профиле
// у ДРУГИХ членов семьи (won и before this fix — статус пофиксил заодно, раз уже трогаю функцию).
const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// «Семья» — только принятые связи (см. #family-list в index.html, сразу под подпиской), всегда
// со статистикой собеседника (are_friends уже разрешает читать stats обеим сторонам, см.
// db/phase3_family.sql). Кнопка «Удалить из семьи» доступна любой стороне (set_family_status).
function renderFamilyMembers(items, statsById) {
  const box = $('family-list');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<div class="fam-empty">Пока никого. Пригласи по ID выше.</div>'; return; }
  box.innerHTML = items.map(it => {
    const s = statsById[it.counterpart];
    const name = escHtml((s && s.name) || it.fallbackName || '—');
    const statsHtml = s
      ? `<div class="fam-stats"><span>серия ${s.streak ?? 0}</span><span>${s.week_pct ?? 0}% за неделю</span>${s.mood != null ? `<span>настроение ${s.mood}/10</span>` : ''}</div>`
      : '';
    // Событие дня — только СЕГОДНЯШНЕЕ (getSummary() в habbittracker.js кладёт в day_event только
    // dashState.dayEvents[todayKey()]), пусто — строку не показываем вообще.
    const dayEventHtml = (s && s.day_event) ? `<div class="fam-day-event">${escHtml(s.day_event)}</div>` : '';
    return `<div class="fam-friend">
      <div class="fam-friend-info"><div class="fam-name">${name}</div>${statsHtml}${dayEventHtml}</div>
      <button class="fam-fam-btn fam-fam-remove" data-id="${it.id}" data-action="remove" type="button">Удалить из семьи</button>
    </div>`;
  }).join('');
  box.querySelectorAll('.fam-fam-btn').forEach(b => b.addEventListener('click', () => removeFromFamily(b.dataset.id)));
}

// «Приглашённые друзья» — самый низ профиля (юзер попросил): связи, ещё не принятые в семью.
// Своя pending-заявка (я ввёл чужой код, жду подтверждения владельца) показывается без кнопки —
// принять/отменить её могу не я, а тот, чей код я ввёл (см. iAmApprover в loadFamily).
function renderPendingFriends(items) {
  const box = $('invited-friends-list');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<div class="fam-empty">Пока никого. Поделись ссылкой ниже.</div>'; return; }
  box.innerHTML = items.map(it => {
    const waitingForThem = !it.iAmApprover;
    const actionHtml = waitingForThem
      ? '<span class="fam-fam-waiting">ждём подтверждения</span>'
      : `<button class="fam-fam-btn" data-id="${it.id}" data-action="add" type="button">Добавить в семью</button>`;
    return `<div class="fam-friend">
      <div class="fam-friend-info"><div class="fam-name">${it.fallbackName || '—'}</div></div>
      ${actionHtml}
    </div>`;
  }).join('');
  box.querySelectorAll('.fam-fam-btn').forEach(b => b.addEventListener('click', () => addToFamily(b.dataset.id)));
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
  $('auth-logout').addEventListener('click', async () => { unsubscribeAppStateRealtime(); await sb.auth.signOut(); await refresh(); });
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
