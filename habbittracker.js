window.selectedIdentity = null;

// === FEATURE FLAGS (упрощение продукта — прячем UI/логику, НЕ удаляем код и данные.
// Откат = поменять значение на true. См. HANDOFF.md §15) ===
const FEATURES = {
    games: false,
    xpLevels: false,
    legacyCheckinFields: false, // старые поля утро/вечер сверх «качество сна + настроение», и вкладка «Вечер»
    swipeNav: false, // свайп пальцем между вкладками — отключено по просьбе (некрасиво смотрелось на десктопе/Telegram Desktop)
    dayTab: false, // вкладка «День» — заменена вкладкой «Задачи» (бывший «Месяц»), см. HANDOFF.md §15
    lifeWheel: false, // колесо жизни (месяц + поле «Сферы» в настройках привычки) — временно скрыто по просьбе юзера
};
// Пока настоящая проверка подписки не подключена (Stars-оплата ещё не проверена живьём),
// window.hasActiveSubscription всегда false — Pro mode показывает пейволл при любом клике.
// auth.js выставит его в true, когда loadSubscription() увидит status:'active' — тогда тумблер
// заработает как обычный переключатель, без правок здесь.
window.hasActiveSubscription = window.hasActiveSubscription || false;

// === TELEGRAM MINI APP: определение контекста ===
// telegram-web-app.js (см. index.html) всегда создаёт window.Telegram.WebApp, но вне Telegram
// initData у него пустой — так и отличаем «открыто в Telegram» от обычного браузера.
function isTelegramContext() {
    return !!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData);
}

document.addEventListener('DOMContentLoaded', () => {
    // === ЭЛЕМЕНТЫ ===
    const introScreen = document.getElementById('intro-screen');
    const introText = document.getElementById('intro-text');
    const dashboardScreen = document.getElementById('dashboard-screen');
    const loadingOverlay = document.getElementById('loading-overlay');

    // Применяем фиче-флаги: скрываем UI отключённых фич через style.display, код/данные не трогаем
    if (!FEATURES.games) {
        const el = document.querySelector('.view-btn[data-view="training"]');
        if (el) el.style.display = 'none';
    }
    if (!FEATURES.xpLevels) {
        document.querySelectorAll('.dash-level, .dash-footer').forEach(el => el.style.display = 'none');
    }
    if (!FEATURES.legacyCheckinFields) {
        document.querySelectorAll('.legacy-field').forEach(el => el.style.display = 'none');
        const eveningBtn = document.querySelector('.view-btn[data-view="evening"]');
        if (eveningBtn) eveningBtn.style.display = 'none';
    }
    if (!FEATURES.dayTab) {
        const el = document.querySelector('.view-btn[data-view="habits"]');
        if (el) el.style.display = 'none';
    }
    if (!FEATURES.lifeWheel) {
        document.querySelectorAll('.life-wheel-field, .life-wheel').forEach(el => el.style.display = 'none');
    }

    // Telegram Mini App: разворачиваем на весь экран, сигналим клиенту, что готовы
    if (isTelegramContext()) {
        try {
            window.Telegram.WebApp.ready();
            window.Telegram.WebApp.expand();
            // Иначе Telegram сам перехватывает вертикальные свайпы по странице (жест закрытия/
            // скролла клиента) — драг задач долгим тапом реагирует на нажатие, но само движение
            // пальца до нашего pointermove не долетает (см. HANDOFF.md §67, правка после жалобы).
            if (typeof window.Telegram.WebApp.disableVerticalSwipes === 'function') {
                window.Telegram.WebApp.disableVerticalSwipes();
            }
        } catch (e) {}
    } else {
        // Продукт только для Telegram (решено 22.07.2026, см. HANDOFF.md §15) — прямой браузерный
        // визит (не через Mini App) блокируем экраном-заглушкой, остальную инициализацию не запускаем.
        introScreen.style.display = 'none';
        dashboardScreen.style.display = 'none';
        const wo = document.getElementById('web-only-screen');
        if (wo) wo.style.display = 'flex';
        return;
    }

    // Подзаголовок интро — одна случайная фраза при каждой загрузке экрана (не смена по таймеру/
    // клику, как раньше, см. HANDOFF.md — просто рандом один раз при рендере).
    const phrases = [
        "Побеждает тот, кто не останавливается",
        "У самурая только путь",
        "Дисциплина сильнее мотивации",
        "Маленькие шаги каждый день — вот и весь секрет",
        "Не жди вдохновения. Начни — и оно придёт",
        "Сила не в том, чтобы не падать, а в том, чтобы вставать снова",
        "Каждый день — ещё один шаг к тому, кем ты хочешь стать",
        "Путь важнее цели",
        "Тот, кто ждёт идеального момента, не начинает никогда",
        "Слабость — это отказ подняться, а не само падение",
        "Величие строится из повторений, которых никто не видит",
        "Сравнивай себя не с другими, а с собой вчерашним",
        "Тренируй тело — закаляй дух",
        "Воин не выбирает, тренироваться сегодня или нет — он просто тренируется",
        "Привычка — тихий голос, который однажды станет судьбой",
        "Комфорт — враг роста",
        "Иди медленно, но не останавливайся",
        "Сегодняшнее усилие — завтрашняя сила",
        "Никто не увидит тренировки — все увидят результат",
        "Спокойствие сильнее суеты",
        "Просто продолжай"
    ];
    if (introText) introText.textContent = phrases[Math.floor(Math.random() * phrases.length)];

    // === ЭКРАНИРОВАНИЕ ПОЛЬЗОВАТЕЛЬСКОГО ТЕКСТА ДЛЯ innerHTML ===
    // ОБЯЗАТЕЛЬНО прогонять через esc() ЛЮБОЕ значение из dashState, которое юзер вводил сам
    // (названия задач и показателей, «я сделаю после», событие дня, задачи дня, еда) — везде, где
    // оно попадает в innerHTML или в атрибут.
    //
    // ПОЧЕМУ ЭТО СТАЛО КРИТИЧНЫМ ИМЕННО СЕЙЧАС. До Фазы 19 в dashState лежали ТОЛЬКО собственные
    // данные юзера: разметка в названии задачи была бы self-XSS, то есть безвредной глупостью.
    // Режим «Посмотреть» (enterFamilyViewMode) кладёт в dashState состояние ДРУГОГО человека —
    // и тот же самый нескранированный `${h.text}` превращается в настоящую хранимую XSS: член
    // семьи называет задачу `<img src=x onerror=...>`, я жму «Посмотреть», и его код выполняется
    // в МОЁМ origin, где в localStorage лежит ключ сессии Supabase ('habit_auth'). Ни
    // familyViewEventGuard, ни серверные RPC тут не помогают: разметка выполняется в момент
    // разбора innerHTML, до всяких кликов, а get_family_state отдаёт jsonb как есть.
    // Тот же приём уже применён в auth.js (escHtml) ровно по этой причине — просто до сих пор не
    // был доведён до рендеров дашборда.
    //
    // Экранируем и кавычки тоже: одной функции хватает и для текста, и для значения атрибута
    // (раньше был escAttr, который менял ТОЛЬКО двойную кавычку — внутри атрибута он спасал, а в
    // текстовом узле пропускал < и > насквозь).
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // === ПЕРЕМЕННЫЕ СОСТОЯНИЯ ===
    let timerInterval;
    let reminderInterval;
    let currentEditIndex = null;
    let isCreatingHabit = false; // true между openNewHabitModal и close() — саve/delete ветвятся по этому флагу
    let newHabitContextDate = null; // день, к которому привяжется РАЗОВАЯ задача при создании (см. openNewHabitModal)
    let pendingOneTimeDate = null; // выбранная в модалке дата разовой задачи (по умолчанию = newHabitContextDate/сегодня, меняется через openCalendar)
    let currentTrainingGame = null;
    let trainingGameInterval = null;
    let isHistoryInitialized = false;
    
    // Переменные для Истории и Аналитики
    let currentHistoryType = null; 
    let currentHistoryDate = null;

    // === ГЛОБАЛЬНОЕ СОСТОЯНИЕ ===
    let dashState = {
        level: 1,
        currentXP: 0,
        habits: [],
        unlockedGames: [], // пусто на старте → игрок выбирает первую игру сам
        lastActiveDate: null,
        checkins: { morning: {}, evening: {} },
        checkinHistory: {},
        history: {},        // постоянный лог выполнения привычек: { 'YYYY-MM-DD': { uid: true } }
        foodLog: {},        // приёмы пищи по дням: { 'YYYY-MM-DD': { mealId: {time,text}, ... } }
        foodMealSlots: {},  // порядок id блоков питания по дням (юзер добавляет ещё блоки — только
                             // на этот день, см. getMealSlots/addMealSlot); без записи — 3 дефолтных
        gameRecords: {},    // личные рекорды мини-игр: { sudoku:{bestTimeMs}, count:{bestCorrect}, words:{bestCorrect} }
        calorieLog: {},     // Pro mode «Питание»: { 'YYYY-MM-DD': [{ id, name, kcal }] } — см. renderFoodCalories
        calorieTarget: 2000, // дневная цель ккал в Pro mode, переопределяется юзером
        psychoMode: false,  // тумблер «psycho mode» (числовые метрики вместо привычек)
        metrics: [],        // живой список метрик (сидируется из DEFAULT_METRICS в init/createDefaultState)
        metricTargets: {},  // переопределённые цели метрик { metricId: число }
        metricLog: {},      // числовые метрики по дням: { 'YYYY-MM-DD': { metricId: число|bool } }
        onboardingDone: false, // пройден ли вводный тур
        seenHints: {}       // показанные контекстные подсказки по вкладкам
    };

    // === РЕЖИМ «ПРОСМОТР ЭКРАНА ЧЛЕНА СЕМЬИ» (Фаза 19) ===
    // null — обычная работа со своими данными; объект — сейчас на экране ЧУЖОЕ состояние.
    // Полное описание механики и гарантий безопасности — у enterFamilyViewMode ниже.
    let familyView = null;
    // Облачное состояние, прилетевшее по реалтайму, пока мы смотрели чужой экран — применяем
    // при выходе (applyCloudState перезагружает страницу, посреди просмотра это выглядело бы
    // как вылет без причины).
    let pendingCloudState = null;

    function saveProgress() {
        // Пока смотрим экран члена семьи — не пишем НИЧЕГО. dashState сейчас держит ЧУЖОЕ
        // состояние, любая запись отсюда затёрла бы мой localStorage и улетела бы в мою строку
        // app_state (Фаза 11). Это единственная точка записи в приложении — все её вызовы
        // гасятся этим одним return, отдельные проверки в обработчиках не нужны (сами обработчики
        // и так не доходят до вызова — см. familyViewEventGuard).
        if (familyView) return;
        try {
            localStorage.setItem('habbittracker_progress', JSON.stringify(dashState));
        } catch (e) {
            console.warn('⚠️ Ошибка сохранения:', e);
        }
        if (window.syncStats) window.syncStats(); // синк сводки в облако, если залогинен (auth.js дебаунсит)
        if (window.syncAppState) window.syncAppState(dashState); // синк ВСЕГО прогресса между устройствами (Фаза 11)
    }

    // Применяет состояние, пришедшее из облака (другое устройство/вкладка — см. auth.js
    // loadAppState/subscribeAppStateRealtime). Бэкапим текущий локальный сейв на случай накладки с
    // определением «чья версия свежее», а дальше просто перезагружаем страницу поверх новых данных —
    // так гарантированно проходят все те же миграции/дефолты, что и при обычном старте (см. init()),
    // без дублирования этой логики здесь.
    window.applyCloudState = function (remoteState, remoteUpdatedAt) {
        // Идёт просмотр члена семьи (Фаза 19) — применять облако сейчас нельзя: функция
        // заканчивается location.reload(), и юзер молча вылетел бы с чужого экрана. Реалтайм в
        // auth.js при этом НЕ отписываем (отписка/переподписка рискует пропустить событие и
        // разъехаться с другим устройством) — просто запоминаем последнее и применяем в
        // exitFamilyViewMode. Свои данные при этом не теряются: в режиме просмотра мы вообще
        // ничего не сохраняли (saveProgress — no-op).
        if (familyView) { pendingCloudState = { remoteState, remoteUpdatedAt }; return; }
        try {
            const current = localStorage.getItem('habbittracker_progress');
            if (current) localStorage.setItem('habbittracker_progress_backup', current);
        } catch (e) {}
        localStorage.setItem('habbittracker_progress', JSON.stringify(remoteState));
        if (remoteUpdatedAt) localStorage.setItem('habbittracker_local_synced_at', remoteUpdatedAt);
        location.reload();
    };

    // Предохранитель от гонки при первом включении синка (Фаза 11): если это устройство первым
    // открыл юзер ПОСЛЕ другого устройства с другими (например, пустыми) данными — свежесть
    // сравнивается по времени синхронизации, а не по объёму данных, поэтому облако могло
    // ошибочно перезаписать реальный прогресс. habbittracker_progress_backup — снимок ПРЯМО ПЕРЕД
    // такой перезаписью (см. applyCloudState выше) — предлагаем юзеру вернуть его вручную.
    function checkForBackupRestore() {
        let backup;
        try { backup = localStorage.getItem('habbittracker_progress_backup'); } catch (e) { return; }
        if (!backup) return;
        let current;
        try { current = localStorage.getItem('habbittracker_progress'); } catch (e) { current = null; }
        if (backup === current) { try { localStorage.removeItem('habbittracker_progress_backup'); } catch (e) {} return; }

        const bar = document.createElement('div');
        bar.className = 'restore-backup-bar';
        bar.innerHTML = `
            <span>На этом устройстве есть более ранняя версия данных (сохранена перед синхронизацией с другим устройством). Восстановить её?</span>
            <div class="restore-backup-actions">
                <button type="button" class="restore-backup-yes">Восстановить</button>
                <button type="button" class="restore-backup-no">Не нужно</button>
            </div>`;
        document.body.appendChild(bar);
        bar.querySelector('.restore-backup-yes').addEventListener('click', () => {
            try {
                localStorage.setItem('habbittracker_progress', backup);
                // Флаг для init(): после перезагрузки нужно протолкнуть ВОССТАНОВЛЕННЫЕ данные в
                // облако, иначе следующая синхронизация/реалтайм-событие снова принесёт чужую версию.
                localStorage.setItem('habbittracker_needs_push_after_restore', '1');
                localStorage.removeItem('habbittracker_progress_backup');
            } catch (e) {}
            location.reload();
        });
        bar.querySelector('.restore-backup-no').addEventListener('click', () => {
            try { localStorage.removeItem('habbittracker_progress_backup'); } catch (e) {}
            bar.remove();
        });
    }

    // Сводка для «семьи»: уровень, лучшая серия, % за 7 дней, последнее утреннее настроение
    function getSummary() {
        const habits = dashState.habits || [];
        let streak = 0;
        habits.forEach(h => { const s = currentStreak(h.uid); if (s > streak) streak = s; });
        const now = new Date();
        let done = 0, possible = 0;
        for (let i = 0; i < 7; i++) {
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
            const rec = (dashState.history || {})[fdt(d.getFullYear(), d.getMonth(), d.getDate())] || {};
            habits.forEach(h => { possible++; if (rec[h.uid]) done++; });
        }
        const weekPct = possible ? Math.round(done / possible * 100) : 0;
        let mood = null;
        const ch = dashState.checkinHistory || {};
        Object.keys(ch).sort().forEach(k => { const m = ch[k] && ch[k].morning && ch[k].morning.mood; if (m != null && m !== '') mood = +m; });
        // Событие дня — юзер попросил показывать семье (см. HANDOFF.md §46), только СЕГОДНЯШНЕЕ
        // (dashState.dayEvents[todayKey()]), не история за все дни.
        const dayEvent = (dashState.dayEvents || {})[todayKey()] || null;
        return { level: dashState.level || 1, streak, weekPct, mood, dayEvent };
    }
    window.getSummary = getSummary;

    function loadProgress() {
        try {
            const s = localStorage.getItem('habbittracker_progress');
            return s ? JSON.parse(s) : null;
        } catch (e) {
            console.warn('⚠️ Ошибка загрузки:', e);
            return null;
        }
    }

    // =========================================
    //   ИСТОРИЯ ВЫПОЛНЕНИЯ (ПОСТОЯННЫЙ ЛОГ)
    //   dashState.history = { 'YYYY-MM-DD': { uid: true } }
    // =========================================
    const pad2 = n => String(n).padStart(2, '0');
    const fdt = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`; // m: 0-based
    const todayKey = () => { const t = new Date(); return fdt(t.getFullYear(), t.getMonth(), t.getDate()); };
    const newUid = () => 'u' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

    // id привычки = id цели и он НЕ уникален (у цели несколько микро-привычек),
    // поэтому для лога заводим стабильный uid.
    function ensureHabitUids() {
        let changed = false;
        (dashState.habits || []).forEach(h => { if (!h.uid) { h.uid = newUid(); changed = true; } });
        if (changed) saveProgress();
    }

    function setHistory(uid, dateStr, done) {
        if (!dashState.history) dashState.history = {};
        if (done) {
            (dashState.history[dateStr] = dashState.history[dateStr] || {})[uid] = true;
        } else if (dashState.history[dateStr]) {
            delete dashState.history[dateStr][uid];
            if (!Object.keys(dashState.history[dateStr]).length) delete dashState.history[dateStr];
        }
    }

    const isDone = (uid, dateStr) => !!(dashState.history && dashState.history[dateStr] && dashState.history[dateStr][uid]);

    // Текущая серия: подряд идущие выполненные дни до сегодня.
    // Если сегодня ещё не отмечено — серия не рвётся, отсчёт со вчера.
    function currentStreak(uid) {
        let streak = 0;
        const d = new Date();
        if (!isDone(uid, todayKey())) d.setDate(d.getDate() - 1);
        while (isDone(uid, fdt(d.getFullYear(), d.getMonth(), d.getDate()))) {
            streak++;
            d.setDate(d.getDate() - 1);
        }
        return streak;
    }

    function getLevelStats(level) {
        return {
            xpNeeded: Math.floor(15 * Math.pow(level, 1.8)),
            xpPerHabit: 5 + (level - 1) * 3
        };
    }

    function checkNewDay() {
        const today = new Date().toISOString().split('T')[0];
        if (dashState.lastActiveDate !== today) {
            dashState.habits.forEach(h => h.completed = false);
            if (!dashState.checkins) dashState.checkins = {};
            dashState.checkins = { morning: {}, evening: {} };
            dashState.lastActiveDate = today;
            saveProgress();
        }
    }

    // === ПРИВЫЧКИ ПО УМОЛЧАНИЮ ===
    // По одной на каждую сферу колеса жизни (LIFE_AREAS ниже) — авто-привязка при создании,
    // юзер может переназначить сферу вручную в любой момент через «⋯». См. HANDOFF.md §15.
    const DEFAULT_HABITS = [
        { text: 'Главная задача дня',          area: 'career' },
        { text: 'Убраться 15 минут',           area: 'home' },
        { text: 'Тренировка',                  area: 'energy' },
        { text: 'Записать траты дня',          area: 'finance' },
        { text: 'Написать/позвонить близкому', area: 'social' },
        { text: 'Читать 20 минут',             area: 'growth' },
        { text: 'Дневник благодарности',       area: 'emotion' }
    ];
    const MAX_HABITS = 30;

    // === КАТЕГОРИИ ОНБОРДИНГА (экран выбора набора задач для нового юзера) ===
    // Каждая area — существующая сфера колеса жизни (см. LIFE_AREAS ниже), новых сфер не заводим.
    // Тексты/категории — см. обсуждение в HANDOFF.md §16.
    const ONBOARDING_CATEGORIES = [
        { id: 'spartan', name: 'Спартанец', tasks: [
            { text: 'Холодный душ 2 минуты', area: 'energy' },
            { text: '50 отжиманий', area: 'energy' },
            { text: 'Встать в 6:00', area: 'energy' },
            { text: 'Без сахара весь день', area: 'emotion' },
            { text: '10 000 шагов', area: 'energy' }
        ] },
        { id: 'longevity', name: 'Вечная жизнь', tasks: [
            { text: 'Медитация 10 минут', area: 'emotion' },
            { text: 'Сон 8 часов', area: 'energy' },
            { text: 'Витамины утром', area: 'energy' },
            { text: 'Прогулка 30 минут', area: 'energy' },
            { text: 'Растяжка 10 минут', area: 'energy' }
        ] },
        { id: 'student', name: 'Студент', tasks: [
            { text: 'Читать 20 страниц', area: 'growth' },
            { text: 'Новое слово/фраза на языке', area: 'growth' },
            { text: 'Конспект дня 5 строк', area: 'growth' },
            { text: 'Без соцсетей до 12:00', area: 'emotion' },
            { text: 'Повторить материал 15 минут', area: 'growth' }
        ] },
        { id: 'careerist', name: 'Карьерист', tasks: [
            { text: 'Главная задача до 12:00', area: 'career' },
            { text: '3 контакта/звонка по делу', area: 'career' },
            { text: 'Итоги дня в заметки', area: 'career' },
            { text: 'Час без уведомлений', area: 'emotion' },
            { text: 'Проверить бюджет недели', area: 'finance' }
        ] },
        { id: 'hearth', name: 'Хранитель очага', tasks: [
            { text: 'Звонок родителям 10 минут', area: 'social' },
            { text: 'Убраться 15 минут', area: 'home' },
            { text: 'Ужин без телефона', area: 'social' },
            { text: 'Спросить близкого, как день', area: 'social' },
            { text: 'Приготовить ужин дома', area: 'home' }
        ] },
        { id: 'creator', name: 'Творец', tasks: [
            { text: 'Творить 20 минут', area: 'growth' },
            { text: 'Дневник 5 предложений', area: 'emotion' },
            { text: 'Час без телефона утром', area: 'emotion' },
            { text: 'Сохранить момент дня (фото/запись)', area: 'emotion' },
            { text: 'Творческий скетч', area: 'growth' }
        ] }
    ];

    // === КОЛЕСО ЖИЗНИ: СФЕРЫ ===
    const LIFE_AREAS = [
        { id: 'career',  name: 'Карьера',                 short: 'Карьера' },
        { id: 'home',    name: 'Дом',                     short: 'Дом' },
        { id: 'energy',  name: 'Энергия',                 short: 'Энергия' },
        { id: 'finance', name: 'Финансы',                 short: 'Финансы' },
        { id: 'social',  name: 'Социальная жизнь',        short: 'Социум' },
        { id: 'growth',  name: 'Саморазвитие',            short: 'Развитие' },
        { id: 'emotion', name: 'Эмоциональное состояние', short: 'Эмоции' }
    ];

    // === PSYCHO MODE: ДЕФОЛТНЫЙ НАБОР МЕТРИК (дальше юзер сам добавляет/удаляет) ===
    // type: 'goal' (больше = лучше) | 'limit' (меньше = лучше)
    // Дефолтный набор для новых юзеров. Дальше живой список — в dashState.metrics (юзер сам добавляет/удаляет).
    // Юзер попросил по умолчанию только 1 показатель, не 7 — остальные (км пробежал/сон/деньги/
    // медитация/страницы/сигареты/кофе) убраны из дефолта, юзер добавляет их сам через «+ добавить
    // показатель». Единственный оставшийся — «Поблагодарить <имя пригласившего> за Live Life
    // трекер», 5 раз в день; имя подставляется в cloneMetrics(), сам DEFAULT_METRICS хранит
    // болванку с {name} — заготовку под window.referrerName.
    const DEFAULT_METRICS = [
        { id: 'gratitude', name: 'Поблагодарить {name} за Live Life трекер', unit: 'раз', type: 'goal', target: 5 }
    ];
    // window.referrerName — имя того, кто позвал (по реферальной ссылке), ставит auth.js
    // (telegramSignIn → get_referrer_name, db/phase18_…sql) ДО вызова createDefaultState. Если
    // юзер пришёл не по ссылке (органическая установка) — подставляем «судьбу» (как и было
    // изначально, до того как юзер уточнил, что имел в виду именно пригласившего).
    const cloneMetrics = () => DEFAULT_METRICS.map(m => ({
        ...m,
        name: m.name.includes('{name}') ? m.name.replace('{name}', window.referrerName || 'судьбу') : m.name
    }));
    const metricTarget = m => {
        const t = dashState.metricTargets && dashState.metricTargets[m.id];
        return (t === undefined || t === null) ? m.target : t;
    };

    // habitsSource: не передан → универсальный DEFAULT_HABITS (7 сфер); массив (в т.ч. пустой [],
    // всегда truthy в JS) — из экрана выбора категории (см. showCategoryPicker), пустой = «определю сам».
    function createDefaultState(habitsSource) {
        const src = habitsSource || DEFAULT_HABITS;
        return {
            level: 1,
            currentXP: 0,
            habits: src.map(h => ({ text: h.text, completed: false, uid: newUid(), areas: h.area ? [h.area] : [] })),
            unlockedGames: [], // пусто на старте → выбор первой игры при открытии «Игр»
            lastActiveDate: todayKey(),
            checkins: { morning: {}, evening: {} },
            checkinHistory: {},
            history: {},
            foodLog: {},
            foodMealSlots: {},
            gameRecords: {},
            calorieLog: {},
            calorieTarget: 2000,
            psychoMode: false,
            metrics: cloneMetrics(), // живой список числовых показателей (юзер добавляет/удаляет)
            metricTargets: {},
            metricLog: {},
            onboardingDone: false, // новый пользователь — покажем тур
            seenHints: {},
            dayEvents: {}, // «событие дня» по ключу даты (YYYY-MM-DD), см. renderDayEventAndTask()
            dayTasks: {}   // «задача дня» по ключу даты: { text, done }, см. renderDayEventAndTask()
        };
    }

    // Экран выбора категории (только у нового юзера, между интро и дашбордом). onDone получает
    // либо массив {text,area} выбранной категории, либо null («определю задачи самостоятельно»
    // — пустой список привычек, юзер добавляет через «+ добавить задачу» в «Задачах»).
    function showCategoryPicker(onDone) {
        const screen = document.getElementById('category-picker-screen');
        const carousel = document.getElementById('cat-picker-carousel');
        const dots = document.getElementById('cat-picker-dots');
        const confirmBtn = document.getElementById('cat-picker-confirm-btn');
        if (!screen || !carousel || !dots || !confirmBtn) { onDone(null); return; }

        let selectedId = null;
        // Карточка — прямоугольник со скруглёнными углами на чёрном фоне экрана; по умолчанию белая
        // с чёрным текстом, при выборе (.selected) инвертируется в чёрную с белым текстом (см. CSS).
        // Заголовок анимируется въездом при попадании карточки в центр (см. .cat-card.active ниже).
        carousel.innerHTML = ONBOARDING_CATEGORIES.map((cat, i) => `
            <div class="cat-card${i === 0 ? ' active' : ''}" data-id="${cat.id}">
                <div class="cat-card-inner">
                    <div class="cat-card-heading">
                        <div class="cat-card-name">${cat.name}</div>
                    </div>
                    <ul class="cat-card-tasks">${cat.tasks.map(t => `<li>${t.text}</li>`).join('')}</ul>
                </div>
            </div>`).join('');
        dots.innerHTML = ONBOARDING_CATEGORIES.map((_, i) => `<span class="cat-picker-dot${i === 0 ? ' active' : ''}"></span>`).join('');

        function updateConfirmBtn() {
            confirmBtn.textContent = selectedId ? 'Подтвердить' : 'Определить задачи самостоятельно';
        }
        updateConfirmBtn();

        carousel.querySelectorAll('.cat-card').forEach(card => {
            card.addEventListener('click', () => {
                const id = card.dataset.id;
                const already = selectedId === id;
                carousel.querySelectorAll('.cat-card').forEach(c => c.classList.remove('selected'));
                selectedId = already ? null : id;
                if (!already) card.classList.add('selected');
                updateConfirmBtn();
            });
        });

        // Точки-индикаторы + активная карточка (для анимации заголовка) — подсвечиваем ближайшую
        // к центру видимую карточку при скролле. classList.toggle не трогает DOM, если значение не
        // поменялось, поэтому CSS-анимация заголовка не перезапускается на каждый scroll-тик — только
        // когда реально сменилась активная карточка.
        carousel.onscroll = () => {
            const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
            dots.querySelectorAll('.cat-picker-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
            carousel.querySelectorAll('.cat-card').forEach((c, i) => c.classList.toggle('active', i === idx));
        };

        confirmBtn.onclick = () => {
            screen.style.display = 'none';
            carousel.onscroll = null;
            const cat = ONBOARDING_CATEGORIES.find(c => c.id === selectedId);
            // [] (не null!) — null falsy в JS и в createDefaultState() свалился бы обратно
            // на DEFAULT_HABITS через `habitsSource || DEFAULT_HABITS` (поймано при проверке).
            onDone(cat ? cat.tasks : []);
        };

        screen.style.display = 'flex';
    }

    // === ИНИЦИАЛИЗАЦИЯ ===
    function init() {
        const saved = loadProgress();
        // Array.isArray, а не saved.habits.length — юзер, выбравший на онбординге «Определить
        // задачи самостоятельно» (showCategoryPicker → habits: [], намеренно пустой массив, см.
        // HANDOFF.md §17), с проверкой на .length каждый раз попадал обратно на интро/выбор
        // категории вместо дашборда: пустой массив тоже falsy для .length, поэтому уже
        // онбордившийся юзер выглядел как «новый» при КАЖДОМ повторном заходе — баг-репорт юзера
        // «прогресс не сохранился, когда зашёл второй раз» (см. HANDOFF.md). habits как МАССИВ
        // (даже пустой) есть только после реального прохождения онбординга/createDefaultState —
        // pristine localStorage вообще не содержит ключ habits, там loadProgress() отдаёт null.
        if (saved && Array.isArray(saved.habits)) {
            dashState = { ...dashState, ...saved };
            if (!dashState.checkins) dashState.checkins = { morning: {}, evening: {} };
            if (!dashState.checkinHistory) dashState.checkinHistory = {};
            if (!dashState.history) dashState.history = {};
            if (!dashState.foodLog) dashState.foodLog = {};
            if (!dashState.foodMealSlots) dashState.foodMealSlots = {};
            if (!dashState.gameRecords) dashState.gameRecords = {};
            if (!dashState.calorieLog) dashState.calorieLog = {};
            if (typeof dashState.calorieTarget !== 'number') dashState.calorieTarget = 2000;
            if (!dashState.unlockedGames) dashState.unlockedGames = [];
            if (!dashState.metricLog) dashState.metricLog = {};
            if (!dashState.metricTargets) dashState.metricTargets = {};
            if (!dashState.dayEvents) dashState.dayEvents = {};
            if (!dashState.dayTasks) dashState.dayTasks = {};
            // миграция: у старых сейвов не было массива метрик → сидируем дефолтным набором
            // (новый набор уже без «калорий» и «claude»; цели/логи по сохранившимся id остаются).
            // Проверяем именно saved.metrics: пустой массив в сейве = юзер удалил все метрики, его не трогаем.
            if (!Array.isArray(saved.metrics)) dashState.metrics = cloneMetrics();
            if (typeof dashState.psychoMode !== 'boolean') dashState.psychoMode = false;
            // существующих пользователей считаем уже «онбордившимися» — тур не показываем
            if (typeof dashState.onboardingDone !== 'boolean') { dashState.onboardingDone = true; dashState.seenHints = { month: true, morning: true, evening: true }; }
            if (!dashState.seenHints) dashState.seenHints = {};
            ensureHabitUids(); // миграция: гарантируем uid у старых привычек
            dashState.habits.forEach(h => { if (!Array.isArray(h.areas)) h.areas = []; });
            window.dashState = dashState;
            checkNewDay();
            showDashboard(); // вернувшийся пользователь — сразу на «День»
            // Если это устройство только что перезаписало свои данные облачной версией с другого
            // устройства (см. window.applyCloudState в saveProgress) — проталкиваем ВОССТАНОВЛЕННЫЕ
            // (уже лежащие в dashState/localStorage после перезагрузки) данные обратно в облако,
            // перекрывая чужую версию. Флаг ставит checkForBackupRestore() перед reload.
            if (localStorage.getItem('habbittracker_needs_push_after_restore')) {
                localStorage.removeItem('habbittracker_needs_push_after_restore');
                saveProgress();
            }
            checkForBackupRestore();
        } else {
            introScreen.style.opacity = '1'; // статичный текст-интро, фразы больше не сменяются
        }
    }

    // Ждём window.requireAuth (auth.js — модуль, грузится асинхронно с CDN). Не бесконечно:
    // если за 10с не подгрузился (сеть/CDN легли), даём понятную ошибку вместо вечного спиннера.
    function waitForAuthGate(onReady, onTimeout, triesLeft) {
        if (triesLeft === undefined) triesLeft = 100;
        if (window.requireAuth) { onReady(); return; }
        if (triesLeft <= 0) { onTimeout(); return; }
        setTimeout(() => waitForAuthGate(onReady, onTimeout, triesLeft - 1), 100);
    }

    introScreen.addEventListener('click', () => {
        loadingOverlay.classList.add('active');
        setTimeout(() => {
            introScreen.style.opacity = '0';
            setTimeout(() => {
                introScreen.style.display = 'none';
                // В Telegram Mini App пользователь уже известен Telegram — не просим email/пароль
                // (тесная форма регистрации внутри WebView Telegram — плохой UX, см. HANDOFF.md §15).
                if (isTelegramContext()) {
                    const proceedLocal = () => {
                        loadingOverlay.classList.remove('active');
                        // Новый юзер выбирает набор задач по категории или «сам» — см. HANDOFF.md §16.
                        showCategoryPicker((chosenTasks) => {
                            dashState = createDefaultState(chosenTasks);
                            window.dashState = dashState;
                            saveProgress();
                            showDashboard();
                        });
                    };
                    // Пытаемся подтвердить identity через Edge Function telegram-auth (auth.js →
                    // window.telegramSignIn): проверка initData на сервере + настоящая Supabase-сессия,
                    // трекинг триала на бэке. Если функция ещё не задеплоена/сеть недоступна — тихо
                    // откатываемся на локальный режим, чтобы юзер не упёрся в сломанный экран, пока
                    // бэкенд донастраивается (см. HANDOFF.md §15).
                    if (typeof window.telegramSignIn === 'function') {
                        window.telegramSignIn(window.Telegram.WebApp.initData)
                            .then(res => { if (!res || !res.ok) console.warn('telegramSignIn: локальный режим,', res && res.error); })
                            .catch(() => {})
                            .then(proceedLocal);
                    } else {
                        proceedLocal();
                    }
                    return;
                }
                // Вход обязателен: показываем форму входа/регистрации и не пускаем в «День»,
                // пока юзер не авторизуется. Дефолтные привычки создаём только ПОСЛЕ входа.
                waitForAuthGate(
                    () => {
                        loadingOverlay.classList.remove('active');
                        window.requireAuth(() => {
                            dashState = createDefaultState(); // первый запуск — дефолтные привычки
                            window.dashState = dashState;
                            saveProgress();
                            showDashboard(); // вход пройден → «День»
                        });
                    },
                    () => {
                        loadingOverlay.classList.remove('active');
                        introScreen.style.display = 'flex';
                        introScreen.style.opacity = '1';
                        const hint = document.querySelector('.hint-text');
                        if (hint) hint.textContent = 'Не удалось загрузить форму входа. Проверь соединение и обнови страницу.';
                    }
                );
            }, 500);
        }, 1500);
    });

    // Экран выбора идентичности и эволюции удалён — приложение сразу ведёт на «День».

    // === ПЕРЕКЛЮЧЕНИЕ ВИДОВ ===
    function switchView(viewName) {
        console.log('🔄 switchView:', viewName);
        // Все вкладки живут в одном скролл-контейнере (.dash-content, см. CSS) — просто переключение
        // display/active не сбрасывает scrollTop, поэтому «Чек-ап»/«Питание» открывались с той же
        // прокруткой, что осталась от «Задач» (юзер сообщил, что выглядит как «открывается по
        // центру»). Сбрасываем скролл к началу при каждом переключении вкладки.
        const dashContent = document.querySelector('.dash-content');
        if (dashContent) dashContent.scrollTop = 0;
        // Смена вкладки уничтожает содержимое старой вместе со сфокусированным инпутом — момент,
        // когда таб-бар мог остаться скрытым навсегда (см. initKeyboardAwareBottomBar).
        if (window.syncBottomBar) window.syncBottomBar();
        renderTopNavSlot(''); // «Задачи» (viewName === 'month') сама заполнит слот заново ниже
        document.querySelectorAll('.dash-view').forEach(view => view.classList.remove('active'));
        const target = document.getElementById(`view-${viewName}`);
        if (target) target.classList.add('active'); // синхронно — иначе быстрые переключения оставляют 2 активных вида
        if (viewName === 'habits') { startDayTimer(); } else if (timerInterval) { clearInterval(timerInterval); }
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.remove('active');
            // У «Задачи»/«Питание» по ДВЕ кнопки с одинаковым data-view (base и Pro, см.
            // index.html) — без сверки data-mode подсветились бы обе сразу. Кнопки без data-mode
            // (Чек-ап и прочие) от режима не зависят и сверяются только по data-view.
            const modeOk = !btn.dataset.mode || (btn.dataset.mode === 'pro') === !!dashState.psychoMode;
            if (btn.dataset.view === viewName && modeOk) btn.classList.add('active');
        });
        if (viewName === 'habits') renderDayView();
        else if (viewName === 'training') initTrainingMenu();
        else if (viewName === 'month') { monthCursor = null; renderMonthView(); }
        else if (viewName === 'pet') renderPet();
        else if (viewName === 'food') renderFood();
        else if (viewName === 'morning' || viewName === 'evening') {
            initCheckins(viewName);
            // Графики «настроение/сон» переехали сюда из вкладки «Месяц» (см. HANDOFF.md §15).
            // Каждый заход в «Чек-ап» начинает с ТЕКУЩЕГО календарного месяца (checkupChartCursor
            // сбрасывается в null → renderCheckupCharts подставит today) — как и monthCursor у
            // «Задач», листание месяцами внутри вкладки не запоминается между заходами.
            if (viewName === 'morning') {
                checkupChartCursor = null;
                renderCheckupCharts();
            }
        }
        updateCheckinButtonPulse();
        maybeShowViewHint(viewName); // контекстная подсказка при первом заходе
    }

    function updateCheckinButtonPulse() {
        const morningBtn = document.getElementById('btn-morning');
        const eveningBtn = document.getElementById('btn-evening');
        const today = new Date().toISOString().split('T')[0];
        const history = dashState.checkinHistory || {};
        const todayData = history[today] || {};
        
        if (morningBtn) {
            // В Pro mode кнопка «Чек-ап» видна (юзер попросил не прятать её, см. HANDOFF.md), но
            // пульс-напоминание про незаполненный чек-ап там всё равно не показываем — Pro mode
            // про свои числовые показатели, не про чек-ап.
            const hasMorning = todayData.morning && Object.keys(todayData.morning).length > 0;
            morningBtn.classList.toggle('pulse', !hasMorning && !dashState.psychoMode);
        }
        if (eveningBtn) {
            const hasEvening = todayData.evening && Object.keys(todayData.evening).length > 0;
            eveningBtn.classList.toggle('pulse', !hasEvening);
        }
    }

    function updateDateLabel(type, dateStr) {
        const labelEl = document.getElementById(`date-label-${type}`);
        if (!labelEl) return;
        
        const today = new Date().toISOString().split('T')[0];
        if (!dateStr || dateStr === today) {
            labelEl.textContent = 'Сегодня';
        } else {
            // Преобразуем YYYY-MM-DD в DD.MM.YYYY
            const [y, m, d] = dateStr.split('-');
            labelEl.textContent = `${d}.${m}.${y}`;
        }
    }

    // === ИКОНКИ (моно, ч/б) ===
    const FLAME = '<svg class="flame" viewBox="0 0 384 512" width="9" height="11" fill="currentColor" aria-hidden="true"><path d="M216 24c0-15-19-22-29-11C147 60 96 137 96 248c-22-13-36-33-44-57-4-11-19-14-26-4C10 211 0 247 0 288c0 106 86 192 192 192s192-86 192-192c0-104-63-180-120-238-11-11-30-4-30 11v40c0 31-25 56-56 56-23 0-40-15-40-37 0-30 38-50 78-96z"/></svg>';
    const DOTS = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
    const LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
    const CALENDAR_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>';

    // «Задачи»/«Питание» существуют ДВУМЯ отдельными кнопками — base и Pro (последние с боковой
    // полоской «PRO MODE», см. .vb-promode-label в CSS и разметку в index.html). Юзер отказался от
    // идеи совмещённой кнопки-переключателя (см. HANDOFF.md §58–61): никакого тумблинга по клику,
    // режим выбирается явно — какую кнопку нажал, тот режим и открылся. Pro-кнопки видны ВСЕГДА,
    // не только с подпиской (юзер: «в каждой из двух закрытых вкладок показать детали») — без
    // подписки клик по ним открывает превью-пейволл конкретно этой вкладки вместо входа в режим
    // (см. обработчик .view-btn ниже и openProModePaywall(kind)). Отдельного тумблера-замка
    // (#psycho-toggle) больше нет — юзер попросил убрать его целиком, сами Pro-кнопки играют его
    // роль. Никакой отдельной синхронизации видимости этим кнопкам не нужно.
    const streakChip = n => n > 0 ? `<span class="dash-habit-streak">${FLAME}${n}</span>` : '';

    // === ИГРЫ: МЕТА И РАЗБЛОКИРОВКА ПО УРОВНЯМ ===
    const GAMES = {
        count:  { name: 'Посчитай', desc: 'Быстрый счёт на время' },
        words:  { name: '10 слов', desc: 'Запомни и введи' },
        sudoku: { name: 'Быстрое судоку', desc: 'По пропуску в квадрате' }
    };
    const GAME_ORDER = ['count', 'words', 'sudoku']; // «Найди пару» убрана по просьбе юзера
    // Ключ рекорда каждой игры + как его показать в меню (см. initTrainingMenu/updateGameRecord).
    const GAME_RECORD_META = {
        sudoku: { key: 'bestTimeMs', fmt: (v) => fmtGameTime(v) },
        count:  { key: 'bestCorrect', fmt: (v) => `${v} верных` },
        words:  { key: 'bestCorrect', fmt: (v) => `${v} верных` }
    };
    const UNLOCK_LEVELS = [3, 7, 10]; // на этих уровнях даётся выбор новой игры
    const maxUnlockable = () => Math.min(1 + UNLOCK_LEVELS.filter(l => dashState.level >= l).length, GAME_ORDER.length);
    const lockedGames = () => GAME_ORDER.filter(g => !dashState.unlockedGames.includes(g));
    function checkGameUnlock() {
        if (!FEATURES.games) return;
        if (dashState.unlockedGames.length < maxUnlockable() && lockedGames().length) openGameUnlockModal();
    }
    function openGameUnlockModal() {
        const modal = document.getElementById('game-unlock-modal');
        const list = document.getElementById('game-unlock-list');
        if (!modal || !list) return;
        const first = dashState.unlockedGames.length === 0; // самый первый выбор игры
        const badge = modal.querySelector('.game-unlock-badge');
        const title = modal.querySelector('.game-unlock-title');
        const sub = modal.querySelector('.game-unlock-subtitle');
        if (first) {
            if (badge) badge.style.display = 'none';
            if (title) title.textContent = 'Выбери первую игру';
            if (sub) sub.textContent = 'Следующие открываются с уровнями';
        } else {
            if (badge) { badge.style.display = ''; badge.innerHTML = `уровень <span id="game-unlock-level">${dashState.level}</span>`; }
            if (title) title.textContent = 'Новая игра открыта';
            if (sub) sub.textContent = 'Выбери, что добавить';
        }
        list.innerHTML = '';
        lockedGames().forEach(g => {
            const opt = document.createElement('button');
            opt.className = 'game-option';
            opt.innerHTML = `<span class="game-option-name">${GAMES[g].name}</span><span class="game-option-desc">${GAMES[g].desc}</span>`;
            opt.addEventListener('click', () => {
                dashState.unlockedGames.push(g);
                saveProgress();
                modal.classList.remove('active');
                initTrainingMenu(); // перерисовать меню + проверить следующий порог
            });
            list.appendChild(opt);
        });
        modal.classList.add('active');
    }

    // === ДАШБОРД ===
    function showDashboard() {
        introScreen.style.display = 'none';
        dashboardScreen.classList.add('visible');
        dashboardScreen.classList.toggle('psycho-invert', !!dashState.psychoMode);
        switchView('month'); // «Задачи» (бывший «Месяц») — теперь основная вкладка, см. HANDOFF.md §15
        updateProgressUI();
        startReminderChecker();
        updateCheckinButtonPulse();
        initHistoryLogic();
        updatePetRoamer(); // десктоп: запустить «бегающего» питомца
        if (!dashState.onboardingDone) setTimeout(() => startTour(DAY_TOUR), 700); // новый пользователь — вводный тур
    }

    // Полное название дня — «3 августа, понедельник» — переехало из бывшей фиксированной шапки
    // (updateDashDate) в новую навигацию по дням внутри «Задачи»/Pro mode (см. renderDayNavControls).
    const FULL_MONTH_NAMES = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const FULL_WD_NAMES = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
    function formatFullDate(dateKey) {
        const [y, m, d] = dateKey.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return `${d} ${FULL_MONTH_NAMES[dt.getMonth()]}, ${FULL_WD_NAMES[dt.getDay()]}`;
    }
    function addDaysToKey(dateKey, delta) {
        const [y, m, d] = dateKey.split('-').map(Number);
        const dt = new Date(y, m - 1, d + delta);
        return fdt(dt.getFullYear(), dt.getMonth(), dt.getDate());
    }

    // Верхняя панель (index.html, .dash-toprow) — единый ряд [?] — [нав-слот] — [профиль].
    // Слот заполняют renderMonthView/renderTaskDayView/renderPsychoDay/renderPsychoMonth своей
    // навигацией (стрелки + подпись даты/месяца), а switchView() чистит его при уходе с «Задач».
    function renderTopNavSlot(html) {
        const slot = document.getElementById('top-nav-slot');
        if (slot) slot.innerHTML = html || '';
    }
    // Та же разметка/классы, что у dayNavHeaderHtml (юзер попросил одинаковый шрифт подписи и
    // одинаковые отступы между стрелками в обеих шапках) — 4-я кнопка открывает пикер месяца
    // (openMonthPicker) вместо клика по названию, тем же паттерном, что календарь у дня.
    function monthHeadHtml(y, m) {
        return `<div class="checkin-header-row day-nav-row">
            <button class="day-nav-arrow" id="month-prev" type="button" aria-label="Предыдущий месяц">←</button>
            <span class="checkin-date-label day-nav-label">${MONTH_NAMES[m]} ${y}</span>
            <button class="day-nav-arrow" id="month-next" type="button" aria-label="Следующий месяц">→</button>
            <button class="history-btn" id="month-cal" title="Открыть выбор месяца">${CALENDAR_ICON}</button>
        </div>`;
    }

    // Навигация «‹ 3 августа, понедельник ›» + кнопка календаря — общая и для normal-mode «День»
    // (renderTaskDayView), и для Pro mode (renderPsychoDay). idPrefix различает элементы двух видов
    // на странице (если вдруг оба когда-нибудь окажутся в DOM одновременно). onChange(dateKey)
    // вызывается при переключении — вызывающая сторона сама решает, что перерисовать.
    function dayNavHeaderHtml(dateKey, idPrefix) {
        const isToday = dateKey === todayKey();
        return `<div class="checkin-header-row day-nav-row">
            <button class="day-nav-arrow" id="${idPrefix}-prev" type="button" aria-label="Предыдущий день">←</button>
            <span class="checkin-date-label day-nav-label">${isToday ? 'Сегодня' : formatFullDate(dateKey)}</span>
            <button class="day-nav-arrow" id="${idPrefix}-next" type="button" aria-label="Следующий день"${isToday ? ' disabled' : ''}>→</button>
            <button class="history-btn" id="${idPrefix}-cal" title="Открыть календарь">${CALENDAR_ICON}</button>
        </div>`;
    }
    function wireDayNavHeader(idPrefix, dateKey, onChange) {
        const prevBtn = document.getElementById(`${idPrefix}-prev`);
        const nextBtn = document.getElementById(`${idPrefix}-next`);
        const calBtn = document.getElementById(`${idPrefix}-cal`);
        if (prevBtn) prevBtn.addEventListener('click', () => onChange(addDaysToKey(dateKey, -1)));
        if (nextBtn) nextBtn.addEventListener('click', () => { if (dateKey < todayKey()) onChange(addDaysToKey(dateKey, 1)); });
        if (calBtn) calBtn.addEventListener('click', () => openCalendar({ value: dateKey, onPick: onChange }));
    }

    function renderDashboardHabits() {
        const list = document.getElementById('dash-habit-list');
        if (!list) return;
        list.innerHTML = '';

        // Та же группировка «Регулярные»/«Разовые», что в renderTaskDayView (эта вьюха всегда про
        // сегодня, поэтому разовые фильтруются по today). data-idx считается через indexOf в
        // ПОЛНОМ dashState.habits, не по позиции в отфильтрованном списке.
        const allHabits = dashState.habits;
        const regularHabits = allHabits.filter(h => (h.type || 'regular') === 'regular');
        const oneTimeHabits = allHabits.filter(h => h.type === 'oneTime' && h.date === todayKey());
        const renderRow = (habit, groupEl) => {
            const index = allHabits.indexOf(habit);
            const row = document.createElement('div');
            row.className = `dash-habit-row ${habit.completed ? 'completed' : ''}`;
            row.dataset.uid = habit.uid;
            let subtextHtml = '';
            if (habit.triggerText) subtextHtml += `<span>после того как ${esc(habit.triggerText)}</span>`;
            if (habit.reminderTime) subtextHtml += `<span>напомнить в ${esc(habit.reminderTime)}</span>`;
            row.innerHTML = `<div class="habit-main-line"><span class="habit-check"></span><span class="dash-habit-text">${esc(habit.text)}</span>${habit.type === 'oneTime' ? '' : streakChip(currentStreak(habit.uid))}<span class="habit-settings-icon">${DOTS}</span></div>${subtextHtml ? `<div class="habit-subtext">${subtextHtml}</div>` : ''}`;
            row.querySelector('.habit-check').addEventListener('click', () => toggleHabit(index, row));
            row.querySelector('.dash-habit-text').addEventListener('click', () => toggleHabit(index, row));
            row.querySelector('.habit-settings-icon').addEventListener('click', (e) => { e.stopPropagation(); openHabitSettings(index); });
            wireRowDrag(row, groupEl, renderDashboardHabits);
            groupEl.appendChild(row);
        };
        if (regularHabits.length) {
            list.insertAdjacentHTML('beforeend', '<div class="task-group-label">Регулярные</div>');
            const group = document.createElement('div');
            group.className = 'dash-habit-group';
            list.appendChild(group);
            regularHabits.forEach(h => renderRow(h, group));
        }
        if (oneTimeHabits.length) {
            list.insertAdjacentHTML('beforeend', '<div class="task-group-label">Разовые</div>');
            const group = document.createElement('div');
            group.className = 'dash-habit-group';
            list.appendChild(group);
            oneTimeHabits.forEach(h => renderRow(h, group));
        }

        // добавление новой привычки (до лимита MAX_HABITS, разовые в лимит не входят) — сразу
        // открывает модалку настроек (см. openNewHabitModal), а не инлайн-инпут.
        if (regularHabits.length < MAX_HABITS) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'dash-habit-add-btn';
            add.id = 'add-habit-btn';
            add.textContent = '+ добавить задачу';
            add.addEventListener('click', () => openNewHabitModal(todayKey()));
            list.appendChild(add);
        } else {
            const note = document.createElement('div');
            note.className = 'dash-habit-limit';
            note.textContent = `Максимум ${MAX_HABITS} задач`;
            list.appendChild(note);
        }
        if (FEATURES.lifeWheel) renderLifeWheel('day', 'life-wheel-day'); // колесо отражает выполнение
    }

    // Реордер задач через «нажать и удержать». Долгий тач/клик на строке (не на настройках)
    // включает режим перетаскивания; свайп вверх/вниз меняет строки местами внутри своей группы
    // (Регулярные/Разовые порознь — метки-разделители не пересекаются). Порядок фиксируется в
    // dashState.habits по фактическим слотам группы, остальной массив не трогается.
    const DRAG_LONG_PRESS_MS = 380;
    const DRAG_MOVE_CANCEL_PX = 10;
    function wireRowDrag(row, groupEl, onReorder) {
        let pressTimer = null;
        let dragging = false;
        let startY = 0, startX = 0, lastY = 0;

        function clearPressTimer() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }
        function cleanupEarly() {
            row.removeEventListener('pointermove', onEarlyMove);
            row.removeEventListener('pointerup', onEarlyUp);
            row.removeEventListener('pointercancel', onEarlyUp);
        }
        // Строка держит touch-action:none (см. CSS) — иначе на реальных тачах браузер отдаёт
        // жест нативному скроллу раньше, чем успевает сработать долгий тап (см. HANDOFF.md §67г/д).
        // Но это же вырубает нативный скролл списка свайпом ПРЯМО по строке — поэтому пока не
        // истекли DRAG_LONG_PRESS_MS и сдвиг больше DRAG_MOVE_CANCEL_PX (обычный быстрый свайп,
        // не долгий тап), скроллим контейнер сами вручную, 1-в-1 повторяя движение пальца.
        function onEarlyMove(e) {
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (pressTimer && (Math.abs(dx) > DRAG_MOVE_CANCEL_PX || Math.abs(dy) > DRAG_MOVE_CANCEL_PX)) clearPressTimer();
            if (!pressTimer) {
                e.preventDefault();
                groupEl.scrollTop -= (e.clientY - lastY);
                lastY = e.clientY;
            }
        }
        function onEarlyUp() { clearPressTimer(); cleanupEarly(); }

        function onPointerDown(e) {
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target.closest('.habit-settings-icon, .task-day-settings')) return; // не мешаем открытию настроек
            startX = e.clientX; startY = e.clientY; lastY = e.clientY;
            clearPressTimer();
            pressTimer = setTimeout(() => startDrag(e), DRAG_LONG_PRESS_MS);
            row.addEventListener('pointermove', onEarlyMove, { passive: false });
            row.addEventListener('pointerup', onEarlyUp);
            row.addEventListener('pointercancel', onEarlyUp);
        }

        function suppressClickOnce(e) {
            e.stopPropagation(); e.preventDefault();
            row.removeEventListener('click', suppressClickOnce, true);
        }

        function startDrag(e) {
            cleanupEarly();
            dragging = true;
            row.addEventListener('click', suppressClickOnce, true); // долгий хап без сдвига не должен отмечать задачу выполненной
            // Без setPointerCapture: на мобильных WebView перестановка ЗАХВАЧЕННОГО элемента
            // в DOM (insertBefore при свапе строк) может молча сбросить захват и оборвать жест
            // (pointercancel) после первой же перестановки — драг «замирает». Слушатели висят
            // на document, так что захват и не нужен (см. HANDOFF.md §67г).
            row.classList.add('dragging');
            row.style.touchAction = 'none';
            document.body.style.userSelect = 'none';
            try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
            document.addEventListener('pointermove', onDragMove, { passive: false });
            document.addEventListener('pointerup', onDragEnd);
            document.addEventListener('pointercancel', onDragEnd);
        }

        function onDragMove(e) {
            if (!dragging) return;
            e.preventDefault();
            const dy = e.clientY - startY;
            row.style.transform = `translateY(${dy}px)`;
            // Максимум одна перестановка за событие — переставлять больше за раз, используя
            // тот же (уже устаревший после первого insertBefore) dy для проверки следующего
            // соседа, приводило на реальных тачах к «пинг-понгу» туда-обратно в одном и том
            // же событии: видимая дрожь без изменения фактического порядка (см. HANDOFF.md §67в).
            const children = Array.from(groupEl.children);
            const rowIndex = children.indexOf(row);
            const rowRect = row.getBoundingClientRect();
            const prev = children[rowIndex - 1];
            if (prev) {
                const pr = prev.getBoundingClientRect();
                if (rowRect.top < pr.top + pr.height / 2) {
                    groupEl.insertBefore(row, prev);
                    row.style.transform = 'translateY(0px)';
                    startY = e.clientY;
                    return;
                }
            }
            const next = children[rowIndex + 1];
            if (next) {
                const nr = next.getBoundingClientRect();
                if (rowRect.bottom > nr.top + nr.height / 2) {
                    groupEl.insertBefore(row, next.nextSibling);
                    row.style.transform = 'translateY(0px)';
                    startY = e.clientY;
                }
            }
        }

        function onDragEnd() {
            dragging = false;
            clearPressTimer();
            document.removeEventListener('pointermove', onDragMove);
            document.removeEventListener('pointerup', onDragEnd);
            document.removeEventListener('pointercancel', onDragEnd);
            row.classList.remove('dragging');
            row.style.transform = '';
            row.style.touchAction = '';
            document.body.style.userSelect = '';
            const uidsInGroup = Array.from(groupEl.children).map(el => el.dataset.uid);
            applyHabitOrder(uidsInGroup);
            saveProgress();
            onReorder();
        }

        row.addEventListener('pointerdown', onPointerDown);
    }

    // Ставит привычки группы (набор uid в новом визуальном порядке) на те же позиции индексов
    // в dashState.habits, которые они занимали до перетаскивания — так порядок других групп и
    // прочие данные, завязанные на индекс, не сбиваются мимо этого драга.
    function applyHabitOrder(uidsInGroup) {
        const byUid = new Map(dashState.habits.map(h => [h.uid, h]));
        const groupHabits = uidsInGroup.map(uid => byUid.get(uid)).filter(Boolean);
        const uidSet = new Set(uidsInGroup);
        const slots = [];
        dashState.habits.forEach((h, i) => { if (uidSet.has(h.uid)) slots.push(i); });
        slots.forEach((slotIdx, k) => { dashState.habits[slotIdx] = groupHabits[k]; });
    }

    function updateRowStreak(rowElement, uid) {
        const existing = rowElement.querySelector('.dash-habit-streak');
        if (existing) existing.remove();
        const s = currentStreak(uid);
        if (s > 0) rowElement.querySelector('.dash-habit-text').insertAdjacentHTML('afterend', streakChip(s));
    }

    function pulseLevel() {
        const el = document.getElementById('dash-level-value');
        if (!el) return;
        el.style.transform = 'scale(1.4)';
        setTimeout(() => { el.style.transform = 'scale(1)'; }, 300);
    }

    function toggleHabit(index, rowElement) {
        const habit = dashState.habits[index];
        const nowDone = !habit.completed;
        habit.completed = nowDone;
        rowElement.classList.toggle('completed', nowDone);
        setHistory(habit.uid, todayKey(), nowDone); // постоянный лог за сегодня
        updateRowStreak(rowElement, habit.uid);
        if (FEATURES.lifeWheel) renderLifeWheel('day', 'life-wheel-day'); // колесо обновляется при отметке

        // XP — только при выполнении и не больше одного раза за день (без фарма)
        if (nowDone && habit.xpDate !== todayKey()) {
            habit.xpDate = todayKey();
            awardXP(getLevelStats(dashState.level).xpPerHabit); // обновит UI, сохранит, проверит разблокировку
        } else {
            updateProgressUI();
            saveProgress();
        }
    }

    // Анимированный «счётчик» — плавно докручивает число от текущего к новому + короткий пульс
    // масштаба (см. .num-pulse в CSS). Используется для сводки месяца при отметке привычки.
    function animateNumber(el, to, suffix) {
        suffix = suffix || '';
        const from = parseInt(el.textContent, 10) || 0;
        if (from === to) { el.textContent = to + suffix; return; }
        el.classList.remove('num-pulse'); void el.offsetWidth; el.classList.add('num-pulse');
        const duration = 420;
        const start = performance.now();
        (function tick(now) {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = Math.round(from + (to - from) * eased) + suffix;
            if (t < 1) requestAnimationFrame(tick);
        })(start);
    }

    function updateProgressUI() {
        const stats = getLevelStats(dashState.level);
        const percent = Math.min(100, (dashState.currentXP / stats.xpNeeded) * 100);
        document.getElementById('progress-fill').style.width = `${percent}%`;
        document.getElementById('progress-text').textContent = `${dashState.currentXP} / ${stats.xpNeeded} XP`;
        document.getElementById('progress-percent').textContent = `${Math.round(percent)}%`;
        const levelEl = document.getElementById('dash-level-value');
        if (levelEl) levelEl.textContent = dashState.level;
    }

    // =========================================
    //   ВИД «МЕСЯЦ» — ИСТОРИЯ / ТЕПЛОВАЯ КАРТА
    // =========================================
    let monthCursor = null; // { y, m } — отображаемый месяц
    // Pro mode во вкладке «Задачи» — переключатель «День» (сегодняшние показатели, ввод значений,
    // цели/лимиты — старая вкладка «День» была скрыта FEATURES.dayTab, но UI никуда не делся, см.
    // renderPsychoMetrics) / «Месяц» (сводка сумм за месяц, см. renderPsychoMonth).
    let psychoSubView = 'day';
    // Тот же переключатель «День»/«Месяц», но для ОБЫЧНОГО режима (не Pro) — «День» дефолт (базовая
    // вкладка приложения, юзер попросил сменить с «Месяца»). Тур DAY_TOUR адаптирован под это —
    // шаг с тепловой картой сам переключает подвид на 'month' перед показом (см. showCoachStep).
    let taskViewMode = 'day';
    let currentTaskDate = todayKey(); // дата, открытая в normal-mode «День» — листается стрелками/календарём
    const MONTH_NAMES = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const WD_SHORT = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

    function renderMonthView() {
        const root = document.getElementById('view-month');
        if (!root) return;
        if (!monthCursor) { const t = new Date(); monthCursor = { y: t.getFullYear(), m: t.getMonth() }; }
        const { y, m } = monthCursor;
        // Pro mode — «День» (ввод сегодняшних значений, цели/лимиты) либо «Месяц» (сводка сумм),
        // переключатель под шапкой (см. psychoSubView/renderPsychoDay/renderPsychoMonth).
        if (dashState.psychoMode) { (psychoSubView === 'day' ? renderPsychoDay : renderPsychoMonth)(y, m); return; }
        // Обычный режим — тот же переключатель «День»/«Месяц», что и в Pro mode (см. HANDOFF.md).
        // «День» — дефолт (см. HANDOFF.md §28).
        if (taskViewMode === 'day') { renderTaskDayView(currentTaskDate); return; }
        const days = daysInMonth(y, m);
        const dayList = Array.from({ length: days }, (_, i) => i + 1);
        // Разовые задачи в «Месяц» не попадают — у них нет понятия «прогресс за месяц», они видны
        // только в «Дне» того дня, для которого созданы (см. renderTaskDayView, openNewHabitModal).
        const habits = (dashState.habits || []).filter(h => (h.type || 'regular') === 'regular');
        const tKey = todayKey();

        // сводка месяца
        const monthStats = () => {
            let possible = 0, done = 0;
            dayList.forEach(d => { const k = fdt(y, m, d); habits.forEach(h => { possible++; if (isDone(h.uid, k)) done++; }); });
            return { possible, done, pct: possible ? Math.round(done / possible * 100) : 0 };
        };
        const st = monthStats();

        renderTopNavSlot(monthHeadHtml(y, m));
        root.innerHTML = `
            ${taskViewToggleHtml()}
            <div class="month-summary">
                <div class="month-stat"><span>${st.done}</span>выполнено</div>
                <div class="month-stat"><span>${st.possible}</span>возможно</div>
                <div class="month-stat"><span>${st.pct}%</span>прогресс</div>
            </div>
            <div class="month-progress"><div class="month-progress-fill" style="width:${st.pct}%"></div></div>
            <div class="month-hint">нажми на задачу, чтобы открыть календарь отметок</div>
            ${habits.length ? `<div class="heatmap" id="heatmap"></div>` : `<p class="month-empty">Пока нет задач — добавь ниже.</p>`}
            <div id="month-habit-add"></div>
            ${FEATURES.lifeWheel ? `<div class="month-wheel-block"><div id="life-wheel-month"></div></div>` : ''}
        `;
        wireTaskViewToggle(root);
        if (FEATURES.lifeWheel) renderLifeWheel('month', 'life-wheel-month', y, m);

        // «+ добавить задачу» — переехало сюда из бывшей вкладки «День» (см. HANDOFF.md §15),
        // сразу открывает модалку настроек (см. openNewHabitModal) вместо инлайн-инпута. Лимит
        // считает только регулярные — разовых из «Месяца» не бывает, но лимит общий на регулярные.
        const addBox = document.getElementById('month-habit-add');
        if (addBox) {
            if (habits.length < MAX_HABITS) {
                addBox.innerHTML = `<button type="button" class="dash-habit-add-btn" id="add-habit-btn-month">+ добавить задачу</button>`;
                addBox.querySelector('#add-habit-btn-month').addEventListener('click', () => openNewHabitModal(todayKey()));
            } else {
                addBox.innerHTML = `<div class="dash-habit-limit">Максимум ${MAX_HABITS} задач</div>`;
            }
        }

        const hm = document.getElementById('heatmap');
        if (hm) {
            // Вместо клеток на каждый день — одна полоса-прогресс за месяц (юзер попросил заменить
            // тепловую карту дней на сводку, см. HANDOFF.md). Отметка/снятие отметки за конкретный
            // день теперь только через модалку-календарь (openHabitHistoryCalendar) — открывается
            // кликом по строке, включает и сегодня, и задний числом.
            habits.forEach((h) => {
                // индекс в ПОЛНОМ dashState.habits (не в отфильтрованном habits — тут только
                // регулярные, см. выше), иначе «⋯» после фильтрации откроет не ту задачу.
                const hIdx = dashState.habits.indexOf(h);
                const streak = currentStreak(h.uid);
                const monthDone = dayList.filter(d => isDone(h.uid, fdt(y, m, d))).length;
                const pct = days ? Math.round(monthDone / days * 100) : 0;
                const doneToday = isDone(h.uid, tKey);
                // Подпись под названием — время напоминания и триггер «я сделаю после…», если заданы.
                let subtextHtml = '';
                if (h.reminderTime) subtextHtml += `<span>${esc(h.reminderTime)}</span>`;
                if (h.triggerText) subtextHtml += `<span>я сделаю после: ${esc(h.triggerText)}</span>`;
                const rowEl = document.createElement('div');
                rowEl.className = 'hm-row';
                rowEl.dataset.uid = h.uid;
                rowEl.innerHTML = `
                    <div class="hm-row-head">
                        <div class="hm-row-headline">
                            <span class="hm-label${doneToday ? ' done' : ''}" title="${esc(h.text)}">${esc(h.text)}</span>
                            <span class="hm-meta">${streak > 0 ? `<span class="hm-streak">${FLAME}${streak}</span>` : ''}<span class="hm-count">${monthDone}/${days}</span><span class="hm-settings" data-idx="${hIdx}">${DOTS}</span></span>
                        </div>
                        ${subtextHtml ? `<div class="hm-subtext">${subtextHtml}</div>` : ''}
                    </div>
                    <div class="hm-bar"><div class="hm-bar-fill" style="width:${pct}%"></div></div>`;
                hm.appendChild(rowEl);
            });

            hm.onclick = (e) => {
                const settingsIcon = e.target.closest('.hm-settings');
                if (settingsIcon) { openHabitSettings(+settingsIcon.dataset.idx); return; }
                const row = e.target.closest('.hm-row');
                if (!row) return;
                const h = habits.find(x => x.uid === row.dataset.uid);
                if (h) openHabitHistoryCalendar(h, y, m);
            };
        }

        document.getElementById('month-prev').onclick = () => { if (--monthCursor.m < 0) { monthCursor.m = 11; monthCursor.y--; } renderMonthView(); };
        document.getElementById('month-next').onclick = () => { if (++monthCursor.m > 11) { monthCursor.m = 0; monthCursor.y++; } renderMonthView(); };
        document.getElementById('month-cal').onclick = () => {
            openMonthPicker({ value: { y: monthCursor.y, m: monthCursor.m }, onPick: (py, pm) => { monthCursor.y = py; monthCursor.m = pm; renderMonthView(); } });
        };
    }

    // Переключатель «День»/«Месяц» для ОБЫЧНОГО режима — та же кнопка-пилюля, что и в Pro mode
    // (см. psychoToggleHtml), просто на своей переменной (taskViewMode), чтобы Pro mode и обычный
    // режим не путали друг другу выбор при переключении тумблера Pro mode.
    function taskViewToggleHtml() {
        return `<div class="dm-toggle">
            <button class="dm-toggle-btn${taskViewMode === 'day' ? ' active' : ''}" data-mode="day" type="button">День</button>
            <button class="dm-toggle-btn${taskViewMode === 'month' ? ' active' : ''}" data-mode="month" type="button">Месяц</button>
        </div>`;
    }
    function wireTaskViewToggle(root) {
        root.querySelectorAll('.dm-toggle-btn').forEach(b => b.addEventListener('click', () => {
            if (b.dataset.mode === taskViewMode) return;
            taskViewMode = b.dataset.mode;
            renderMonthView();
        }));
    }

    // Отметить/снять привычку за конкретный день — версия toggleHabit/клика по клетке heatmap для
    // простого списка normal-mode «День» (без тепловой карты и анимации раскрытия — юзер попросил
    // просто оставлять зачёркнутой, не открывая историю месяца по этой задаче). За СЕГОДНЯ —
    // та же history-запись/XP, что и везде; за прошлые дни — тот же retroactive-режим,
    // что уже разрешён в тепловой карте, просто без начисления XP. Будущее — недоступно.
    function toggleHabitForDate(habit, dateKey) {
        if (dateKey > todayKey()) return null;
        const now = !isDone(habit.uid, dateKey);
        setHistory(habit.uid, dateKey, now);
        if (dateKey === todayKey()) {
            habit.completed = now;
            if (now && habit.xpDate !== todayKey()) { habit.xpDate = todayKey(); awardXP(getLevelStats(dashState.level).xpPerHabit); }
        }
        saveProgress();
        return now;
    }

    // normal-mode «День» — простой список привычек на выбранный день (чекбокс, без тепловой карты
    // и без сводки месяца — та показывается только во «Месяце», см. запрос юзера) + событие/задача
    // дня для этого же дня, + навигация стрелками/календарём (см. dayNavHeaderHtml).
    function renderTaskDayView(dateKey) {
        const root = document.getElementById('view-month');
        if (!root) return;
        const allHabits = dashState.habits || [];
        // «Регулярные» — видны всегда, «Разовые» — только те, что созданы именно на этот день
        // (см. openNewHabitModal/saveSettings, поле habit.date). Юзер попросил разделение на
        // категории в рамках одного списка — считаем настоящий индекс в dashState.habits через
        // indexOf, а не позицию внутри отфильтрованной группы (иначе «⋯» откроет не ту задачу).
        const regularHabits = allHabits.filter(h => (h.type || 'regular') === 'regular');
        const oneTimeHabits = allHabits.filter(h => h.type === 'oneTime' && h.date === dateKey);
        const isFuture = dateKey > todayKey();
        const renderGroup = (list, label) => {
            if (!list.length) return '';
            const rows = list.map(h => {
                const idx = allHabits.indexOf(h);
                const done = isDone(h.uid, dateKey);
                return `<div class="task-day-row${done ? ' done' : ''}" data-uid="${h.uid}">
                    <span class="task-day-text">${esc(h.text)}</span>
                    ${h.type === 'oneTime' ? '' : streakChip(currentStreak(h.uid))}
                    <span class="task-day-settings" data-idx="${idx}">${DOTS}</span>
                </div>`;
            }).join('');
            return `<div class="task-group-label">${label}</div><div class="task-day-list${isFuture ? ' future' : ''}">${rows}</div>`;
        };
        const listsHtml = renderGroup(regularHabits, 'Регулярные') + renderGroup(oneTimeHabits, 'Разовые');
        renderTopNavSlot(dayNavHeaderHtml(dateKey, 'task-day-nav'));
        root.innerHTML = `
            ${taskViewToggleHtml()}
            <div id="task-day-fields"></div>
            ${listsHtml || '<p class="month-empty">Пока нет задач — добавь ниже.</p>'}
            <div id="task-day-add"></div>`;
        wireDayNavHeader('task-day-nav', dateKey, (newKey) => { currentTaskDate = newKey; renderTaskDayView(newKey); });
        wireTaskViewToggle(root);
        function refreshFields() { renderDayEventAndTask(document.getElementById('task-day-fields'), dateKey, refreshFields); }
        refreshFields();

        if (!isFuture) {
            root.querySelectorAll('.task-day-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.task-day-settings')) return;
                    const h = allHabits.find(x => x.uid === row.dataset.uid);
                    if (!h) return;
                    const now = toggleHabitForDate(h, dateKey);
                    row.classList.toggle('done', now);
                });
            });
        }
        root.querySelectorAll('.task-day-settings').forEach(s => s.addEventListener('click', (e) => { e.stopPropagation(); openHabitSettings(+s.dataset.idx); }));

        // Реордер «нажать и удержать» — свой список по группе (Регулярные/Разовые не смешиваются).
        root.querySelectorAll('.task-day-list').forEach(groupEl => {
            Array.from(groupEl.children).forEach(row => wireRowDrag(row, groupEl, () => renderTaskDayView(currentTaskDate)));
        });

        // «+ добавить задачу» — сразу открывает модалку настроек (юзер попросил вместо инлайн-
        // инпута), разовые задачи из этой кнопки привязываются к dateKey — дню, что сейчас открыт.
        // Лимит MAX_HABITS считает только регулярные — разовые в него не входят (см. openNewHabitModal).
        const addBox = document.getElementById('task-day-add');
        if (addBox) {
            if (regularHabits.length < MAX_HABITS) {
                addBox.innerHTML = `<button type="button" class="dash-habit-add-btn" id="add-habit-btn-day">+ добавить задачу</button>`;
                addBox.querySelector('#add-habit-btn-day').addEventListener('click', () => openNewHabitModal(dateKey));
            } else {
                addBox.innerHTML = `<div class="dash-habit-limit">Максимум ${MAX_HABITS} задач</div>`;
            }
        }
    }

    // Сводка метрик за календарный месяц (psycho mode)
    // Переключатель «День»/«Месяц» — общий для обоих Pro-mode рендеров ниже.
    function psychoToggleHtml() {
        return `<div class="dm-toggle">
            <button class="dm-toggle-btn${psychoSubView === 'day' ? ' active' : ''}" data-mode="day" type="button">День</button>
            <button class="dm-toggle-btn${psychoSubView === 'month' ? ' active' : ''}" data-mode="month" type="button">Месяц</button>
        </div>`;
    }
    function wirePsychoToggle(root) {
        root.querySelectorAll('.dm-toggle-btn').forEach(b => b.addEventListener('click', () => {
            if (b.dataset.mode === psychoSubView) return;
            psychoSubView = b.dataset.mode;
            renderMonthView();
        }));
    }

    // «День» — ввод сегодняшних значений показателей + цели/лимиты (та самая функциональность из
    // бывшей вкладки «День», см. renderPsychoMetrics — она никуда не делась, просто была недостижима
    // после того, как FEATURES.dayTab скрыл кнопку «День», а её единственный вызов остался внутри
    // renderDayView(), на который теперь ничего не переключается). День всегда про СЕГОДНЯ, не про
    // выбранный monthCursor — навигация по месяцам тут не нужна.
    // Дата, которую сейчас смотрим в «Дне» Pro mode — по умолчанию сегодня, листается стрелками
    // либо через календарь (см. dayNavHeaderHtml/wireDayNavHeader). Юзер попросил возможность
    // редактировать показатели и за прошлые дни, не только за сегодня — renderPsychoMetrics теперь
    // всегда живой ввод, независимо от даты (раньше прошлые дни были read-only снимком, см.
    // renderPsychoMetricsReadOnly в HANDOFF.md §38, функция удалена как более не нужная). Уже внутри
    // Pro mode (сама вкладка под замком подписки) — отдельного гейта не нужно, в отличие от
    // календаря питания (тот доступен и без Pro mode, поэтому гейтится отдельно).
    let currentPsychoDate = todayKey();

    function renderPsychoDay() {
        const root = document.getElementById('view-month');
        const dateKey = currentPsychoDate;
        // Только навигация по дню (стрелки + календарь) — это и была вся правка, которую просил
        // юзер («фильтрацию днями подредактировать»). «Событие дня»/«Задача дня» сюда НЕ добавляем —
        // это фичи normal-mode «Задачи» (см. renderTaskDayView), Pro mode их не касается. Сама
        // механика накопления значений (renderPsychoMetrics — живой ввод «+ значение») не менялась.
        renderTopNavSlot(dayNavHeaderHtml(dateKey, 'psycho-nav'));
        root.innerHTML = `
            ${psychoToggleHtml()}
            <div id="psycho-list-tasks"></div>`;
        wirePsychoToggle(root);
        wireDayNavHeader('psycho-nav', dateKey, (newKey) => { currentPsychoDate = newKey; renderPsychoDay(); });
        renderPsychoMetrics(document.getElementById('psycho-list-tasks'), dateKey);
    }

    function renderPsychoMonth(y, m) {
        const root = document.getElementById('view-month');
        const days = daysInMonth(y, m);
        const metrics = dashState.metrics || [];
        const sums = {}; metrics.forEach(mt => sums[mt.id] = 0);
        for (let d = 1; d <= days; d++) {
            const rec = dashState.metricLog[fdt(y, m, d)];
            if (!rec) continue;
            metrics.forEach(mt => { const v = +rec[mt.id]; if (!isNaN(v)) sums[mt.id] += v; });
        }
        const rows = metrics.map(mt => {
            const monthlyTarget = metricTarget(mt) * days;
            const isLimit = mt.type === 'limit';
            const over = isLimit && sums[mt.id] > monthlyTarget;
            const pct = monthlyTarget > 0 ? Math.min(100, Math.round(sums[mt.id] / monthlyTarget * 100)) : (sums[mt.id] > 0 ? 100 : 0);
            return `<div class="pm-row">
                <div class="pm-top"><span class="pm-name">${esc(mt.name)}${isLimit ? '<span class="metric-tag">лимит</span>' : ''}</span>
                <span class="pm-val ${over ? 'over' : ''}"><b>${fmtNum(sums[mt.id])}</b> / ${fmtNum(monthlyTarget)} ${mt.unit || ''}</span></div>
                <div class="metric-bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div></div>`;
        }).join('');
        renderTopNavSlot(monthHeadHtml(y, m));
        root.innerHTML = `
            ${psychoToggleHtml()}
            <div class="month-hint">сумма за месяц · цель = дневная × ${days} дн.</div>
            <div class="pm-list">${rows}</div>`;
        document.getElementById('month-prev').onclick = () => { if (--monthCursor.m < 0) { monthCursor.m = 11; monthCursor.y--; } renderMonthView(); };
        document.getElementById('month-next').onclick = () => { if (++monthCursor.m > 11) { monthCursor.m = 0; monthCursor.y++; } renderMonthView(); };
        document.getElementById('month-cal').onclick = () => {
            openMonthPicker({ value: { y: monthCursor.y, m: monthCursor.m }, onPick: (py, pm) => { monthCursor.y = py; monthCursor.m = pm; renderMonthView(); } });
        };
        wirePsychoToggle(root);
    }

    // === НАВИГАЦИЯ ПО МЕСЯЦАМ ДЛЯ ГРАФИКОВ ЧЕК-АПА (Часы сна / Настроение-сон-энергия-здоровье) ===
    // Юзер попросил: приближенные дни (~10 на экран, скролл влево-вправо внутри месяца) + месяц и
    // календарь справа от заголовка каждого графика, как у «Задач» (openMonthPicker). Оба графика
    // всегда показывают ОДИН и тот же месяц (общий checkupChartCursor) — было бы странно, если бы
    // они разъезжались по разным месяцам в одной и той же вкладке.
    let checkupChartCursor = null; // {y,m}; null → renderCheckupCharts подставит текущий месяц

    // Та же кнопка-календарь (CALENDAR_ICON) и стрелки, что у monthHeadHtml/dayNavHeaderHtml —
    // единый визуальный язык навигации по всему приложению. idPrefix различает элементы двух
    // графиков (mood-chart/sleep-chart), title — текст перед навигацией (сам заголовок графика).
    function chartHeaderHtml(title, idPrefix) {
        return `<div class="month-chart-title">${title}</div>
            <div class="chart-month-nav">
                <button class="day-nav-arrow" id="${idPrefix}-prev" type="button" aria-label="Предыдущий месяц">←</button>
                <span class="checkin-date-label" id="${idPrefix}-label"></span>
                <button class="day-nav-arrow" id="${idPrefix}-next" type="button" aria-label="Следующий месяц">→</button>
                <button class="history-btn" id="${idPrefix}-cal" type="button" title="Открыть выбор месяца">${CALENDAR_ICON}</button>
            </div>`;
    }
    function wireChartNav(idPrefix) {
        const prevBtn = document.getElementById(`${idPrefix}-prev`);
        const nextBtn = document.getElementById(`${idPrefix}-next`);
        const calBtn = document.getElementById(`${idPrefix}-cal`);
        if (prevBtn) prevBtn.onclick = () => shiftCheckupChartMonth(-1);
        if (nextBtn) nextBtn.onclick = () => shiftCheckupChartMonth(1);
        if (calBtn) calBtn.onclick = () => openMonthPicker({
            value: checkupChartCursor,
            onPick: (py, pm) => { checkupChartCursor = { y: py, m: pm }; renderCheckupCharts(); }
        });
    }
    function shiftCheckupChartMonth(delta) {
        let { y, m } = checkupChartCursor;
        m += delta;
        if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
        checkupChartCursor = { y, m };
        renderCheckupCharts();
    }
    function renderCheckupCharts() {
        const now = new Date();
        if (!checkupChartCursor) checkupChartCursor = { y: now.getFullYear(), m: now.getMonth() };
        const { y, m } = checkupChartCursor;
        const days = daysInMonth(y, m);
        const moodHeader = document.getElementById('mood-chart-header');
        const sleepHeader = document.getElementById('sleep-chart-header');
        if (moodHeader) moodHeader.innerHTML = chartHeaderHtml('Настроение, сон, энергия и здоровье', 'mood-chart');
        if (sleepHeader) sleepHeader.innerHTML = chartHeaderHtml('Часы сна', 'sleep-chart');
        ['mood-chart', 'sleep-chart'].forEach(idPrefix => {
            const label = document.getElementById(`${idPrefix}-label`);
            if (label) label.textContent = `${MONTH_NAMES[m]} ${y}`;
            wireChartNav(idPrefix);
            // Юзер попросил: «чтобы в аналитике дня при открытии отображался самый правый день…
            // ну и листать дальше влево можно было при желании» — оба графика открывались на 1-м
            // числе месяца (scrollLeft = 0), хотя интересен всегда свежий день. Здесь только
            // ВЗВОДИМ флаг «этот месяц надо один раз автопрокрутить»; сам скролл делает
            // autoScrollChartToFreshDay() внутри draw*(), потому что до layoutMonthChart ширина
            // канваса ещё не известна, а при невидимой вкладке layout вообще вернёт null и уйдёт
            // в retry по setTimeout — прокручивать в этот момент нечего.
            // Флаг ставится ТОЛЬКО отсюда: renderCheckupCharts вызывается на заходе во вкладку и
            // на любой смене месяца (switchView / shiftCheckupChartMonth / onPick календаря), а
            // перерисовки в обход неё не должны отматывать вью назад, пока юзер сам листает историю.
            const scrollWrap = document.getElementById(`${idPrefix}-scroll`);
            if (scrollWrap) scrollWrap.dataset.autoScrollTo = `${y}-${m}`;
        });
        drawMonthMoodSleep(y, m, days);
        drawSleepHoursChart(y, m, days);
    }

    // Общая раскладка «канвас на ~10 дней/экран, скроллится внутри .chart-scroll» для обоих
    // графиков ниже. Ширина колонки-дня = ширина видимой области скролл-обёртки / 10 (юзер: «чтобы
    // влезало 10 дней на экран»), сам канвас растягивается на ВСЕ дни месяца — что не влезло,
    // уезжает за край и доступно свайпом. dayW возвращается вызывающей стороне для отрисовки баров.
    function layoutMonthChart(canvas, scrollWrap, days, extraBottomForLabels) {
        const viewportW = scrollWrap.clientWidth;
        if (viewportW === 0) return null; // ещё не виден (вкладка не отрендерилась) — повторим позже
        const dpr = window.devicePixelRatio || 1;
        const dayW = Math.max(28, viewportW / 10);
        const pad = { t: 8, r: 10, b: 16 + extraBottomForLabels, l: 28 };
        const w = pad.l + pad.r + days * dayW, h = 150;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        canvas.width = w * dpr; canvas.height = h * dpr;
        const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        return { ctx, w, h, pad, dayW };
    }

    // Одноразовая автопрокрутка графика к «самому свежему» дню — юзер: «чтобы в аналитике дня при
    // открытии отображался самый правый день. это в блоке сна и настроения. ну и листать дальше
    // влево можно было при желании». Что считаем свежим днём:
    //   • текущий месяц  → СЕГОДНЯ. Не последнее число месяца: иначе в начале месяца справа висел
    //                      бы хвост ещё не наступивших дней, а реальные данные уезжали бы влево —
    //                      ровно та проблема, от которой юзер и просил уйти.
    //   • прошлый месяц  → последнее число (для него «самый свежий день» = конец месяца).
    //   • будущий месяц  → 1-е число: ближайшие к «сейчас» дни там в НАЧАЛЕ. Отдельной ветки со
    //                      scrollLeft = 0 не нужно — для 1-го числа формула ниже даёт отрицательное
    //                      значение, и clamp сам сводит его к нулю.
    // Вызывается из draw*() ПОСЛЕ layoutMonthChart: к этому моменту canvas.style.width уже
    // выставлен, а чтение scrollWidth принудительно пересчитывает раскладку, так что новая ширина
    // уже видна. Работает и на retry-пути (вкладка была не видна, clientWidth === 0): флаг живёт на
    // элементе, поэтому переживает любое количество отложенных повторов.
    function autoScrollChartToFreshDay(scrollWrap, y, m, days, layout) {
        // Флаг взводит только renderCheckupCharts. Сверка с текущим месяцем заодно гасит «протухший»
        // retry: если юзер успел пролистнуть месяц, пока сработал setTimeout старой отрисовки,
        // ключи не совпадут и вью не дёрнется.
        if (!scrollWrap || scrollWrap.dataset.autoScrollTo !== `${y}-${m}`) return;
        delete scrollWrap.dataset.autoScrollTo; // один раз на заход/смену месяца — дальше юзер листает сам
        const now = new Date();
        const isCurrent = y === now.getFullYear() && m === now.getMonth();
        const isFuture = y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth());
        const targetDay = isCurrent ? Math.min(now.getDate(), days) : (isFuture ? 1 : days);
        // Правый край колонки целевого дня + правый паддинг канваса должны совпасть с правым краем
        // видимой области: тогда нужный день стоит крайним справа, а вся история уходит влево.
        // Геометрия ровно та же, что у xAt() в графиках: колонка дня d занимает
        // [pad.l + (d-1)*dayW, pad.l + d*dayW].
        const targetRight = layout.pad.l + targetDay * layout.dayW + layout.pad.r;
        const maxScroll = Math.max(0, scrollWrap.scrollWidth - scrollWrap.clientWidth);
        scrollWrap.scrollLeft = Math.max(0, Math.min(maxScroll, targetRight - scrollWrap.clientWidth));
    }

    // Подписи под графиком: день недели + число месяца на каждый день — юзер попросил явно
    // подписывать ось X, а не полагаться на одну лишь сетку значений.
    function drawDayLabelsXAxis(ctx, y, m, days, xAt, chartBottomY) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#bbb'; ctx.font = '9px sans-serif';
        for (let d = 1; d <= days; d++) {
            const x = xAt(d);
            ctx.fillText(WD_SHORT[new Date(y, m, d).getDay()], x, chartBottomY + 11);
            ctx.fillText(String(d), x, chartBottomY + 22);
        }
    }

    // Линия настроения и качества сна за месяц (данные из утренних чек-апов)
    function drawMonthMoodSleep(y, m, days) {
        const canvas = document.getElementById('month-ms-chart');
        const scrollWrap = document.getElementById('mood-chart-scroll');
        if (!canvas || !scrollWrap) return;
        const layout = layoutMonthChart(canvas, scrollWrap, days, 20);
        if (!layout) { setTimeout(() => drawMonthMoodSleep(y, m, days), 60); return; }
        const { ctx, w, h, pad, dayW } = layout;
        autoScrollChartToFreshDay(scrollWrap, y, m, days, layout); // открываемся на свежем дне (см. хелпер выше)
        const ih = h - pad.t - pad.b;

        // сетка 0 / 5 / 10
        ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 1; ctx.fillStyle = '#bbb'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
        [0, 5, 10].forEach(v => { const yy = pad.t + ih - (v / 10) * ih; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke(); ctx.fillText(v, pad.l - 4, yy + 3); });

        const hist = dashState.checkinHistory || {};
        const xAt = d => pad.l + (d - 0.5) * dayW;
        const yAt = v => pad.t + ih - (v / 10) * ih;
        const valFor = (d, key) => {
            const local = hist[fdt(y, m, d)]?.morning?.[key];
            if (local != null) return local;
            const iso = new Date(y, m, d).toISOString().split('T')[0]; // на случай UTC-ключей
            return hist[iso]?.morning?.[key];
        };
        const series = (key, color, dash) => {
            const pts = [];
            for (let d = 1; d <= days; d++) { const v = valFor(d, key); if (v) pts.push({ d, v }); }
            if (!pts.length) return;
            ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            pts.forEach((p, i) => { const x = xAt(p.d), yy = yAt(p.v); i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); });
            ctx.stroke(); ctx.setLineDash([]);
            pts.forEach(p => { ctx.beginPath(); ctx.arc(xAt(p.d), yAt(p.v), 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); });
        };
        series('mood', '#111', []);
        series('sleepQuality', '#999', [4, 3]);
        series('energy', '#1e40af', []);
        series('health', '#60a5fa', [2, 2]);
        drawDayLabelsXAxis(ctx, y, m, days, xAt, pad.t + ih);
    }

    // Часы сна отдельным графиком: Y — время суток (0–24), X — дни месяца; закрашенный отрезок —
    // промежуток от «лёг» до «встал» (см. чек-ап). Если сон переходит через полночь (обычный
    // случай — лёг вечером, встал утром), рисуем двумя отрезками в одной колонке: сверху (до 24) и
    // снизу (от 0) — так «через полночь» не выглядит как перенос на соседний день.
    function drawSleepHoursChart(y, m, days) {
        const canvas = document.getElementById('month-sleep-chart');
        const scrollWrap = document.getElementById('sleep-chart-scroll');
        if (!canvas || !scrollWrap) return;
        const layout = layoutMonthChart(canvas, scrollWrap, days, 20);
        if (!layout) { setTimeout(() => drawSleepHoursChart(y, m, days), 60); return; }
        const { ctx, w, h, pad, dayW } = layout;
        autoScrollChartToFreshDay(scrollWrap, y, m, days, layout); // открываемся на свежем дне (см. хелпер выше)
        const ih = h - pad.t - pad.b;

        // сетка по часам суток
        ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 1; ctx.fillStyle = '#bbb'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
        [0, 6, 12, 18, 24].forEach(hr => {
            const yy = pad.t + ih - (hr / 24) * ih;
            ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
            ctx.fillText(hr, pad.l - 4, yy + 3);
        });

        const hist = dashState.checkinHistory || {};
        const xAt = d => pad.l + (d - 0.5) * dayW;
        const yAt = hr => pad.t + ih - (hr / 24) * ih;
        const parseHM = s => { if (!s) return null; const [hh, mm] = String(s).split(':').map(Number); return isNaN(hh) ? null : hh + (mm || 0) / 60; };
        const fmtHours = h => { const r = Math.round(h * 10) / 10; return (r % 1 === 0 ? String(r) : String(r).replace('.', ',')) + 'ч'; };
        const barW = Math.max(4, dayW * 0.55);
        // Возвращает верхний (наименьший) y нарисованного отрезка — нужен, чтобы понять, ГДЕ выше
        // всего на дне поставить подпись «сколько часов сна итого» (см. ниже).
        const drawSeg = (d, fromH, toH, color) => {
            const x = xAt(d) - barW / 2, y1 = yAt(fromH), y2 = yAt(toH);
            ctx.fillStyle = color;
            ctx.fillRect(x, Math.min(y1, y2), barW, Math.max(1, Math.abs(y2 - y1)));
            return Math.min(y1, y2);
        };
        for (let d = 1; d <= days; d++) {
            const rec = hist[fdt(y, m, d)]?.morning;
            if (!rec) continue;
            const sleepH = parseHM(rec.sleepTime), wakeH = parseHM(rec.wakeTime);
            if (sleepH == null || wakeH == null) continue;
            let topY;
            if (wakeH <= sleepH) { drawSeg(d, sleepH, 24, '#1e3a8a'); topY = drawSeg(d, 0, wakeH, '#1e3a8a'); } // через полночь — верх всегда у отрезка sleepH→24 (yAt(24)=pad.t), но берём min на всякий случай ниже
            else topY = drawSeg(d, sleepH, wakeH, '#1e3a8a');
            // Часы сна урывками (интервальный сон) — «добавить часы сна» в чек-апе, см.
            // index.html. Не привязаны к реальному времени наверняка, поэтому просто
            // достраиваем отрезок светлым цветом сразу после подъёма — показываем итоговое
            // количество сна за день, а не точное время дрёмы.
            const extra = parseFloat(rec.extraSleepHours) || 0;
            if (extra > 0) topY = Math.min(topY, drawSeg(d, wakeH, Math.min(24, wakeH + extra), '#93c5fd'));
            if (wakeH <= sleepH) topY = Math.min(topY, yAt(24)); // подстраховка для через-полночь случая

            // Подпись «сколько часов сна итого за день» — юзер попросил цифру на столбике,
            // повёрнутую на 90° (иначе не влезает в узкую колонку дня). Растёт ВВЕРХ от чуть выше
            // самого верхнего нарисованного отрезка; у самого края графика (очень раннее время
            // отбоя) подпись может частично не влезать по высоте — сознательно не решаем это здесь,
            // редкий крайний случай не стоит усложнения макета ради него.
            const mainDur = wakeH <= sleepH ? (24 - sleepH) + wakeH : wakeH - sleepH;
            const totalHours = mainDur + extra;
            if (totalHours > 0) {
                ctx.save();
                ctx.translate(xAt(d), Math.max(pad.t + 8, topY - 4));
                ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#1e3a8a';
                ctx.font = '9px sans-serif';
                ctx.fillText(fmtHours(totalHours), 0, 0);
                ctx.restore();
            }
        }
        drawDayLabelsXAxis(ctx, y, m, days, xAt, pad.t + ih);
    }

    // =========================================
    //   КОЛЕСО ЖИЗНИ (авто от выполнения привычек)
    // =========================================
    // Доля заполнения сферы:
    //   day   — выполнено сегодня / всего привычек сферы
    //   month — суммарно выполнено за месяц / (дней × привычек сферы)
    function areaFractions(scope, y, m) {
        const acc = {}; LIFE_AREAS.forEach(a => acc[a.id] = { done: 0, total: 0 });
        const days = (scope === 'month') ? daysInMonth(y, m) : 1;
        (dashState.habits || []).forEach(h => {
            (h.areas || []).forEach(aid => {
                if (!acc[aid]) return;
                if (scope === 'day') {
                    acc[aid].total += 1;
                    if (isDone(h.uid, todayKey())) acc[aid].done += 1;
                } else {
                    acc[aid].total += days;
                    for (let d = 1; d <= days; d++) if (isDone(h.uid, fdt(y, m, d))) acc[aid].done += 1;
                }
            });
        });
        const out = {};
        LIFE_AREAS.forEach(a => { const r = acc[a.id]; out[a.id] = { frac: r.total ? r.done / r.total : 0, has: r.total > 0 }; });
        return out;
    }

    function lifeWheelSVG(fr) {
        const cx = 150, cy = 110, R = 73;
        const N = LIFE_AREAS.length, step = 2 * Math.PI / N, start = -Math.PI / 2;
        const pt = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        const wedge = (a0, a1, r) => { const p0 = pt(a0, r), p1 = pt(a1, r); return `M${cx},${cy} L${p0[0].toFixed(1)},${p0[1].toFixed(1)} A${r},${r} 0 0 1 ${p1[0].toFixed(1)},${p1[1].toFixed(1)} Z`; };
        let s = '';
        LIFE_AREAS.forEach((a, i) => {
            const a0 = start + i * step, a1 = start + (i + 1) * step, f = fr[a.id].frac;
            s += `<path d="${wedge(a0, a1, R)}" fill="#f0f0f0" stroke="#fff" stroke-width="1.5"/>`;
            if (f > 0) s += `<path d="${wedge(a0, a1, R * f)}" fill="#111" stroke="#fff" stroke-width="1.5"/>`;
        });
        [0.34, 0.67, 1].forEach(g => { s += `<circle cx="${cx}" cy="${cy}" r="${(R * g).toFixed(1)}" fill="none" stroke="#fff" stroke-width="1"/>`; });
        LIFE_AREAS.forEach((a, i) => {
            const ang = start + (i + 0.5) * step, l = pt(ang, R + 13);
            const anchor = Math.abs(Math.cos(ang)) < 0.35 ? 'middle' : (Math.cos(ang) > 0 ? 'start' : 'end');
            s += `<text x="${l[0].toFixed(1)}" y="${l[1].toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="11" fill="${fr[a.id].has ? '#666' : '#c4c4c4'}">${a.short}</text>`;
        });
        return `<svg viewBox="0 0 300 230" width="100%" style="max-width:300px;display:block;margin:0 auto" role="img" aria-label="Колесо жизни">${s}</svg>`;
    }

    function renderLifeWheel(scope, containerId, y, m) {
        const el = document.getElementById(containerId);
        if (!el) return;
        const anyAreas = (dashState.habits || []).some(h => (h.areas || []).length);
        if (!anyAreas) {
            el.innerHTML = `<div class="wheel-empty">Колесо жизни заполнится, когда привяжешь задачи к сферам — в настройках задачи (кнопка «⋯»).</div>`;
            return;
        }
        el.innerHTML = lifeWheelSVG(areaFractions(scope, y, m));
    }

    // =========================================
    //   PSYCHO MODE (числовые метрики)
    // =========================================
    const metricValue = (id, dateKey = todayKey()) => { const day = dashState.metricLog[dateKey]; return day ? day[id] : undefined; };
    function setMetricValue(id, val, dateKey = todayKey()) {
        const k = dateKey;
        if (!dashState.metricLog[k]) dashState.metricLog[k] = {};
        const day = dashState.metricLog[k];
        if (val === false || val === 0 || val === undefined || val === null) {
            if (val === false) day[id] = false; else delete day[id];
        } else day[id] = val;
        if (!Object.keys(day).length) delete dashState.metricLog[k];
        saveProgress();
    }
    const fmtNum = n => {
        const r = Math.round(n * 100) / 100;
        return r.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    };

    // Общая часть переключения режима БЕЗ принудительной навигации — нужна отдельно от
    // setPsychoMode() для Pro-кнопок «Задачи»/«Питание» (см. обработчик .view-btn ниже): они сами
    // ведут на СВОЮ вкладку, а setPsychoMode всегда жёстко уводит на 'month', из-за чего клик по
    // Pro-«Питание» неожиданно переносил бы на «Задачи». setPsychoMode(false) отдельно зовёт
    // кнопка «?» в шапке (сбрасывает Pro mode перед туром) — ей переход на 'month' нужен.
    function applyPsychoModeState(on) {
        dashState.psychoMode = on;
        saveProgress();
        dashboardScreen.classList.toggle('psycho-invert', on); // инверсия цветов в режиме
    }
    function setPsychoMode(on) {
        applyPsychoModeState(on);
        // «День» скрыт (см. HANDOFF.md §15) — Pro mode показывает переключатель «День»/«Месяц» во
        // вкладке «Задачи» (renderPsychoDay/renderPsychoMonth, см. renderMonthView).
        switchView('month');
    }

    // Данные Pro mode (dashState.metrics/metricLog) НЕ удаляются с истечением подписки — они те
    // же поля dashState, что и всё остальное, сохраняются в localStorage/облако тем же
    // saveProgress(), что и привычки/чек-ап. Подписка гейтит только ДОСТУП к просмотру/входу в
    // режим, не сами данные — вернувшись, юзер увидит их как были.
    // Но если dashState.psychoMode уже был true (юзер включил Pro mode, пока подписка была
    // активна), а подписка кончилась ПОКА приложение открыто (например, сессия висит дольше
    // оплаченного периода) — без этой проверки экран продолжал бы показывать Pro-контент мимо
    // оплаты: клик по Pro-кнопке блокируется (см. обработчик .view-btn), а уже включённый режим —
    // нет. Дёргается из auth.js при каждом обновлении статуса подписки.
    window.exitPsychoModeIfUnsubscribed = function () {
        // В режиме просмотра члена семьи (Фаза 19) psychoMode отражает ЕГО режим, а не мой, и моя
        // подписка тут ни при чём — иначе loadSubscription() из auth.js на каждом visibilitychange
        // перекидывал бы меня с его Pro-вкладки обратно на обычную.
        if (familyView) return;
        if (!window.hasActiveSubscription && dashState.psychoMode) setPsychoMode(false);
    };

    function renderDayView() {
        const normal = document.getElementById('day-normal');
        const psycho = document.getElementById('day-psycho');
        if (normal && psycho) {
            normal.style.display = dashState.psychoMode ? 'none' : 'block';
            psycho.style.display = dashState.psychoMode ? 'block' : 'none';
        }
        if (dashState.psychoMode) renderPsychoMetrics(document.getElementById('psycho-list'));
        else renderDashboardHabits(); // сам отрисует колесо в конце
    }

    // Стилизованное подтверждение (вместо нативного confirm). Модалка #confirm-modal живёт внутри
    // #dashboard-screen → в psycho mode инвертируется вместе с темой. Esc — отмена.
    // ВНИМАНИЕ: message кладётся в textContent, и это НЕ случайность — сюда приходят строки вида
    // «Удалить «${h.text}»?», то есть пользовательский текст без esc(). Переведёшь на innerHTML —
    // получишь ту самую XSS, от которой закрывались рендеры дашборда (см. esc() в начале файла).
    function confirmDialog(message, onOk) {
        const modal = document.getElementById('confirm-modal');
        if (!modal) { if (window.confirm(message)) onOk(); return; } // фолбэк
        const okBtn = document.getElementById('confirm-ok');
        const cancelBtn = document.getElementById('confirm-cancel');
        document.getElementById('confirm-text').textContent = message;
        function close() { modal.classList.remove('active'); okBtn.onclick = cancelBtn.onclick = modal.onclick = null; document.removeEventListener('keydown', onKey); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        okBtn.onclick = () => { close(); onOk(); };
        cancelBtn.onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
        document.addEventListener('keydown', onKey);
        modal.classList.add('active');
    }

    // container — куда рендерить; dateKey — какой день редактируем (dashState.metricLog[dateKey]).
    // При повторных внутренних вызовах (после каждого действия) оба параметра можно не передавать —
    // используются последний запомненный контейнер/дата. Так один и тот же рендер работает и из
    // renderPsychoDay() (вкладка «Задачи», см. выше — юзер листает дни стрелками, каждый день
    // редактируется независимо), и из старой (сейчас недостижимой без FEATURES.dayTab, но не
    // удалённой — см. HANDOFF.md про откат фич-флагов) renderDayView(), без конфликта id между их
    // разными контейнерами.
    let psychoMetricsList = null;
    let psychoMetricsDate = todayKey();
    function renderPsychoMetrics(container, dateKey) {
        if (container) psychoMetricsList = container;
        if (dateKey) psychoMetricsDate = dateKey;
        const list = psychoMetricsList;
        const dk = psychoMetricsDate;
        if (!list) return;
        list.innerHTML = '';
        const metrics = dashState.metrics || [];
        if (!metrics.length) {
            const empty = document.createElement('div');
            empty.className = 'dash-habit-limit';
            empty.textContent = 'Нет показателей — добавь первый';
            list.appendChild(empty);
        }
        metrics.forEach(m => {
            const row = document.createElement('div');
            row.className = 'metric-row';

            const val = +metricValue(m.id, dk) || 0;
            const target = metricTarget(m);
            const isLimit = m.type === 'limit';
            const over = isLimit && val > target;
            const pct = target > 0 ? Math.min(100, Math.round(val / target * 100)) : (val > 0 ? 100 : 0);
            row.innerHTML = `
                <div class="metric-top">
                    <span class="metric-name-wrap"><span class="metric-name" title="нажми, чтобы переименовать">${esc(m.name)}</span>${isLimit ? '<span class="metric-tag">лимит</span>' : ''}</span>
                    <span class="metric-val ${over ? 'over' : ''}"><b>${fmtNum(val)}</b> / ${fmtNum(target)} ${m.unit || ''}</span>
                </div>
                <div class="metric-bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>
                <div class="metric-actions">
                    <input type="text" class="metric-input" inputmode="decimal" enterkeyhint="done" placeholder="+ значение"${m.step ? ` step="${m.step}"` : ''}>
                    <button class="metric-add" type="button" aria-label="Добавить">＋</button>
                    <button class="metric-goal" type="button">${isLimit ? 'лимит' : 'цель'} ${fmtNum(target)}${m.unit ? ' ' + m.unit : ''}</button>
                    ${val ? '<button class="metric-reset" type="button">сброс</button>' : ''}
                    <button class="metric-del" type="button">удалить</button>
                </div>`;
            const input = row.querySelector('.metric-input');
            const add = () => {
                const v = parseFloat(String(input.value).replace(',', '.'));
                if (isNaN(v)) return;
                setMetricValue(m.id, Math.max(0, val + v), dk);
                renderPsychoMetrics();
            };
            row.querySelector('.metric-add').addEventListener('click', add);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
            // Переименование — клик по названию превращает его в поле ввода; Enter/потеря
            // фокуса сохраняют, Esc отменяет. settled защищает от двойного срабатывания
            // (Esc пересобирает список → blur всё равно долетает до уже отсоединённого инпута).
            row.querySelector('.metric-name').addEventListener('click', () => {
                const nameSpan = row.querySelector('.metric-name');
                nameSpan.outerHTML = `<input type="text" class="metric-name-edit" value="${esc(m.name)}" maxlength="32">`;
                const inp = row.querySelector('.metric-name-edit');
                inp.focus(); inp.select();
                let settled = false;
                const finish = (save) => {
                    if (settled) return; settled = true;
                    if (save) { const v = inp.value.trim(); if (v && v !== m.name) { m.name = v; saveProgress(); } }
                    renderPsychoMetrics();
                };
                inp.addEventListener('blur', () => finish(true));
                inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
            });
            row.querySelector('.metric-goal').addEventListener('click', () => {
                const actions = row.querySelector('.metric-actions');
                actions.innerHTML = `
                    <span class="goal-edit-label">${isLimit ? 'лимит на день' : 'цель на день'}</span>
                    <input type="text" class="goal-edit-input" inputmode="decimal" enterkeyhint="done" value="${target}" min="0"${m.step ? ` step="${m.step}"` : ''}>
                    ${m.unit ? `<span class="goal-edit-unit">${esc(m.unit)}</span>` : ''}
                    <button class="goal-edit-save" type="button">ОК</button>
                    <button class="goal-edit-cancel" type="button" aria-label="Отмена">✕</button>`;
                const gi = actions.querySelector('.goal-edit-input'); gi.focus(); gi.select();
                const save = () => {
                    const t = parseFloat(String(gi.value).replace(',', '.'));
                    if (!isNaN(t) && t >= 0) { dashState.metricTargets[m.id] = t; saveProgress(); }
                    renderPsychoMetrics();
                };
                actions.querySelector('.goal-edit-save').addEventListener('click', save);
                actions.querySelector('.goal-edit-cancel').addEventListener('click', renderPsychoMetrics);
                gi.addEventListener('keydown', ev => { if (ev.key === 'Enter') save(); else if (ev.key === 'Escape') renderPsychoMetrics(); });
            });
            const rb = row.querySelector('.metric-reset');
            if (rb) rb.addEventListener('click', () => { setMetricValue(m.id, 0, dk); renderPsychoMetrics(); });
            row.querySelector('.metric-del').addEventListener('click', () => {
                confirmDialog(`Удалить показатель «${m.name}»?`, () => {
                    dashState.metrics = dashState.metrics.filter(x => x.id !== m.id);
                    if (dashState.metricTargets) delete dashState.metricTargets[m.id]; // снимаем переопределённую цель
                    saveProgress();
                    renderPsychoMetrics();
                });
            });
            list.appendChild(row);
        });
        renderAddMetricControl(list);
    }

    // Контрол «+ добавить показатель»: свёрнутая кнопка → разворачивается в форму (название, ед., цель/лимит, значение)
    function renderAddMetricControl(list) {
        const wrap = document.createElement('div');
        wrap.className = 'psycho-add';
        const collapse = () => {
            wrap.innerHTML = `<button class="psycho-add-btn" type="button">+ добавить показатель</button>`;
            wrap.querySelector('.psycho-add-btn').addEventListener('click', expand);
        };
        const expand = () => {
            wrap.innerHTML = `
                <div class="psycho-add-form">
                    <input type="text" class="pam-name" maxlength="32" placeholder="название, напр. отжимания">
                    <div class="pam-row">
                        <div class="pam-type" role="group" aria-label="Тип показателя">
                            <button type="button" class="pam-type-btn active" data-type="goal">цель</button>
                            <button type="button" class="pam-type-btn" data-type="limit">лимит</button>
                        </div>
                        <input type="text" class="pam-target" inputmode="decimal" enterkeyhint="done" placeholder="значение" min="0">
                        <input type="text" class="pam-unit" maxlength="8" placeholder="ед. (необяз.)">
                    </div>
                    <div class="pam-actions">
                        <button type="button" class="pam-cancel">Отмена</button>
                        <button type="button" class="pam-save">Добавить</button>
                    </div>
                </div>`;
            let type = 'goal';
            wrap.querySelectorAll('.pam-type-btn').forEach(b => b.addEventListener('click', () => {
                type = b.dataset.type;
                wrap.querySelectorAll('.pam-type-btn').forEach(x => x.classList.toggle('active', x === b));
            }));
            const nameI = wrap.querySelector('.pam-name'); nameI.focus();
            const save = () => {
                const name = nameI.value.trim();
                if (!name) { nameI.focus(); return; }
                const unit = wrap.querySelector('.pam-unit').value.trim();
                const t = parseFloat(String(wrap.querySelector('.pam-target').value).replace(',', '.'));
                dashState.metrics.push({ id: newUid(), name, unit, type, target: isNaN(t) ? 0 : Math.max(0, t) });
                saveProgress();
                renderPsychoMetrics();
            };
            wrap.querySelector('.pam-save').addEventListener('click', save);
            wrap.querySelector('.pam-cancel').addEventListener('click', collapse);
            wrap.querySelector('.pam-target').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
            nameI.addEventListener('keydown', e => { if (e.key === 'Enter') wrap.querySelector('.pam-target').focus(); });
        };
        collapse();
        list.appendChild(wrap);
    }

    // =========================================
    //   ПИТАНИЕ (вкладка «Питание»)
    //   foodLog[date] = { breakfast:{time,text}, lunch:{time,text}, dinner:{time,text} }
    // =========================================
    // Локальная база «название → ккал за порцию» для автокомплита калорий в Pro mode (см.
    // renderFoodCalories) — офлайн, без похода во внешние сайты (см. HANDOFF.md про решение не
    // скрапить сторонние базы на каждый ввод). ВАЖНО: значения ниже — ОБЩИЕ ориентировочные оценки
    // (обычная бытовая мера — 100г/1шт/стандартный размер в кофейне), НЕ выгружены из какого-то
    // конкретного заведения/сайта. Юзер попросил помечать позиции квадратными скобками, когда
    // ккал реально взяты из конкретного места — поддержка формата есть (необязательное поле
    // `source`, отображается как «Название [Source]» — см. foodLabel), но текущий набор просто
    // ничем не помечен, т.к. источник не привязан к месту. Если понадобятся реальные позиции
    // конкретных заведений — добавлять сюда с `source`.
    const FOOD_DB = [
        { name: 'Булочка с корицей', kcal: 350 }, { name: 'Булочка с изюмом', kcal: 280 },
        { name: 'Булочка сдобная', kcal: 300 }, { name: 'Круассан классический', kcal: 270 },
        { name: 'Круассан с миндалем', kcal: 400 }, { name: 'Круассан шоколадный', kcal: 340 },
        { name: 'Эклер заварной', kcal: 250 }, { name: 'Чизкейк (кусок)', kcal: 380 },
        { name: 'Тирамису (порция)', kcal: 320 }, { name: 'Маффин шоколадный', kcal: 340 },
        { name: 'Маффин черничный', kcal: 290 }, { name: 'Печенье овсяное', kcal: 120 },
        { name: 'Печенье песочное', kcal: 140 }, { name: 'Пончик глазированный', kcal: 260 },
        { name: 'Капучино 350мл', kcal: 140 }, { name: 'Латте 350мл', kcal: 160 },
        { name: 'Латте на овсяном молоке 350мл', kcal: 130 }, { name: 'Американо', kcal: 5 },
        { name: 'Эспрессо', kcal: 3 }, { name: 'Раф кофе', kcal: 220 },
        { name: 'Флэт уайт', kcal: 150 }, { name: 'Какао с молоком 350мл', kcal: 210 },
        { name: 'Горячий шоколад', kcal: 300 }, { name: 'Чай чёрный без сахара', kcal: 2 },
        { name: 'Сэндвич с курицей', kcal: 320 }, { name: 'Сэндвич с ветчиной и сыром', kcal: 350 },
        { name: 'Хот-дог', kcal: 300 }, { name: 'Бургер классический', kcal: 500 },
        { name: 'Чизбургер', kcal: 550 }, { name: 'Шаурма классическая', kcal: 550 },
        { name: 'Пицца Маргарита (кусок)', kcal: 250 }, { name: 'Пицца пепперони (кусок)', kcal: 300 },
        { name: 'Салат Цезарь с курицей', kcal: 380 }, { name: 'Салат овощной', kcal: 120 },
        { name: 'Суп-пюре овощной (порция)', kcal: 180 }, { name: 'Борщ (порция)', kcal: 250 },
        { name: 'Гречка варёная, 100г', kcal: 110 }, { name: 'Рис варёный, 100г', kcal: 130 },
        { name: 'Овсянка на воде, 100г', kcal: 90 }, { name: 'Макароны варёные, 100г', kcal: 160 },
        { name: 'Картофель варёный, 100г', kcal: 80 }, { name: 'Картофель фри, 100г', kcal: 310 },
        { name: 'Куриная грудка варёная, 100г', kcal: 165 }, { name: 'Куриная грудка жареная, 100г', kcal: 220 },
        { name: 'Говядина, 100г', kcal: 250 }, { name: 'Свинина, 100г', kcal: 260 },
        { name: 'Рыба лосось, 100г', kcal: 200 }, { name: 'Яйцо варёное, 1шт', kcal: 78 },
        { name: 'Яичница из 2 яиц', kcal: 180 }, { name: 'Творог 5%, 100г', kcal: 120 },
        { name: 'Йогурт натуральный, 100г', kcal: 60 }, { name: 'Молоко 2.5%, 200мл', kcal: 100 },
        { name: 'Сыр твёрдый, 30г', kcal: 110 }, { name: 'Хлеб чёрный, 1 кусок', kcal: 65 },
        { name: 'Хлеб белый, 1 кусок', kcal: 80 }, { name: 'Банан, 1шт', kcal: 90 },
        { name: 'Яблоко, 1шт', kcal: 50 }, { name: 'Апельсин, 1шт', kcal: 60 },
        { name: 'Авокадо, 1/2 шт', kcal: 120 }, { name: 'Орехи миндаль, 30г', kcal: 170 },
        { name: 'Шоколад молочный, 30г', kcal: 160 }, { name: 'Шоколад горький, 30г', kcal: 150 },
        { name: 'Мороженое пломбир, 100г', kcal: 220 }, { name: 'Йогурт питьевой, 250мл', kcal: 180 },

        // Реально сourced позиции — полная таблица калорийности «Цех 85» с health-diet.ru
        // (юзер прислал ссылку, потом вставил всю таблицу целиком — раньше было только 25
        // позиций-примеров через WebFetch, суммаризатор не мог отдать все ~270 за один проход).
        // protein/fat/carbs (г на 100г) тоже сохранены — юзер попросил хранить, даже если пока
        // не участвуют в расчётах (только kcal идёт в сумму дня, см. renderFoodCalories).
        // ВАЖНО: значения ВСЕГДА на 100г продукта (сайт сам так их даёт), не на порцию/чашку/
        // штуку — поэтому в имени явно оставлено «100г», как и у остальных весовых позиций в базе.
        { name: 'Айс Латте, 100г', kcal: 62, protein: 3.1, fat: 3.3, carbs: 4.9, source: 'Цех 85' },
        { name: 'Американо, 100г', kcal: 4, protein: 0.2, fat: 0.2, carbs: 0.3, source: 'Цех 85' },
        { name: 'Апельсиновый Фруточино, 100г', kcal: 66, protein: 1.1, fat: 0.5, carbs: 14.3, source: 'Цех 85' },
        { name: 'Багет Классический, 100г', kcal: 200, protein: 6.4, fat: 0.7, carbs: 42.3, source: 'Цех 85' },
        { name: 'Батончик Овсяная Гранола с Финиками, 100г', kcal: 280, protein: 9.4, fat: 6, carbs: 47.1, source: 'Цех 85' },
        { name: 'Безе с Клюквой, 100г', kcal: 278, protein: 3.6, fat: 0, carbs: 65.9, source: 'Цех 85' },
        { name: 'Бланкет из Цыплёнка с Рисом, 100г', kcal: 156, protein: 9, fat: 10.9, carbs: 5.5, source: 'Цех 85' },
        { name: 'Борщ Холодный, 100г', kcal: 44, protein: 1.8, fat: 1.8, carbs: 5.2, source: 'Цех 85' },
        { name: 'Боул, 100г', kcal: 232, protein: 7.8, fat: 5.5, carbs: 37.7, source: 'Цех 85' },
        { name: 'Боул с Лососем, 100г', kcal: 579, protein: 19.5, fat: 13.8, carbs: 94.3, source: 'Цех 85' },
        { name: 'Боул с Лососем, 100г', kcal: 232, protein: 7.8, fat: 5.5, carbs: 37.7, source: 'Цех 85' },
        { name: 'Боул с Лососем и Редисом, 100г', kcal: 232, protein: 7.8, fat: 5.5, carbs: 37.7, source: 'Цех 85' },
        { name: 'Брауни Карамель, 100г', kcal: 390, protein: 4.3, fat: 18.4, carbs: 51.7, source: 'Цех 85' },
        { name: 'Брауни Карамельный, 100г', kcal: 389, protein: 4.3, fat: 18.4, carbs: 51.7, source: 'Цех 85' },
        { name: 'Брауни Классика, 100г', kcal: 370, protein: 6.5, fat: 24.4, carbs: 49.5, source: 'Цех 85' },
        { name: 'Брауни Классический, 100г', kcal: 370, protein: 6.5, fat: 24.4, carbs: 49.5, source: 'Цех 85' },
        { name: 'Бретон Манго-Малина, 100г', kcal: 301, protein: 3.8, fat: 18.3, carbs: 30.2, source: 'Цех 85' },
        { name: 'Булочка с Корицей, 100г', kcal: 279, protein: 5.7, fat: 10.1, carbs: 38.8, source: 'Цех 85' },
        { name: 'Булочка с Маком, 100г', kcal: 279, protein: 5.7, fat: 10.1, carbs: 38.8, source: 'Цех 85' },
        { name: 'Булочка Шу, 100г', kcal: 294, protein: 3.3, fat: 24.5, carbs: 15.3, source: 'Цех 85' },
        { name: 'Буррата, 100г', kcal: 345, protein: 22, fat: 25, carbs: 0, source: 'Цех 85' },
        { name: 'Вареники с Вишней, 100г', kcal: 164, protein: 9, fat: 4.6, carbs: 21.8, source: 'Цех 85' },
        { name: 'Вареники с Творогом, 100г', kcal: 196, protein: 9.2, fat: 3.2, carbs: 32.6, source: 'Цех 85' },
        { name: 'Веган Инди Ролл, 100г', kcal: 198, protein: 5.3, fat: 7.9, carbs: 26.6, source: 'Цех 85' },
        { name: 'Веганский Торт, 100г', kcal: 301, protein: 4.8, fat: 18.5, carbs: 28.2, source: 'Цех 85' },
        { name: 'Веганский Торт Малина-Кокос, 100г', kcal: 300, protein: 4.8, fat: 18.5, carbs: 28.2, source: 'Цех 85' },
        { name: 'Вензель с Брусникой, Морошкой и Маскарпоне, 100г', kcal: 258, protein: 4.6, fat: 11.7, carbs: 31.7, source: 'Цех 85' },
        { name: 'Вензель с Малиной, 100г', kcal: 231, protein: 2.7, fat: 9.5, carbs: 32, source: 'Цех 85' },
        { name: 'Гаспачо, 100г', kcal: 42, protein: 0.9, fat: 2, carbs: 5, source: 'Цех 85' },
        { name: 'Говядина в Соусе «Велюте» с Гречкой, 100г', kcal: 161, protein: 7.4, fat: 9.4, carbs: 11.8, source: 'Цех 85' },
        { name: 'Горячий Напиток Груша-Миндаль, 100г', kcal: 40, protein: 0, fat: 0, carbs: 9.9, source: 'Цех 85' },
        { name: 'Горячий Шоколад, 100г', kcal: 186, protein: 4.7, fat: 13.8, carbs: 12, source: 'Цех 85' },
        { name: 'Гранатовый Пунш, 100г', kcal: 30, protein: 0.2, fat: 0.1, carbs: 7.1, source: 'Цех 85' },
        { name: 'Гранатовый Пунш, 100г', kcal: 144, protein: 0.6, fat: 0.3, carbs: 34.8, source: 'Цех 85' },
        { name: 'Грибной Крем-Суп, 100г', kcal: 183, protein: 4, fat: 11.4, carbs: 16.9, source: 'Цех 85' },
        { name: 'Двойной Капучино, 100г', kcal: 64, protein: 3.2, fat: 3.4, carbs: 5.1, source: 'Цех 85' },
        { name: 'Дениш с Грушей и Творогом, 100г', kcal: 238, protein: 5.2, fat: 10.5, carbs: 30.7, source: 'Цех 85' },
        { name: 'Запеканка Творожная, 100г', kcal: 246, protein: 15.2, fat: 14.3, carbs: 14, source: 'Цех 85' },
        { name: 'Зефир Чёрная Смородина, 100г', kcal: 261, protein: 0.2, fat: 0, carbs: 65, source: 'Цех 85' },
        { name: 'Индейка с Грибами и Кус-Кусом, 100г', kcal: 240, protein: 11, fat: 5.9, carbs: 35.4, source: 'Цех 85' },
        { name: 'Индейка с Грибами и Кус-Кусом, 100г', kcal: 576, protein: 26.4, fat: 14.2, carbs: 85, source: 'Цех 85' },
        { name: 'Инжирное Молоко, 100г', kcal: 96, protein: 0.9, fat: 0, carbs: 23.1, source: 'Цех 85' },
        { name: 'Ириски с Морской Солью, 100г', kcal: 391, protein: 1.3, fat: 13.3, carbs: 66.8, source: 'Цех 85' },
        { name: 'Ириски с Морской Солью в Белой Шоколадной Глазури, 100г', kcal: 391, protein: 1.3, fat: 13.3, carbs: 66.8, source: 'Цех 85' },
        { name: 'Йогурт 4%, 100г', kcal: 66, protein: 3.2, fat: 4, carbs: 4.7, source: 'Цех 85' },
        { name: 'Йогурт Малина и Ежевика, 100г', kcal: 66, protein: 3.4, fat: 2.2, carbs: 4.7, source: 'Цех 85' },
        { name: 'Йогурт Натуральный, 100г', kcal: 66, protein: 3.2, fat: 3.2, carbs: 4.7, source: 'Цех 85' },
        { name: 'Йогурт с Малиной и Ежевикой, 100г', kcal: 92, protein: 3.8, fat: 2.9, carbs: 12.7, source: 'Цех 85' },
        { name: 'Йогурт с Черникой и Ежевикой 2,2%, 100г', kcal: 62, protein: 3.4, fat: 2.2, carbs: 4.7, source: 'Цех 85' },
        { name: 'Йогурт с Черникой и Ежевикой 4%, 100г', kcal: 90, protein: 2.8, fat: 4, carbs: 10.7, source: 'Цех 85' },
        { name: 'Йогурт Черника и Ежевика, 100г', kcal: 66, protein: 3.4, fat: 2.2, carbs: 4.7, source: 'Цех 85' },
        { name: 'Какао, 100г', kcal: 76, protein: 3.8, fat: 4.1, carbs: 5, source: 'Цех 85' },
        { name: 'Каков Сэндвич, 100г', kcal: 197, protein: 10.6, fat: 10.2, carbs: 15.2, source: 'Цех 85' },
        { name: 'Кантуччи, 100г', kcal: 538, protein: 9, fat: 23.4, carbs: 72.9, source: 'Цех 85' },
        { name: 'Капкейк Абрикосовый, 100г', kcal: 393, protein: 3.9, fat: 23.8, carbs: 41.2, source: 'Цех 85' },
        { name: 'Капкейк Шоколадный, 100г', kcal: 350, protein: 3.7, fat: 23.2, carbs: 31.8, source: 'Цех 85' },
        { name: 'Капучино, 100г', kcal: 64, protein: 3.2, fat: 3.4, carbs: 5.1, source: 'Цех 85' },
        { name: 'Каша Овсяная с Бананом и Ванилью, 100г', kcal: 81, protein: 8.8, fat: 4.2, carbs: 2, source: 'Цех 85' },
        { name: 'Каша Овсяная с Бананом и Шоколадом, 100г', kcal: 137, protein: 3.6, fat: 7.6, carbs: 13.7, source: 'Цех 85' },
        { name: 'Каша Овсяная с Вишней, 100г', kcal: 127, protein: 4.3, fat: 4, carbs: 18.3, source: 'Цех 85' },
        { name: 'Каша Овсяная с Клубникой, 100г', kcal: 101, protein: 3.3, fat: 4.5, carbs: 11.8, source: 'Цех 85' },
        { name: 'Каша Овсяная с Малиной, 100г', kcal: 124, protein: 3.8, fat: 6.4, carbs: 12.8, source: 'Цех 85' },
        { name: 'Каша Овсяная с Яблоком и Корицей, 100г', kcal: 93, protein: 3.1, fat: 3.6, carbs: 12.1, source: 'Цех 85' },
        { name: 'Каша Пина-Колада, 100г', kcal: 144, protein: 5.6, fat: 8.8, carbs: 10.7, source: 'Цех 85' },
        { name: 'Каша с Бананом и Шоколадом, 100г', kcal: 153, protein: 4, fat: 7.7, carbs: 17, source: 'Цех 85' },
        { name: 'Комбуча Кофе, 100г', kcal: 20, protein: 0, fat: 0, carbs: 5, source: 'Цех 85' },
        { name: 'Конверт с Курицей и Грибами, 100г', kcal: 302, protein: 7.7, fat: 17.7, carbs: 25.3, source: 'Цех 85' },
        { name: 'Конверт с Моцареллой и Томатами, 100г', kcal: 326, protein: 9.9, fat: 21.2, carbs: 23.7, source: 'Цех 85' },
        { name: 'Конверт Шпинат Рикотта, 100г', kcal: 348, protein: 8.5, fat: 21.8, carbs: 29.5, source: 'Цех 85' },
        { name: 'Кофе с Молоком, 100г', kcal: 17, protein: 0.9, fat: 0.9, carbs: 1.4, source: 'Цех 85' },
        { name: 'Красная Рыба с Картофельным Пюре и Соусом из Кинзы, 100г', kcal: 134, protein: 6.9, fat: 15.3, carbs: 12.3, source: 'Цех 85' },
        { name: 'Краст из Овсянки с Клюквой, 100г', kcal: 383, protein: 5, fat: 15, carbs: 43.1, source: 'Цех 85' },
        { name: 'Краст Яблочный с Грецким Орехом, 100г', kcal: 283, protein: 3.4, fat: 13.2, carbs: 37.6, source: 'Цех 85' },
        { name: 'Круассан Классический, 100г', kcal: 394, protein: 5.3, fat: 23.2, carbs: 37.3, source: 'Цех 85' },
        { name: 'Круассан с Копчёной Индейкой и Баклажаном, 100г', kcal: 152, protein: 2.5, fat: 8.8, carbs: 15.7, source: 'Цех 85' },
        { name: 'Круассан с Лососем и Сливочным Сыром, 100г', kcal: 288, protein: 9.4, fat: 18.4, carbs: 19.3, source: 'Цех 85' },
        { name: 'Круассан с Лососем и Яйцом, 100г', kcal: 182, protein: 6, fat: 10, carbs: 16.9, source: 'Цех 85' },
        { name: 'Круассан с Миндальным Кремом, 100г', kcal: 366, protein: 5.6, fat: 19.7, carbs: 39.9, source: 'Цех 85' },
        { name: 'Круассан с Сыром, 100г', kcal: 383, protein: 8.9, fat: 23, carbs: 32, source: 'Цех 85' },
        { name: 'Круассан с Шоколадом, 100г', kcal: 371, protein: 5.9, fat: 17.9, carbs: 43, source: 'Цех 85' },
        { name: 'Кукурузный Крем-Суп, 100г', kcal: 133, protein: 3.8, fat: 8.3, carbs: 10.7, source: 'Цех 85' },
        { name: 'Кулич Пасхальный Большой, 100г', kcal: 348, protein: 5.7, fat: 12.7, carbs: 52.7, source: 'Цех 85' },
        { name: 'Кулич Пасхальный Малый, 100г', kcal: 347, protein: 5.7, fat: 12.6, carbs: 52.6, source: 'Цех 85' },
        { name: 'Куриная Котлета с Беконом и Картофелем Айдахо, 100г', kcal: 120, protein: 9, fat: 10.9, carbs: 5.5, source: 'Цех 85' },
        { name: 'Куриные Котлетки с Рисом, 100г', kcal: 236, protein: 10.1, fat: 7.6, carbs: 31.7, source: 'Цех 85' },
        { name: 'Куриные Котлетки с Рисом и Грибным Соусом, 100г', kcal: 236, protein: 10.1, fat: 7.6, carbs: 31.7, source: 'Цех 85' },
        { name: 'Куриные Тефтели с Гречей и Грибным Соусом, 100г', kcal: 169, protein: 9.8, fat: 6, carbs: 19, source: 'Цех 85' },
        { name: 'Куриный Суп с Митболлами, 100г', kcal: 78, protein: 5, fat: 2.6, carbs: 8.5, source: 'Цех 85' },
        { name: 'Курник, 100г', kcal: 309, protein: 12.3, fat: 15.9, carbs: 29.2, source: 'Цех 85' },
        { name: 'Латте, 100г', kcal: 62, protein: 3.1, fat: 3.3, carbs: 4.9, source: 'Цех 85' },
        { name: 'Латте Декаф, 100г', kcal: 60, protein: 3, fat: 3.2, carbs: 4.8, source: 'Цех 85' },
        { name: 'Латте Имбирный Пряник, 100г', kcal: 89, protein: 2.7, fat: 2.7, carbs: 13.4, source: 'Цех 85' },
        { name: 'Латте Кедровый Орех, 100г', kcal: 99, protein: 3.3, fat: 5, carbs: 10.3, source: 'Цех 85' },
        { name: 'Латте Цитрусовый, 100г', kcal: 238, protein: 1.3, fat: 1.5, carbs: 36.3, source: 'Цех 85' },
        { name: 'Лимонад Маракуйя-Гуава, 100г', kcal: 16, protein: 0.3, fat: 0, carbs: 3.6, source: 'Цех 85' },
        { name: 'Лимонад Тархун-Киви, 100г', kcal: 8, protein: 0.6, fat: 0.2, carbs: 1.5, source: 'Цех 85' },
        { name: 'Лимонад Цитрус Тимьян, 100г', kcal: 11, protein: 0.4, fat: 0.1, carbs: 2.2, source: 'Цех 85' },
        { name: 'Лодочка с Вишней, 100г', kcal: 244, protein: 5.4, fat: 11.3, carbs: 30.4, source: 'Цех 85' },
        { name: 'Лунный Латте, 100г', kcal: 48, protein: 2.4, fat: 2.5, carbs: 4.1, source: 'Цех 85' },
        { name: 'Макарон Ваниль, 100г', kcal: 335, protein: 6.5, fat: 10.2, carbs: 47.3, source: 'Цех 85' },
        { name: 'Макарон Груша-Дорблю, 100г', kcal: 292, protein: 5.6, fat: 6.5, carbs: 52.1, source: 'Цех 85' },
        { name: 'Макаронс Апельсин, 100г', kcal: 292, protein: 5.6, fat: 6.5, carbs: 52.1, source: 'Цех 85' },
        { name: 'Макаронс Бабл-Гам, 100г', kcal: 392, protein: 6.7, fat: 13.6, carbs: 48.3, source: 'Цех 85' },
        { name: 'Макаронс Малина, 100г', kcal: 362, protein: 7.1, fat: 16.5, carbs: 46.4, source: 'Цех 85' },
        { name: 'Макаронс Черника, 100г', kcal: 308, protein: 5.9, fat: 7.5, carbs: 50.3, source: 'Цех 85' },
        { name: 'Макаронс Шоколад, 100г', kcal: 351, protein: 6.8, fat: 13.8, carbs: 48.8, source: 'Цех 85' },
        { name: 'Макаронс Яблоко, 100г', kcal: 345, protein: 6.3, fat: 11.7, carbs: 43, source: 'Цех 85' },
        { name: 'Малиновый День, 100г', kcal: 242, protein: 4, fat: 14.6, carbs: 23.7, source: 'Цех 85' },
        { name: 'Малиновый Зефир, 100г', kcal: 248, protein: 0.2, fat: 0.1, carbs: 61.8, source: 'Цех 85' },
        { name: 'Мармелад Апельсин-Корица, 100г', kcal: 224, protein: 0.4, fat: 0, carbs: 55.5, source: 'Цех 85' },
        { name: 'Мармелад Манго, 100г', kcal: 221, protein: 0.4, fat: 0, carbs: 54.9, source: 'Цех 85' },
        { name: 'Мармелад Чёрная Смородина, 100г', kcal: 206, protein: 0.4, fat: 0.1, carbs: 51.2, source: 'Цех 85' },
        { name: 'Массала Латте, 100г', kcal: 76, protein: 2.6, fat: 2.7, carbs: 10.1, source: 'Цех 85' },
        { name: 'Матча Латте, 100г', kcal: 60, protein: 3, fat: 3.2, carbs: 4.9, source: 'Цех 85' },
        { name: 'Маффин Маковый с Лимоном, 100г', kcal: 254, protein: 6.9, fat: 27.3, carbs: 40, source: 'Цех 85' },
        { name: 'Маффин Шоколадный, 100г', kcal: 420, protein: 5.1, fat: 26.8, carbs: 39.7, source: 'Цех 85' },
        { name: 'Маффин Ягодный, 100г', kcal: 363, protein: 4.9, fat: 21.9, carbs: 35.5, source: 'Цех 85' },
        { name: 'Медовая Гранола, 100г', kcal: 476, protein: 12, fat: 21.6, carbs: 58.2, source: 'Цех 85' },
        { name: 'Медовик Классический, 100г', kcal: 310, protein: 3.6, fat: 14.6, carbs: 42.1, source: 'Цех 85' },
        { name: 'Медовик Шоколадный, 100г', kcal: 318, protein: 3.5, fat: 18, carbs: 35.8, source: 'Цех 85' },
        { name: 'Меренга Павлова с Малиной, 100г', kcal: 274, protein: 5, fat: 10.7, carbs: 39.5, source: 'Цех 85' },
        { name: 'Морковный Торт, 100г', kcal: 344, protein: 3.9, fat: 20.5, carbs: 36.1, source: 'Цех 85' },
        { name: 'Морошка-Бузина, 100г', kcal: 25, protein: 0, fat: 0.1, carbs: 6, source: 'Цех 85' },
        { name: 'Морс Лесные Ягоды, 100г', kcal: 39, protein: 0.2, fat: 0.1, carbs: 9.3, source: 'Цех 85' },
        { name: 'Морс Облепиха и Розмарин, 100г', kcal: 51, protein: 0.2, fat: 1.1, carbs: 10.1, source: 'Цех 85' },
        { name: 'Муравей, 100г', kcal: 422, protein: 5.3, fat: 24, carbs: 45.6, source: 'Цех 85' },
        { name: 'Напиток Цитрус-Имбирь, 100г', kcal: 82, protein: 0.4, fat: 0.1, carbs: 19.7, source: 'Цех 85' },
        { name: 'Наполеон, 100г', kcal: 361, protein: 2.9, fat: 19.1, carbs: 46.1, source: 'Цех 85' },
        { name: 'Орешек со Сгущенкой, 100г', kcal: 385, protein: 6.6, fat: 16.6, carbs: 52.5, source: 'Цех 85' },
        { name: 'Паста Фузили с Цыпленком, 100г', kcal: 190, protein: 9.6, fat: 3.3, carbs: 30.6, source: 'Цех 85' },
        { name: 'Паста Фузилли с Ципленком и Соусом из Оливок, 100г', kcal: 190, protein: 9.6, fat: 3.3, carbs: 30.6, source: 'Цех 85' },
        { name: 'Паштет из Куриной Печени, 100г', kcal: 250, protein: 11.8, fat: 19.5, carbs: 6.7, source: 'Цех 85' },
        { name: 'Пельмени с Говядиной и Свининой, 100г', kcal: 177, protein: 9.5, fat: 6.4, carbs: 20.4, source: 'Цех 85' },
        { name: 'Пельмени с Сыром и Шпинатом, 100г', kcal: 177, protein: 8.4, fat: 7, carbs: 20.1, source: 'Цех 85' },
        { name: 'Печенье Кантуччи, 100г', kcal: 518, protein: 8.4, fat: 22, carbs: 71.7, source: 'Цех 85' },
        { name: 'Печенье Мадлен, 100г', kcal: 347, protein: 4.6, fat: 20.7, carbs: 35.6, source: 'Цех 85' },
        { name: 'Печенье Овсяное с Клюквой и Шоколадом, 100г', kcal: 409, protein: 6.7, fat: 20.8, carbs: 46.9, source: 'Цех 85' },
        { name: 'Печенье Овсяное с Лимоном, 100г', kcal: 400, protein: 9.6, fat: 23.2, carbs: 38.2, source: 'Цех 85' },
        { name: 'Печенье Орешек, 100г', kcal: 381, protein: 6.3, fat: 16.5, carbs: 52, source: 'Цех 85' },
        { name: 'Печенье Творожное с Апельсином и Шоколадом, 100г', kcal: 381, protein: 7.8, fat: 19.4, carbs: 43.8, source: 'Цех 85' },
        { name: 'Печенье Шоколадное Фигурное "Крошка", 100г', kcal: 428, protein: 5.1, fat: 16.7, carbs: 64.2, source: 'Цех 85' },
        { name: 'Пирог Брусника и Яблоко, 100г', kcal: 213, protein: 4, fat: 7.3, carbs: 32.9, source: 'Цех 85' },
        { name: 'Пирог Грибы с Картофелем, 100г', kcal: 188, protein: 4.3, fat: 5.4, carbs: 28.8, source: 'Цех 85' },
        { name: 'Пирог Капуста, 100г', kcal: 161, protein: 4.9, fat: 3.5, carbs: 25.4, source: 'Цех 85' },
        { name: 'Пирог Курник, 100г', kcal: 207, protein: 10.4, fat: 5.6, carbs: 26.2, source: 'Цех 85' },
        { name: 'Пирог Мясо, 100г', kcal: 208, protein: 9.5, fat: 7.2, carbs: 24.5, source: 'Цех 85' },
        { name: 'Пирог с Вишней, 100г', kcal: 235, protein: 3.6, fat: 2.8, carbs: 41.6, source: 'Цех 85' },
        { name: 'Пирог с Красной Рыбой и Брокколи, 100г', kcal: 205, protein: 7.2, fat: 6.5, carbs: 27.7, source: 'Цех 85' },
        { name: 'Пирог Семга и Брокколи, 100г', kcal: 205, protein: 7.2, fat: 6.5, carbs: 27.7, source: 'Цех 85' },
        { name: 'Пирог Сыр и Шпинат, 100г', kcal: 231, protein: 8.8, fat: 10, carbs: 24.6, source: 'Цех 85' },
        { name: 'Пирог Творог и Ваниль, 100г', kcal: 259, protein: 10.2, fat: 6.5, carbs: 37.5, source: 'Цех 85' },
        { name: 'Пирог Тыквенный с Индейкой и Грибами, 100г', kcal: 198, protein: 6.7, fat: 6.1, carbs: 26.7, source: 'Цех 85' },
        { name: 'Пирожное "Эскимо", 100г', kcal: 337, protein: 5.1, fat: 17.3, carbs: 39.8, source: 'Цех 85' },
        { name: 'Пирожное Картошка, 100г', kcal: 324, protein: 5.4, fat: 16.2, carbs: 38.5, source: 'Цех 85' },
        { name: 'Пирожное Манго-Маракуйя, 100г', kcal: 317, protein: 3.6, fat: 18.5, carbs: 23.9, source: 'Цех 85' },
        { name: 'Пирожное Пинк, 100г', kcal: 369, protein: 4.4, fat: 29.7, carbs: 17, source: 'Цех 85' },
        { name: 'Плетенка-Сгущенка с Пеканом, 100г', kcal: 409, protein: 6.7, fat: 23.8, carbs: 39.2, source: 'Цех 85' },
        { name: 'Рагу из Индейки с Грибами и Картофелем, 100г', kcal: 162, protein: 6.3, fat: 9.6, carbs: 12.4, source: 'Цех 85' },
        { name: 'Распределяющая Булка, 100г', kcal: 257, protein: 3.6, fat: 18.2, carbs: 20.8, source: 'Цех 85' },
        { name: 'Раф, 100г', kcal: 39, protein: 1.1, fat: 2.1, carbs: 4, source: 'Цех 85' },
        { name: 'Ржаник с Картофелем и Красной Рыбой, 100г', kcal: 266, protein: 9.8, fat: 10.1, carbs: 34.1, source: 'Цех 85' },
        { name: 'Ролл Итальянский Цыплёнок, 100г', kcal: 253, protein: 13.2, fat: 5.1, carbs: 38.6, source: 'Цех 85' },
        { name: 'Ролл с Копченым Тофу, 100г', kcal: 168, protein: 6.9, fat: 8.1, carbs: 16.7, source: 'Цех 85' },
        { name: 'Ролл с Курицей и Беконом, 100г', kcal: 214, protein: 9.5, fat: 12, carbs: 17, source: 'Цех 85' },
        { name: 'Ролл с Хумусом, Грибами, Капустой Кимчи и Кедровыми Орешками, 100г', kcal: 236, protein: 8.4, fat: 14.6, carbs: 17.6, source: 'Цех 85' },
        { name: 'Ролл с Цыплёнком, 100г', kcal: 155, protein: 6.4, fat: 12.9, carbs: 3.2, source: 'Цех 85' },
        { name: 'Ролл с Цыпленком и Баклажаном "по-Восточному", 100г', kcal: 236, protein: 8.4, fat: 14.6, carbs: 17.6, source: 'Цех 85' },
        { name: 'Ролл Снежный Краб, 100г', kcal: 179, protein: 6.3, fat: 8.4, carbs: 19.6, source: 'Цех 85' },
        { name: 'Ром-Баба, 100г', kcal: 255, protein: 2.8, fat: 5.8, carbs: 46.1, source: 'Цех 85' },
        { name: 'Рулет Фисташковый, 100г', kcal: 293, protein: 5.4, fat: 11.5, carbs: 42, source: 'Цех 85' },
        { name: 'Рыбные Фрикадельки с Картофельным Пюре и Сливочным Соусом, 100г', kcal: 145, protein: 6.1, fat: 7.8, carbs: 12.3, source: 'Цех 85' },
        { name: 'Рыбные Фрикадельки с Пюре и Сливочным Соусом, 100г', kcal: 114, protein: 6.1, fat: 7.8, carbs: 12.3, source: 'Цех 85' },
        { name: 'Салат Азиатский с Тофу и Грибами, 100г', kcal: 100, protein: 3.1, fat: 9.8, carbs: 4, source: 'Цех 85' },
        { name: 'Салат из Печёных Корнеплодов, 100г', kcal: 132, protein: 5.6, fat: 3.9, carbs: 18.7, source: 'Цех 85' },
        { name: 'Салат Печёные Овощи с Фетой и Булгуром, 100г', kcal: 232, protein: 7.1, fat: 13.1, carbs: 21.5, source: 'Цех 85' },
        { name: 'Салат Печёный Грик, 100г', kcal: 100, protein: 4.3, fat: 6.4, carbs: 6.2, source: 'Цех 85' },
        { name: 'Салат с Вялеными Томатами, Грибами и Птитимом, 100г', kcal: 279, protein: 5.9, fat: 17.7, carbs: 24.5, source: 'Цех 85' },
        { name: 'Салат с Киноа и Яблоком, 100г', kcal: 74, protein: 2.9, fat: 5.1, carbs: 4.2, source: 'Цех 85' },
        { name: 'Салат с Копченой Рыбой и Бэби-Картофелем, 100г', kcal: 100, protein: 6, fat: 1.7, carbs: 7.1, source: 'Цех 85' },
        { name: 'Салат с Красной Рыбой и Соусом Васаби, 100г', kcal: 84, protein: 6.1, fat: 7.1, carbs: 2.9, source: 'Цех 85' },
        { name: 'Салат с Мидиями и Брокколи, 100г', kcal: 154, protein: 2.6, fat: 14.3, carbs: 6.2, source: 'Цех 85' },
        { name: 'Салат с Пряным Цыплёнком и Тыквой, 100г', kcal: 268, protein: 12.3, fat: 22.6, carbs: 3.8, source: 'Цех 85' },
        { name: 'Салат с Фузили и Тунцом, 100г', kcal: 123, protein: 6.4, fat: 1.6, carbs: 20.8, source: 'Цех 85' },
        { name: 'Салат Цезарь с Томатами Черри, 100г', kcal: 145, protein: 5.2, fat: 12.9, carbs: 1.9, source: 'Цех 85' },
        { name: 'Свинина с Овощами и Птитимом, 100г', kcal: 213, protein: 8.3, fat: 5.4, carbs: 32.9, source: 'Цех 85' },
        { name: 'Сендвич с Тунцом, 100г', kcal: 77, protein: 2.3, fat: 1, carbs: 14.8, source: 'Цех 85' },
        { name: 'Слойка с Сыром и Ветчиной, 100г', kcal: 337, protein: 8, fat: 20.4, carbs: 27.8, source: 'Цех 85' },
        { name: 'Слойка с Томатами и Моцареллой, 100г', kcal: 256, protein: 5.4, fat: 15.5, carbs: 21.5, source: 'Цех 85' },
        { name: 'Слойка с Томатами и Сыром, 100г', kcal: 243, protein: 5.6, fat: 15.1, carbs: 21.1, source: 'Цех 85' },
        { name: 'Сметанник с Черной Смородиной, 100г', kcal: 240, protein: 3.1, fat: 12.7, carbs: 29.4, source: 'Цех 85' },
        { name: 'Смузи Зеленый, 100г', kcal: 65, protein: 1.4, fat: 2.8, carbs: 8.5, source: 'Цех 85' },
        { name: 'Смузи Зелёный с Кокосовым Молоком, 100г', kcal: 78, protein: 1.4, fat: 2.8, carbs: 8.5, source: 'Цех 85' },
        { name: 'Смузи Клубника-Банан, 100г', kcal: 43, protein: 0.7, fat: 0.1, carbs: 10, source: 'Цех 85' },
        { name: 'Сосиска в Тесте, 100г', kcal: 339, protein: 7.5, fat: 23, carbs: 23.3, source: 'Цех 85' },
        { name: 'Сочень с Творогом, 100г', kcal: 335, protein: 8.1, fat: 14.6, carbs: 43.3, source: 'Цех 85' },
        { name: 'Страчателла, 100г', kcal: 295, protein: 22, fat: 24, carbs: 0, source: 'Цех 85' },
        { name: 'Суп с Индейкой и Овощами, 100г', kcal: 63, protein: 4.3, fat: 2.2, carbs: 7.4, source: 'Цех 85' },
        { name: 'Сыр Абонданс, 100г', kcal: 449, protein: 28, fat: 37, carbs: 0, source: 'Цех 85' },
        { name: 'Сыр Бофор, 100г', kcal: 465, protein: 28, fat: 38, carbs: 0, source: 'Цех 85' },
        { name: 'Сыр Грюйер, 100г', kcal: 434, protein: 29, fat: 35, carbs: 0, source: 'Цех 85' },
        { name: 'Сыр Проволоне, 100г', kcal: 305, protein: 23, fat: 23, carbs: 0, source: 'Цех 85' },
        { name: 'Сыр Халлуми, 100г', kcal: 332, protein: 21, fat: 26, carbs: 0, source: 'Цех 85' },
        { name: 'Сырники Замороженные, 100г', kcal: 183, protein: 14.2, fat: 7.5, carbs: 14, source: 'Цех 85' },
        { name: 'Сырники со Сметанно-Малиновым Соусом, 100г', kcal: 180, protein: 11.2, fat: 8.7, carbs: 14, source: 'Цех 85' },
        { name: 'Сырный Шарик, 100г', kcal: 282, protein: 6, fat: 12.6, carbs: 36.1, source: 'Цех 85' },
        { name: 'Сэндвич Ветчина с Сыром Чеддер, 100г', kcal: 161, protein: 6.8, fat: 7.4, carbs: 16.3, source: 'Цех 85' },
        { name: 'Сэндвич Ветчина с Сыром Чеддер и Томатной Сальсой, 100г', kcal: 148, protein: 7.3, fat: 6.3, carbs: 15.9, source: 'Цех 85' },
        { name: 'Сэндвич Печёный Баклажан с Хумусом и Грибами, 100г', kcal: 170, protein: 4.7, fat: 6.4, carbs: 23, source: 'Цех 85' },
        { name: 'Сэндвич с Тофу, Тыквой и Грибами, 100г', kcal: 171, protein: 5.6, fat: 8.7, carbs: 17.8, source: 'Цех 85' },
        { name: 'Сэндвич с Тунцом, 100г', kcal: 215, protein: 6.9, fat: 10.1, carbs: 23.7, source: 'Цех 85' },
        { name: 'Сэндвич с Тунцом, Печеным Перцем и Оливками, 100г', kcal: 215, protein: 6.9, fat: 10.1, carbs: 23.7, source: 'Цех 85' },
        { name: 'Тарт Два Шоколада, 100г', kcal: 309, protein: 4.8, fat: 20.9, carbs: 25.6, source: 'Цех 85' },
        { name: 'Тарт Лимонный, 100г', kcal: 332, protein: 4.3, fat: 16, carbs: 42.7, source: 'Цех 85' },
        { name: 'Тефтели Куриные с Гречей, 100г', kcal: 163, protein: 2.7, fat: 15.2, carbs: 4, source: 'Цех 85' },
        { name: 'Торт Банановый, 100г', kcal: 301, protein: 4.8, fat: 18.5, carbs: 28.2, source: 'Цех 85' },
        { name: 'Торт Маковый с Малиной, 100г', kcal: 302, protein: 3, fat: 15.1, carbs: 28.2, source: 'Цех 85' },
        { name: 'Торт Мята-Миндаль, 100г', kcal: 353, protein: 4.8, fat: 23, carbs: 22.7, source: 'Цех 85' },
        { name: 'Торт Нуагат, 100г', kcal: 363, protein: 4.1, fat: 25.1, carbs: 29.6, source: 'Цех 85' },
        { name: 'Торт Сметанник с Чёрной Смородиной, 100г', kcal: 240, protein: 3.1, fat: 12.7, carbs: 29.4, source: 'Цех 85' },
        { name: 'Треугольник с Лимоном, 100г', kcal: 318, protein: 4.7, fat: 15.6, carbs: 39.6, source: 'Цех 85' },
        { name: 'Треугольник с Творогом, 100г', kcal: 342, protein: 8, fat: 17.9, carbs: 34.2, source: 'Цех 85' },
        { name: 'Треугольник с Яблоком, 100г', kcal: 278, protein: 3.8, fat: 15.7, carbs: 27.8, source: 'Цех 85' },
        { name: 'Трюфель Белый Шоколад, 100г', kcal: 510, protein: 4.2, fat: 13.9, carbs: 40.8, source: 'Цех 85' },
        { name: 'Трюфель Молочный Шоколад, 100г', kcal: 538, protein: 9, fat: 39.6, carbs: 31.8, source: 'Цех 85' },
        { name: 'Трюфель Темный Шоколад, 100г', kcal: 498, protein: 6.7, fat: 41.2, carbs: 28.1, source: 'Цех 85' },
        { name: 'Тыквенный Крем-Суп, 100г', kcal: 134, protein: 3.5, fat: 4.7, carbs: 19.9, source: 'Цех 85' },
        { name: 'Тыквенный Латте с Чили, 100г', kcal: 54, protein: 0.5, fat: 1.1, carbs: 10.3, source: 'Цех 85' },
        { name: 'Улитка с Маком и Грецким Орехом, 100г', kcal: 383, protein: 5.7, fat: 21.1, carbs: 39.6, source: 'Цех 85' },
        { name: 'Филе Индейки с Кус-Кусом и Овощами, 100г', kcal: 131, protein: 6.7, fat: 7.6, carbs: 9, source: 'Цех 85' },
        { name: 'Фитнес Батончик, 100г', kcal: 280, protein: 9.4, fat: 6, carbs: 47.1, source: 'Цех 85' },
        { name: 'Фитнес Батончик, 100г', kcal: 343, protein: 6.5, fat: 10.5, carbs: 53.5, source: 'Цех 85' },
        { name: 'Флэт Уайт, 100г', kcal: 66, protein: 3.3, fat: 3.5, carbs: 5.2, source: 'Цех 85' },
        { name: 'Фрамбуаз с Сырно-Сливочным Кремом, 100г', kcal: 229, protein: 2.5, fat: 11.2, carbs: 29.4, source: 'Цех 85' },
        { name: 'Фрамбуаз с Творожным Кремом, 100г', kcal: 222, protein: 3.1, fat: 10.5, carbs: 28.8, source: 'Цех 85' },
        { name: 'Фрезье, 100г', kcal: 398, protein: 4.7, fat: 15.8, carbs: 58.8, source: 'Цех 85' },
        { name: 'Хачапури, 100г', kcal: 367, protein: 9.4, fat: 22.8, carbs: 28.3, source: 'Цех 85' },
        { name: 'Хлеб Альпийский, 100г', kcal: 223, protein: 6.8, fat: 5.2, carbs: 36.1, source: 'Цех 85' },
        { name: 'Хлеб Бездрожжевой Ржаной, 100г', kcal: 186, protein: 5.6, fat: 0.9, carbs: 38.9, source: 'Цех 85' },
        { name: 'Хлеб Бородинский, 100г', kcal: 201, protein: 6, fat: 0.9, carbs: 41.4, source: 'Цех 85' },
        { name: 'Хлеб Гречишный, 100г', kcal: 193, protein: 6.1, fat: 0.7, carbs: 39.1, source: 'Цех 85' },
        { name: 'Хлеб Деревенский, 100г', kcal: 205, protein: 5.7, fat: 1, carbs: 40.2, source: 'Цех 85' },
        { name: 'Хлеб Диетический с Отрубями и Овсянкой, 100г', kcal: 236, protein: 9, fat: 4.1, carbs: 40.8, source: 'Цех 85' },
        { name: 'Хлеб Зерновой, 100г', kcal: 222, protein: 7.2, fat: 5.3, carbs: 35.6, source: 'Цех 85' },
        { name: 'Хлеб Мультизерновой, 100г', kcal: 173, protein: 6.1, fat: 3.4, carbs: 29.5, source: 'Цех 85' },
        { name: 'Хлеб Мультизлаковый, 100г', kcal: 203, protein: 7, fat: 7.2, carbs: 27.1, source: 'Цех 85' },
        { name: 'Хлеб Эстонский, 100г', kcal: 256, protein: 7, fat: 4.3, carbs: 44.1, source: 'Цех 85' },
        { name: 'Цехобон с Карамелью, 100г', kcal: 345, protein: 4.5, fat: 15.8, carbs: 44.5, source: 'Цех 85' },
        { name: 'Цехобон с Шоколадом и Малиной, 100г', kcal: 357, protein: 4.4, fat: 15.8, carbs: 46.6, source: 'Цех 85' },
        { name: 'Цеховое Фисташка, 100г', kcal: 345, protein: 4.5, fat: 15.8, carbs: 44.5, source: 'Цех 85' },
        { name: 'Цыплёнок по Азиатски, 100г', kcal: 155, protein: 4.6, fat: 4.8, carbs: 23.1, source: 'Цех 85' },
        { name: 'Чиа с Бананом, 100г', kcal: 49, protein: 0.6, fat: 2.9, carbs: 5.2, source: 'Цех 85' },
        { name: 'Чиа с Бананом и Кокосовым Молоком, 100г', kcal: 86, protein: 2, fat: 5.6, carbs: 7, source: 'Цех 85' },
        { name: 'Чиабатта, 100г', kcal: 155, protein: 5, fat: 0.8, carbs: 31.4, source: 'Цех 85' },
        { name: 'Чиабатта Солод, 100г', kcal: 206, protein: 2, fat: 6.4, carbs: 40, source: 'Цех 85' },
        { name: 'Чизкейк, 100г', kcal: 331, protein: 6.7, fat: 19.9, carbs: 31.3, source: 'Цех 85' },
        { name: 'Чизкейк Апельсиново-Тыквенный, 100г', kcal: 332, protein: 4.4, fat: 22.7, carbs: 27.1, source: 'Цех 85' },
        { name: 'Чизкейк Клубничный, 100г', kcal: 287, protein: 4, fat: 16, carbs: 31.6, source: 'Цех 85' },
        { name: 'Чизкейк с Клубникой, 100г', kcal: 267, protein: 7.6, fat: 12.8, carbs: 30.4, source: 'Цех 85' },
        { name: 'Чизкейк Шоколадный, 100г', kcal: 332, protein: 5.5, fat: 25.6, carbs: 19.1, source: 'Цех 85' },
        { name: 'Шоколадный Эклер, 100г', kcal: 346, protein: 3.3, fat: 18.3, carbs: 41.3, source: 'Цех 85' },
        { name: 'Эклер Крем-Карамель, 100г', kcal: 341, protein: 3.4, fat: 16.7, carbs: 44.2, source: 'Цех 85' },
        { name: 'Эклер Малиновый, 100г', kcal: 309, protein: 2.6, fat: 15.9, carbs: 38.8, source: 'Цех 85' },
        { name: 'Эклер Манго, 100г', kcal: 328, protein: 2.7, fat: 16.7, carbs: 41.8, source: 'Цех 85' },
        { name: 'Эклер с Ванильным Кремом, 100г', kcal: 197, protein: 3, fat: 12, carbs: 19.2, source: 'Цех 85' },
        { name: 'Эклер с Творожным Кремом, 100г', kcal: 346, protein: 4.4, fat: 17.2, carbs: 43.2, source: 'Цех 85' },
        { name: 'Эклер Сливочный, 100г', kcal: 348, protein: 2.8, fat: 18.5, carbs: 42.4, source: 'Цех 85' },
        { name: 'Эклер Черничный, 100г', kcal: 299, protein: 3.8, fat: 13.7, carbs: 40, source: 'Цех 85' },
        { name: 'Ягодный Тарт, 100г', kcal: 282, protein: 4.1, fat: 13.9, carbs: 33.6, source: 'Цех 85' }
    ];
    // Поиск по подстроке (без учёта регистра), совпадения с начала строки — выше в списке.
    // Ограничиваем 6 подсказками, чтобы не перегружать выпадашку на телефоне.
    function searchFoodDb(query) {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return FOOD_DB
            .filter(f => f.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q))
            .slice(0, 6);
    }
    // «Название [Источник]» — источник в квадратных скобках, только если у позиции он указан.
    const foodLabel = (item) => item.source ? `${item.name} [${item.source}]` : item.name;

    // Блоки приёмов пищи — раньше три ФИКСИРОВАННЫХ (Завтрак/Обед/Ужин), юзер попросил убрать
    // подписи и дать добавлять ещё блоки — но ТОЛЬКО на просматриваемый день: на следующий день
    // снова дефолтные три, ничего не переносится. dashState.foodMealSlots[date] — порядок id
    // блоков ИМЕННО для этого дня; без записи (день ещё не трогали) — дефолт из трёх id.
    // 'breakfast'/'lunch'/'dinner' в дефолте — те же ключи, что раньше писались в foodLog у старых
    // сохранений (просто без подписи-названия теперь) — так старые данные не съезжают и не рвутся.
    const DEFAULT_MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'];
    function getMealSlots(date) {
        const saved = (dashState.foodMealSlots || {})[date];
        return (saved && saved.length) ? saved : DEFAULT_MEAL_SLOTS;
    }
    function addMealSlot(date) {
        if (!dashState.foodMealSlots) dashState.foodMealSlots = {};
        dashState.foodMealSlots[date] = getMealSlots(date).concat(newUid());
        saveProgress();
        renderFood();
    }

    // даты текущей недели (Пн–Вс), содержащей сегодня
    function weekDates() {
        const now = new Date();
        const dow = (now.getDay() + 6) % 7; // 0 = понедельник
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
        const tKey = todayKey();
        return Array.from({ length: 7 }, (_, i) => {
            const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
            const key = fdt(d.getFullYear(), d.getMonth(), d.getDate());
            return { key, wd: WD_SHORT[d.getDay()], dayNum: d.getDate(), isToday: key === tKey };
        });
    }

    // null = сегодня; иначе 'YYYY-MM-DD' — просматриваем/редактируем прошлый день (см. §…
    // «Юзер попросил редактировать питание и за прошлые дни» — история давно не read-only).
    // Сама история питания по датам — фича Pro mode (см. HANDOFF.md §15), см. клик по history-btn-food.
    let currentFoodHistoryDate = null;

    function renderFood() {
        const root = document.getElementById('view-food');
        if (!root) return;
        if (!dashState.foodLog) dashState.foodLog = {};
        if (!dashState.calorieLog) dashState.calorieLog = {};
        const tKey = todayKey();
        const isHistory = !!currentFoodHistoryDate;
        const viewDate = currentFoodHistoryDate || tKey;
        // || familyView — в режиме просмотра члена семьи (Фаза 19) календарь истории питания
        // работает как обычный просмотр прошлого дня: подписка гейтит МОЙ доступ к своей истории,
        // а не право посмотреть уже расшаренные мне данные.
        const isPro = !!window.hasActiveSubscription || !!familyView;
        // Pro mode: вместо времени приёма пищи (нормальный режим) — счётчик калорий с автокомплитом
        // по FOOD_DB (см. HANDOFF.md — юзер попросил заменить механику именно в Pro mode).
        if (dashState.psychoMode) { renderFoodCalories(root, viewDate, isHistory, isPro); return; }
        const dayRec = dashState.foodLog[viewDate] || {};

        // Простые блоки (не график с часовой осью, см. HANDOFF.md §15): сверху время приёма (тот
        // же кнопочный time-scroll-container, что и «во сколько лёг/встал» в чек-апе — см.
        // renderTimeScroll — вместо нативного <input type="time">), ниже — что съел. Юзер попросил
        // убрать подписи «Завтрак/Обед/Ужин» — блоки теперь безымянные, plus id блока (data-meal)
        // используется только как ключ в foodLog, нигде не показывается.
        const slots = getMealSlots(viewDate);
        const cells = slots.map(mealId => {
            const rec = dayRec[mealId] || {};
            return `<div class="food-cell" data-meal="${mealId}">
                <div class="time-scroll-container food-time" data-meal="${mealId}"></div>
                <input type="text" class="food-text" enterkeyhint="done" data-field="text" maxlength="60" placeholder="что кушал" value="${esc(rec.text)}">
            </div>`;
        }).join('');
        // История — тот же кастомный ч/б календарь, что и у чек-апа (openCalendar), но доступ
        // только по активной подписке — без неё кнопка открывает пейволл Pro mode, а не календарь.
        const historyIcon = isPro
            ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>'
            : LOCK;
        root.innerHTML = `
            <div class="checkin-header-row">
                <h3 class="dash-subtitle" style="margin-bottom:0">Питание${isHistory ? '' : ' сегодня'}</h3>
                <span class="checkin-date-label" id="date-label-food"></span>
                <button class="history-btn${isHistory ? ' active' : ''}" id="history-btn-food" title="История (Pro mode)">${historyIcon}</button>
            </div>
            <div class="food-form" id="food-form">${cells}</div>
            <button type="button" class="dash-habit-add-btn" id="add-meal-btn">+ добавить приём пищи</button>
            ${isHistory ? '<button class="checkin-save-btn" id="back-to-today-food-btn">← Вернуться к сегодня</button>' : `
            <h3 class="dash-subtitle food-week-title">Эта неделя</h3>
            <div class="food-week" id="food-week"></div>`}`;
        updateDateLabel('food', isHistory ? viewDate : null);

        // Юзер попросил редактировать питание и за прошлые дни, не только за сегодня — пишем в
        // viewDate (совпадает с tKey, когда история не открыта), а не жёстко в tKey.
        function setMealField(mealId, field, value) {
            if (!dashState.foodLog[viewDate]) dashState.foodLog[viewDate] = {};
            if (!dashState.foodLog[viewDate][mealId]) dashState.foodLog[viewDate][mealId] = {};
            dashState.foodLog[viewDate][mealId][field] = value;
            const r = dashState.foodLog[viewDate][mealId];
            if (!r.time && !r.text) delete dashState.foodLog[viewDate][mealId];           // пустой приём — убрать
            if (!Object.keys(dashState.foodLog[viewDate]).length) delete dashState.foodLog[viewDate]; // пустой день — убрать
            saveProgress();
            if (!isHistory) renderFoodWeek();
        }

        // автосохранение по вводу (перерисовываем только недельный список, инпуты не трогаем) —
        // интерактивно для любой даты, включая прошлые дни через историю.
        root.querySelectorAll('.food-cell').forEach(cellEl => {
            const mealId = cellEl.dataset.meal;
            const rec = dayRec[mealId] || {};
            renderTimeScroll(cellEl.querySelector('.food-time'), rec.time || '', (label) => setMealField(mealId, 'time', label));
            const textInput = cellEl.querySelector('.food-text');
            textInput.addEventListener('input', (e) => setMealField(mealId, 'text', e.target.value));
            // Кнопка «Готово»/«Done» на мобильной клавиатуре — скрываем клавиатуру, значение уже
            // сохранено по input выше.
            textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); textInput.blur(); } });
        });
        if (!isHistory) renderFoodWeek();

        // Добавляет ещё один пустой блок ТОЛЬКО в просматриваемый день (viewDate) — см.
        // getMealSlots/addMealSlot выше: dashState.foodMealSlots хранится по дате, у других дней
        // не меняется, на следующий день (другой viewDate) снова дефолтные три блока.
        const addMealBtn = document.getElementById('add-meal-btn');
        if (addMealBtn) addMealBtn.addEventListener('click', () => addMealSlot(viewDate));

        const backBtn = document.getElementById('back-to-today-food-btn');
        if (backBtn) backBtn.addEventListener('click', () => { currentFoodHistoryDate = null; renderFood(); });

        const historyBtn = document.getElementById('history-btn-food');
        if (historyBtn) historyBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!isPro) { if (typeof openProModePaywall === 'function') openProModePaywall('food'); return; }
            if (isHistory) { currentFoodHistoryDate = null; renderFood(); return; }
            openCalendar({
                value: viewDate,
                onPick: (dateStr) => { currentFoodHistoryDate = dateStr; renderFood(); }
            });
        });
    }

    // Pro mode «Питание»: вместо трёх ячеек завтрак/обед/ужин с временем — счётчик калорий за
    // день. calorieLog[date] = [{id, name, kcal}] — плоский список позиций (не по приёмам пищи,
    // юзер добавляет в течение дня как есть). Автокомплит — searchFoodDb по FOOD_DB, плюс ручной
    // ввод для того, чего нет в базе. Разметка/классы переиспользуют .metric-* из renderPsychoMetrics
    // (goal-edit-* для инлайн-редактирования цели) — единый стиль с остальным Pro mode.
    function renderFoodCalories(root, viewDate, isHistory, isPro) {
        const entries = dashState.calorieLog[viewDate] || [];
        const total = entries.reduce((s, e) => s + (+e.kcal || 0), 0);
        const target = dashState.calorieTarget || 2000;
        const pct = target > 0 ? Math.min(100, Math.round(total / target * 100)) : (total > 0 ? 100 : 0);
        const over = total > target;
        const historyIcon = isPro
            ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>'
            : LOCK;
        root.innerHTML = `
            <div class="checkin-header-row">
                <h3 class="dash-subtitle" style="margin-bottom:0">Калории${isHistory ? '' : ' сегодня'}</h3>
                <span class="checkin-date-label" id="date-label-food"></span>
                <button class="history-btn${isHistory ? ' active' : ''}" id="history-btn-food" title="История (Pro mode)">${historyIcon}</button>
            </div>
            <div class="metric-row">
                <div class="metric-top">
                    <span class="metric-name-wrap"><span class="metric-name">Калории за день</span></span>
                    <span class="metric-val ${over ? 'over' : ''}"><b>${Math.round(total)}</b> / ${Math.round(target)} ккал</span>
                </div>
                <div class="metric-bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>
                <div class="metric-actions" id="cal-target-actions"><button class="metric-goal" type="button" id="cal-target-btn">цель ${Math.round(target)} ккал</button></div>
            </div>
            <div class="cal-add-row">
                <input type="text" class="formula-input" id="cal-search-input" placeholder="например, булочка с корицей [Цех85]" autocomplete="off">
                <div id="cal-suggestions" class="cal-suggestions"></div>
            </div>
            <div class="cal-manual-row">
                <span class="cal-manual-label">или вручную:</span>
                <input type="text" class="formula-input" id="cal-manual-name" placeholder="название" maxlength="40">
                <input type="text" class="formula-input cal-manual-kcal" id="cal-manual-kcal" inputmode="numeric" enterkeyhint="done" placeholder="ккал" min="0">
                <button type="button" class="metric-add" id="cal-manual-add" aria-label="Добавить">＋</button>
            </div>
            <div class="cal-day-list" id="cal-day-list"></div>
            ${isHistory ? '<button class="checkin-save-btn" id="back-to-today-food-btn">← Вернуться к сегодня</button>' : ''}`;
        updateDateLabel('food', isHistory ? viewDate : null);

        const rerender = () => renderFoodCalories(root, viewDate, isHistory, isPro);

        function renderList() {
            const list = document.getElementById('cal-day-list');
            if (!list) return;
            const recs = dashState.calorieLog[viewDate] || [];
            if (!recs.length) { list.innerHTML = '<div class="dash-habit-limit">Пока пусто — добавь, что съел</div>'; return; }
            list.innerHTML = recs.map(e => `<div class="cal-item">
                <span class="cal-item-name">${esc(e.name)}</span>
                <span class="cal-item-kcal">${Math.round(e.kcal)} ккал</span>
                <button type="button" class="cal-item-del" data-id="${e.id}" aria-label="Удалить">✕</button>
            </div>`).join('');
            list.querySelectorAll('.cal-item-del').forEach(b => b.addEventListener('click', () => removeEntry(b.dataset.id)));
        }
        renderList();

        // macros — необязательный {protein,fat,carbs} с позиции FOOD_DB (если она их несёт, см.
        // FOOD_DB/§34 в HANDOFF.md). В СУММУ дня/бар идёт только kcal (юзер попросил считать пока
        // только калории), но БЖУ сохраняются на самой записи — на будущее, когда понадобятся.
        function addEntry(name, kcal, macros) {
            if (!dashState.calorieLog[viewDate]) dashState.calorieLog[viewDate] = [];
            const entry = { id: newUid(), name, kcal };
            if (macros) { entry.protein = macros.protein; entry.fat = macros.fat; entry.carbs = macros.carbs; }
            dashState.calorieLog[viewDate].push(entry);
            saveProgress();
            rerender();
        }
        function removeEntry(id) {
            dashState.calorieLog[viewDate] = (dashState.calorieLog[viewDate] || []).filter(e => e.id !== id);
            if (!dashState.calorieLog[viewDate].length) delete dashState.calorieLog[viewDate];
            saveProgress();
            rerender();
        }

        // Юзер попросил редактировать калории и за прошлые дни — все контролы ниже интерактивны
        // независимо от isHistory, addEntry/removeEntry уже пишут в viewDate (совпадает с tKey,
        // когда история не открыта). Кнопка «Назад к сегодня» — отдельно, только в history-режиме.
        if (isHistory) {
            const backBtn = document.getElementById('back-to-today-food-btn');
            if (backBtn) backBtn.addEventListener('click', () => { currentFoodHistoryDate = null; renderFood(); });
        }
        const searchInput = document.getElementById('cal-search-input');
        const suggestBox = document.getElementById('cal-suggestions');
        searchInput.addEventListener('input', () => {
            const matches = searchFoodDb(searchInput.value);
            suggestBox.innerHTML = matches.map(m => {
                const macroAttrs = m.protein != null ? ` data-protein="${m.protein}" data-fat="${m.fat}" data-carbs="${m.carbs}"` : '';
                return `<button type="button" class="cal-suggestion" data-name="${esc(foodLabel(m))}" data-kcal="${m.kcal}"${macroAttrs}>${esc(foodLabel(m))}<span class="cal-suggestion-kcal">${m.kcal} ккал</span></button>`;
            }).join('');
            suggestBox.style.display = matches.length ? 'block' : 'none';
        });
        suggestBox.addEventListener('click', (e) => {
            const btn = e.target.closest('.cal-suggestion');
            if (!btn) return;
            const macros = btn.dataset.protein != null ? { protein: +btn.dataset.protein, fat: +btn.dataset.fat, carbs: +btn.dataset.carbs } : null;
            addEntry(btn.dataset.name, +btn.dataset.kcal, macros);
        });
        // Enter в поиске не должен никуда уходить — выбор позиции только кликом по подсказке
        // (значений может совпасть несколько «булочка ...», молчаливый выбор первой — плохой UX).
        searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

        const manualName = document.getElementById('cal-manual-name');
        const manualKcal = document.getElementById('cal-manual-kcal');
        const addManual = () => {
            const name = manualName.value.trim();
            const kcal = parseFloat(String(manualKcal.value).replace(',', '.'));
            if (!name || isNaN(kcal) || kcal < 0) return;
            addEntry(name, kcal);
        };
        document.getElementById('cal-manual-add').addEventListener('click', addManual);
        manualKcal.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManual(); });
        manualName.addEventListener('keydown', (e) => { if (e.key === 'Enter') manualKcal.focus(); });

        const targetBtn = document.getElementById('cal-target-btn');
        if (targetBtn) targetBtn.addEventListener('click', () => {
            const actions = document.getElementById('cal-target-actions');
            actions.innerHTML = `
                <span class="goal-edit-label">цель на день</span>
                <input type="text" class="goal-edit-input" inputmode="decimal" enterkeyhint="done" value="${Math.round(target)}" min="0">
                <span class="goal-edit-unit">ккал</span>
                <button class="goal-edit-save" type="button">ОК</button>
                <button class="goal-edit-cancel" type="button" aria-label="Отмена">✕</button>`;
            const gi = actions.querySelector('.goal-edit-input'); gi.focus(); gi.select();
            const save = () => {
                const v = parseFloat(String(gi.value).replace(',', '.'));
                if (!isNaN(v) && v >= 0) { dashState.calorieTarget = v; saveProgress(); }
                rerender();
            };
            actions.querySelector('.goal-edit-save').addEventListener('click', save);
            actions.querySelector('.goal-edit-cancel').addEventListener('click', rerender);
            gi.addEventListener('keydown', ev => { if (ev.key === 'Enter') save(); else if (ev.key === 'Escape') rerender(); });
        });

        const historyBtn = document.getElementById('history-btn-food');
        if (historyBtn) historyBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!isPro) { if (typeof openProModePaywall === 'function') openProModePaywall('food'); return; }
            if (isHistory) { currentFoodHistoryDate = null; renderFood(); return; }
            openCalendar({
                value: viewDate,
                onPick: (dateStr) => { currentFoodHistoryDate = dateStr; renderFood(); }
            });
        });
    }

    function renderFoodWeek() {
        const wk = document.getElementById('food-week');
        if (!wk) return;
        const days = weekDates();
        // Просто список приёмов пищи по дням (время · что ел) — без часовой оси/графика.
        const rows = days.map(day => {
            const rec = (dashState.foodLog || {})[day.key] || {};
            // Блоков теперь произвольное число (см. getMealSlots/addMealSlot) и без названий —
            // берём напрямую все заполненные записи дня, а не фиксированный MEALS-список.
            const meals = Object.values(rec).filter(m => m && (m.time || m.text));
            const chips = meals.slice().sort((a, b) => (a.time || '99').localeCompare(b.time || '99'))
                .map(m => `<span class="fw-chip">${m.time ? `<b>${m.time}</b> ` : ''}${m.text || 'приём пищи'}</span>`).join('');
            return `<div class="fw-row${day.isToday ? ' today' : ''}">
                <span class="fw-day">${day.wd}<small>${day.dayNum}</small></span>
                <div class="fw-meals">${chips || '<span class="fw-empty">нет записей</span>'}</div>
            </div>`;
        }).join('');
        wk.innerHTML = rows;
    }

    // === КАСТОМНЫЙ КАЛЕНДАРЬ (попап выбора даты, ч/б; заменяет нативный date-picker) ===
    const CAL_WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    function openCalendar(opts) {
        opts = opts || {};
        const sel = (opts.value && /^\d{4}-\d{2}-\d{2}$/.test(opts.value)) ? opts.value : todayKey();
        const maxKey = opts.maxDate || todayKey(); // по умолчанию будущее недоступно
        let vy = +sel.slice(0, 4), vm = +sel.slice(5, 7) - 1; // просматриваемые год/месяц

        const overlay = document.createElement('div');
        overlay.className = 'cal-overlay';
        document.body.appendChild(overlay);
        function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        function draw() {
            const startDow = (new Date(vy, vm, 1).getDay() + 6) % 7; // 0 = Пн
            const days = daysInMonth(vy, vm);
            let cells = '';
            for (let i = 0; i < startDow; i++) cells += '<span class="cal-cell empty"></span>';
            for (let d = 1; d <= days; d++) {
                const key = fdt(vy, vm, d);
                cells += `<button class="cal-cell${key === sel ? ' sel' : ''}${key === todayKey() ? ' today' : ''}" data-key="${key}"${key > maxKey ? ' disabled' : ''}>${d}</button>`;
            }
            overlay.innerHTML = `<div class="cal-card">
                <div class="cal-head">
                    <button class="cal-nav" data-nav="-1" type="button" aria-label="Предыдущий месяц">‹</button>
                    <span class="cal-title">${MONTH_NAMES[vm]} ${vy}</span>
                    <button class="cal-nav" data-nav="1" type="button" aria-label="Следующий месяц">›</button>
                </div>
                <div class="cal-grid cal-wd">${CAL_WD.map(w => `<span class="cal-wd-cell">${w}</span>`).join('')}</div>
                <div class="cal-grid cal-days">${cells}</div>
                <div class="cal-foot"><button class="cal-today" type="button" data-key="${todayKey()}">Сегодня</button></div>
            </div>`;
            overlay.querySelectorAll('.cal-nav').forEach(b => b.addEventListener('click', () => {
                vm += (+b.dataset.nav); if (vm < 0) { vm = 11; vy--; } else if (vm > 11) { vm = 0; vy++; }
                draw();
            }));
            overlay.querySelectorAll('.cal-cell[data-key]:not([disabled]), .cal-today').forEach(b =>
                b.addEventListener('click', () => { close(); if (opts.onPick) opts.onPick(b.dataset.key); }));
        }
        draw();
    }

    // Попап выбора МЕСЯЦА — сетка 12 кнопок + год, вместо полноценного календаря по дням (там не
    // нужна точность до дня, см. запрос юзера). Тот же .cal-overlay/.cal-card, что и у openCalendar,
    // просто другая сетка внутри. opts.value = {y, m} (m: 0-based), opts.onPick(y, m).
    function openMonthPicker(opts) {
        opts = opts || {};
        let vy = (opts.value && opts.value.y) || +todayKey().slice(0, 4);
        const selM = opts.value ? opts.value.m : null;
        const selY = opts.value ? opts.value.y : null;

        const overlay = document.createElement('div');
        overlay.className = 'cal-overlay';
        document.body.appendChild(overlay);
        function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        function draw() {
            const months = MONTH_NAMES.map((name, i) =>
                `<button class="cal-month-cell${vy === selY && i === selM ? ' sel' : ''}" data-m="${i}" type="button">${name.slice(0, 3)}</button>`
            ).join('');
            overlay.innerHTML = `<div class="cal-card">
                <div class="cal-head">
                    <button class="cal-nav" data-nav="-1" type="button" aria-label="Предыдущий год">‹</button>
                    <span class="cal-title">${vy}</span>
                    <button class="cal-nav" data-nav="1" type="button" aria-label="Следующий год">›</button>
                </div>
                <div class="cal-grid cal-months">${months}</div>
            </div>`;
            overlay.querySelectorAll('.cal-nav').forEach(b => b.addEventListener('click', () => { vy += (+b.dataset.nav); draw(); }));
            overlay.querySelectorAll('.cal-month-cell').forEach(b =>
                b.addEventListener('click', () => { close(); if (opts.onPick) opts.onPick(vy, +b.dataset.m); }));
        }
        draw();
    }

    // Модалка-календарь истории ОДНОЙ привычки за месяц — открывается кликом по строке в сводке
    // «Месяц» (см. renderMonthView), заменившей тепловую карту клеток на полосу-прогресс (юзер
    // попросил). Дни, когда привычка выполнена, просто зачёркнуты — то же требование юзера, без
    // заливки/цвета. Клик по дню — toggle, та же ретроактивная механика и XP-логика, что у
    // toggleHabitForDate (normal-mode «День»); будущее недоступно. Тот же .cal-overlay/.cal-card,
    // что и у openCalendar/openMonthPicker, но модалка не закрывается по клику на день — можно
    // отметить несколько дней подряд, закрывается явной кнопкой «Готово», кликом вне карточки или
    // Escape. При закрытии — renderMonthView(), чтобы полоса/счётчик/стрик подхватили изменения.
    function openHabitHistoryCalendar(habit, y, m) {
        let vy = y, vm = m;
        const overlay = document.createElement('div');
        overlay.className = 'cal-overlay';
        document.body.appendChild(overlay);
        function close() { overlay.remove(); document.removeEventListener('keydown', onKey); renderMonthView(); }
        function onKey(e) { if (e.key === 'Escape') close(); }
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        function draw() {
            const startDow = (new Date(vy, vm, 1).getDay() + 6) % 7; // 0 = Пн
            const days = daysInMonth(vy, vm);
            let cells = '';
            for (let i = 0; i < startDow; i++) cells += '<span class="cal-cell empty"></span>';
            for (let d = 1; d <= days; d++) {
                const key = fdt(vy, vm, d);
                const done = isDone(habit.uid, key);
                cells += `<button class="cal-cell${done ? ' done' : ''}${key === todayKey() ? ' today' : ''}" data-key="${key}"${key > todayKey() ? ' disabled' : ''}>${d}</button>`;
            }
            overlay.innerHTML = `<div class="cal-card">
                <div class="cal-habit-title">${esc(habit.text)}</div>
                <div class="cal-head">
                    <button class="cal-nav" data-nav="-1" type="button" aria-label="Предыдущий месяц">‹</button>
                    <span class="cal-title">${MONTH_NAMES[vm]} ${vy}</span>
                    <button class="cal-nav" data-nav="1" type="button" aria-label="Следующий месяц">›</button>
                </div>
                <div class="cal-grid cal-wd">${CAL_WD.map(w => `<span class="cal-wd-cell">${w}</span>`).join('')}</div>
                <div class="cal-grid cal-days">${cells}</div>
                <div class="cal-foot"><button class="cal-close" type="button">Готово</button></div>
            </div>`;
            overlay.querySelectorAll('.cal-nav').forEach(b => b.addEventListener('click', () => {
                vm += (+b.dataset.nav); if (vm < 0) { vm = 11; vy--; } else if (vm > 11) { vm = 0; vy++; }
                draw();
            }));
            overlay.querySelectorAll('.cal-cell[data-key]:not([disabled])').forEach(b => b.addEventListener('click', () => {
                toggleHabitForDate(habit, b.dataset.key);
                draw();
            }));
            overlay.querySelector('.cal-close').addEventListener('click', close);
        }
        draw();
    }

    // =========================================
    //   ПИТОМЕЦ (контракт для визуала, который добавим отдельно)
    //   стадия = от уровня; настроение = забота за 7 дней
    // =========================================
    const PET_STAGES = [
        { min: 10, name: 'Вожак',     stage: 4 },
        { min: 5,  name: 'Взрослый',  stage: 3 },
        { min: 2,  name: 'Подросток', stage: 2 },
        { min: 0,  name: 'Щенок',     stage: 1 }
    ];
    const PET_MOODS = [
        { min: 75, mood: 3, label: 'В отличной форме', note: 'ты держишь ритм' },
        { min: 50, mood: 2, label: 'Бодр',             note: 'так держать' },
        { min: 25, mood: 1, label: 'Подустал',         note: 'не пропадай надолго' },
        { min: 0,  mood: 0, label: 'Приуныл',          note: 'загляни почаще' }
    ];

    function petState() {
        const level = dashState.level || 1;
        const st = PET_STAGES.find(x => level >= x.min);
        const habits = dashState.habits || [];
        let sum = 0, activeDays = 0;
        for (let i = 0; i < 7; i++) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const key = fdt(d.getFullYear(), d.getMonth(), d.getDate());
            const rec = (dashState.history || {})[key] || {};
            const done = habits.filter(h => rec[h.uid]).length;
            let day = habits.length ? done / habits.length : 0;
            if (done > 0) activeDays++;
            const ch = (dashState.checkinHistory || {})[key];
            if (ch && (ch.morning || ch.evening)) day = Math.min(1, day + 0.1); // чек-ап — тоже забота
            sum += day;
        }
        const maxStreak = habits.length ? Math.max(0, ...habits.map(h => currentStreak(h.uid))) : 0;
        const care = Math.max(0, Math.min(100, Math.round((sum / 7) * 100 + Math.min(15, maxStreak * 2))));
        const md = PET_MOODS.find(x => care >= x.min);
        return { level, stage: st.stage, stageName: st.name, care, mood: md.mood, moodLabel: md.label, moodNote: md.note, maxStreak, activeDays };
    }
    window.petState = petState; // для будущего визуала

    function renderPet() {
        const root = document.getElementById('view-pet');
        if (!root) return;
        const p = petState();
        root.innerHTML = `
            <div class="pet-stage">${p.stageName} · уровень ${p.level}</div>
            <div class="pet-figure" data-stage="${p.stage}" data-mood="${p.mood}" id="pet-figure">
                <div class="pet-placeholder">питомец<br><span>стадия ${p.stage} · настроение ${p.mood}</span></div>
            </div>
            <div class="pet-mood">${p.moodLabel} <span class="pet-mood-note">— ${p.moodNote}</span></div>
            <div class="pet-care">
                <div class="pet-care-top"><span>забота за неделю</span><span class="pet-care-pct">${p.care}%</span></div>
                <div class="pet-care-bar"><i style="width:${p.care}%"></i></div>
            </div>
            <div class="pet-stats">
                <div class="pet-stat"><span>${p.maxStreak}</span>серия</div>
                <div class="pet-stat"><span>${p.activeDays}/7</span>активных дней</div>
                <div class="pet-stat"><span>${p.stage}/4</span>стадия</div>
            </div>
            <button class="pet-pet-btn" id="pet-pet-btn">погладить</button>`;
        const fig = root.querySelector('#pet-figure');
        setPetFigure(fig, p.stage, p.mood);
        root.querySelector('#pet-pet-btn').addEventListener('click', () => {
            fig.classList.remove('bounce'); void fig.offsetWidth; fig.classList.add('bounce');
        });
        updatePetRoamer();
    }

    // Подставляет картинку питомца: pics/wolf {стадия}_{настроение}.png.
    // Пока есть не все комбинации — фолбэк на настроение 3 той же стадии, иначе остаётся плейсхолдер.
    function setPetFigure(container, stage, mood) {
        const candidates = [`pics/wolf ${stage}_${mood}.png`, `pics/wolf ${stage}_3.png`];
        let i = 0;
        const tryNext = () => {
            if (i >= candidates.length) return; // не нашли — оставляем плейсхолдер
            const url = encodeURI(candidates[i]);
            const probe = new Image();
            probe.onload = () => { container.classList.add('has-img'); container.innerHTML = `<img class="pet-img" src="${url}" alt="питомец">`; };
            probe.onerror = () => { i++; tryNext(); };
            probe.src = url;
        };
        tryNext();
    }

    // Десктоп: питомец «бегает» по экранам (на мобильном скрыт)
    let petRoamTimer = null;
    const ROAMER_ENABLED = false; // временно скрыт по просьбе — поставь true, чтобы вернуть «бегающего» питомца
    function updatePetRoamer() {
        const roamer = document.getElementById('pet-roamer');
        if (!roamer) return;
        if (!ROAMER_ENABLED || window.matchMedia('(max-width: 900px)').matches) { roamer.style.display = 'none'; if (petRoamTimer) { clearInterval(petRoamTimer); petRoamTimer = null; } return; }
        roamer.style.display = 'block';
        const ps = petState();
        roamer.dataset.stage = ps.stage;
        roamer.dataset.mood = ps.mood;
        const move = () => {
            const x = 24 + Math.random() * Math.max(0, window.innerWidth - 130);
            const y = 90 + Math.random() * Math.max(0, window.innerHeight - 260);
            roamer.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        };
        if (!petRoamTimer) { move(); petRoamTimer = setInterval(move, 5000); }
    }

    // =========================================
    //   ОНБОРДИНГ: КОАЧМАРКИ + КОНТЕКСТНЫЕ ПОДСКАЗКИ
    // =========================================
    // Полный тур по всем вкладкам (юзер попросил расширить, когда «День» стал дефолтной подвкладкой
    // «Задач» вместо «Месяца» — старый тур целился только в тепловую карту). Шаги с taskViewMode
    // переключают normal-mode подвид «Задач» перед показом (см. showCoachStep) — сама вкладка
    // «Задачи» не меняется, это переключение ВНУТРИ неё. Остальные цели (психо-тумблер, кнопки
    // нижнего меню) — глобальный chrome вне .dash-content (index.html), в DOM всегда, независимо
    // от активной вкладки, переключать вкладку под них не нужно.
    const DAY_TOUR = [
        { text: 'Привет! Это трекер задач и твоего состояния. 14 дней — бесплатно, дальше нужна подписка (либо бесплатные недели за приглашённых друзей). Покажу за минуту, что где.' },
        { target: () => document.getElementById('help-btn'), text: 'Этот значок открывает тур заново в любой момент, если что-то забудешь.' },
        { target: () => document.getElementById('profile-btn'), text: 'Кнопка профиля — там твой ID, статус подписки и бонусных недель за друзей. Добавляй друзей и смотри их успехи.' },
        { target: () => document.querySelector('#top-nav-slot .day-nav-row'), taskViewMode: 'day', text: 'Стрелками листаешь дни вперёд-назад, календарь справа — прыжок на любую дату.' },
        { target: () => document.querySelector('.task-day-row'), taskViewMode: 'day', text: 'Нажми на задачу, чтобы отметить её — текст перечеркнётся, а огонёк рядом покажет серию дней подряд.', requiresHabits: true },
        { target: () => document.querySelector('.task-day-settings'), taskViewMode: 'day', text: 'Кнопка «⋯» — переименовать задачу, поставить напоминание и удалить.', requiresHabits: true },
        { target: () => document.getElementById('add-habit-btn-day') || document.querySelector('.dash-habit-limit'), taskViewMode: 'day', text: 'Список — твой. Удали лишнее через «⋯», а эта кнопка открывает создание новой — регулярной или разовой, только на сегодня (до 30 регулярных).' },
        { target: () => document.getElementById('task-day-fields'), taskViewMode: 'day', text: '«Событие дня» и «Задача дня» — быстрые заметки на выбранный день, текст появляется прямо справа от кнопки.' },
        { target: () => document.querySelector('.dm-toggle'), taskViewMode: 'day', text: 'Переключай на «Месяц», чтобы увидеть прогресс за месяц и историю по дням.' },
        { target: () => document.querySelector('.hm-row-head'), taskViewMode: 'month', text: 'Нажми на задачу — откроется календарь, где отмечены выполненные дни. Можно поправить и задним числом.', requiresHabits: true },
        { target: () => document.getElementById('life-wheel-month'), taskViewMode: 'month', text: 'Привяжи задачи к сферам жизни (в «⋯») — колесо заполнится и покажет баланс.', feature: 'lifeWheel' },
        { target: () => document.getElementById('btn-tasks-pro'), text: 'Pro mode — числовые показатели дня (км, сон, кофе…) вместо списка задач. Доступно только по платной подписке (не по бесплатным дням).' },
        { target: () => document.querySelector('.view-btn[data-view="training"]'), text: 'Игры — мини-игры, разблокируются по мере роста уровня.', feature: 'games' },
        { target: () => document.getElementById('btn-morning'), switchView: 'morning', text: 'Чек-ап — сон, настроение, энергия и здоровье шкалами 1–10, плюс графики за месяц.' },
        { target: () => document.getElementById('btn-evening'), switchView: 'evening', text: 'Вечер — итог дня, благодарность и что улучшить завтра.', feature: 'legacyCheckinFields' },
        { target: () => document.getElementById('btn-food'), switchView: 'food', text: 'Питание — дневник завтрака/обеда/ужина и сводка за неделю.' }
        // «Питомец» (.view-btn[data-view="pet"]) в тур не включён — кнопка скрыта насовсем через
        // CSS (display:none, см. habbittracker.css), это не активная фича, а не флаг вроде games/
        // legacyCheckinFields, которые можно было бы просто прогейтить через FEATURES.
    ];

    const VIEW_HINTS = {
        month:   'В «Месяце» — прогресс за месяц по каждой задаче. Нажми на задачу, чтобы открыть календарь и отметить любой день, включая задний числом.',
        morning: 'Чек-ап дня: время сна и подъёма, качество сна, настроение, энергия и здоровье — шкалами 1–10, сохраняется автоматически. Ниже — графики за текущий месяц: настроение/сон/энергия/здоровье и отдельно часы сна.',
        evening: 'Вечерний чек-ап: оценка дня, за что благодарен и что улучшить завтра.',
        food:    'Питание: для завтрака/обеда/ужина отметь время кнопкой и коротко запиши, что ел — сохраняется сразу. Ниже — сводка по дням за эту неделю.'
    };

    let tourSteps = [], tourIdx = 0;
    function startTour(steps) {
        const hasHabits = (dashState.habits || []).length > 0;
        tourSteps = steps.filter(s => (!s.feature || FEATURES[s.feature]) && (!s.requiresHabits || hasHabits));
        tourIdx = 0;
        const ov = document.getElementById('coach-overlay');
        if (!ov) return;
        ov.classList.add('active');
        showCoachStep(0);
    }
    function endTour() {
        const ov = document.getElementById('coach-overlay');
        if (ov) ov.classList.remove('active');
        if (!dashState.onboardingDone) { dashState.onboardingDone = true; saveProgress(); }
    }
    function showCoachStep(i) {
        if (i < 0 || i >= tourSteps.length) { endTour(); return; }
        tourIdx = i;
        const step = tourSteps[i];
        // Шаги внутри «Задач» указывают нужный normal-mode подвид (taskViewMode) — переключаем и
        // перерисовываем ПЕРЕД поиском таргета, иначе элемент другого подвида ещё не в DOM.
        if (step.taskViewMode && step.taskViewMode !== taskViewMode) { taskViewMode = step.taskViewMode; renderMonthView(); }
        // Шаги про Чек-ап/Вечер/Питание раньше просто подсвечивали кнопку вкладки, оставаясь на
        // «Задачах» — юзер попросил реально открывать экран, чтобы было видно содержимое, а не
        // только кнопку (тур «статично» стоял на одной вкладке). switchView — та же функция, что
        // и клик по кнопке таб-бара.
        if (step.switchView) switchView(step.switchView);
        const el = typeof step.target === 'function' ? step.target() : (step.target ? document.querySelector(step.target) : null);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => positionCoach(el, step, i), el ? 320 : 0);
    }
    function positionCoach(el, step, i) {
        const hole = document.getElementById('coach-hole');
        const tip = document.getElementById('coach-tip');
        if (!hole || !tip) return;
        const pad = 8;
        let placeBelow = true, r = null;
        if (el) {
            r = el.getBoundingClientRect();
            hole.style.display = 'block';
            hole.style.left = (r.left - pad) + 'px';
            hole.style.top = (r.top - pad) + 'px';
            hole.style.width = (r.width + pad * 2) + 'px';
            hole.style.height = (r.height + pad * 2) + 'px';
            placeBelow = r.top < window.innerHeight / 2;
        } else {
            // нет цели (приветствие) — дырка нулевого размера в центре, чтобы затемнить весь экран
            hole.style.display = 'block';
            hole.style.left = (window.innerWidth / 2) + 'px';
            hole.style.top = (window.innerHeight / 2) + 'px';
            hole.style.width = '0px';
            hole.style.height = '0px';
        }
        const last = i === tourSteps.length - 1;
        tip.querySelector('.coach-text').textContent = step.text;
        tip.querySelector('.coach-counter').textContent = `${i + 1} / ${tourSteps.length}`;
        tip.querySelector('.coach-next').textContent = last ? 'Готово' : 'Далее';
        tip.style.display = 'block';
        const tr = tip.getBoundingClientRect();
        let left, top;
        if (!el) {
            left = (window.innerWidth - tr.width) / 2;
            top = (window.innerHeight - tr.height) / 2;
        } else {
            left = Math.min(Math.max(8, r.left + r.width / 2 - tr.width / 2), window.innerWidth - tr.width - 8);
            top = placeBelow ? (r.bottom + pad + 12) : (r.top - pad - 12 - tr.height);
            top = Math.min(Math.max(8, top), window.innerHeight - tr.height - 8);
        }
        tip.style.left = Math.round(left) + 'px';
        tip.style.top = Math.round(top) + 'px';
    }

    // Контекстная подсказка при первом заходе во вкладку
    function maybeShowViewHint(view) {
        const banner = document.getElementById('onb-hint');
        if (!banner) return;
        // В режиме просмотра члена семьи (Фаза 19) подсказки онбординга не при чём — они про МОЙ
        // первый заход. Плюс защита от падения: строкой ниже читается dashState.seenHints[view],
        // а у чужого (отфильтрованного get_family_state) состояния этого поля может не быть.
        if (familyView) { banner.style.display = 'none'; return; }
        if (VIEW_HINTS[view] && !dashState.seenHints[view]) {
            banner.querySelector('.onb-hint-text').textContent = VIEW_HINTS[view];
            banner.style.display = 'flex';
            dashState.seenHints[view] = true;
            saveProgress();
        } else {
            banner.style.display = 'none';
        }
    }

    // === НАСТРОЙКИ ПРИВЫЧКИ ===
    // Модалка используется и для создания НОВОЙ задачи (юзер попросил открывать её сразу при
    // добавлении, вместо инлайн-инпута), и для правки существующей — общий рендер полей в
    // openHabitModalCommon, а create/edit различает isCreatingHabit (см. saveSettings).
    function openNewHabitModal(contextDate) {
        isCreatingHabit = true;
        newHabitContextDate = contextDate;
        currentEditIndex = null;
        openHabitModalCommon({ text: '', triggerText: '', reminderTime: null, areas: [], type: 'regular' }, 'Новая задача');
    }
    function openHabitSettings(index) {
        isCreatingHabit = false;
        newHabitContextDate = null;
        currentEditIndex = index;
        openHabitModalCommon(dashState.habits[index], 'Задача');
    }
    function openHabitModalCommon(habit, title) {
        const modal = document.getElementById('habit-settings-modal');
        const titleEl = document.getElementById('habit-settings-title');
        if (titleEl) titleEl.textContent = title;
        const nameInput = document.getElementById('setting-name-input');
        const triggerInput = document.getElementById('setting-trigger-input');
        const reminderToggle = document.getElementById('setting-reminder-toggle');
        const timeInput = document.getElementById('setting-time-input');
        if (nameInput) nameInput.value = habit.text || '';
        triggerInput.value = habit.triggerText || '';
        if (habit.reminderTime) {
            reminderToggle.checked = true; timeInput.value = habit.reminderTime; timeInput.disabled = false;
        } else {
            reminderToggle.checked = false; timeInput.value = '08:00'; timeInput.disabled = true;
        }
        // сферы колеса жизни (мультивыбор) — поле спрятано, пока FEATURES.lifeWheel выключен, но
        // разметку всё равно готовим (данные не теряются, просто не видны)
        const areasBox = document.getElementById('setting-areas');
        if (areasBox) {
            areasBox.innerHTML = LIFE_AREAS.map(a => `<button type="button" class="area-chip${(habit.areas || []).includes(a.id) ? ' sel' : ''}" data-area="${a.id}">${a.name}</button>`).join('');
            areasBox.querySelectorAll('.area-chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('sel')));
        }
        // Регулярная/Разовая — та же кнопка-пилюля, что День/Месяц (см. taskViewToggleHtml)
        const typeToggle = document.getElementById('habit-type-toggle');
        const dateField = document.getElementById('setting-date-field');
        const dateBtn = document.getElementById('setting-date-btn');
        pendingOneTimeDate = habit.date || newHabitContextDate || todayKey();
        const renderDateBtn = () => { if (dateBtn) dateBtn.textContent = formatFullDate(pendingOneTimeDate); };
        renderDateBtn();
        if (dateBtn) {
            dateBtn.onclick = () => openCalendar({ value: pendingOneTimeDate, maxDate: '2099-12-31', onPick: (key) => { pendingOneTimeDate = key; renderDateBtn(); } });
        }
        if (typeToggle) {
            const type = habit.type === 'oneTime' ? 'oneTime' : 'regular';
            const updateDateFieldVisibility = () => {
                const active = typeToggle.querySelector('.dm-toggle-btn.active');
                if (dateField) dateField.style.display = (active && active.dataset.type === 'oneTime') ? '' : 'none';
            };
            typeToggle.querySelectorAll('.dm-toggle-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.type === type);
                b.onclick = () => { typeToggle.querySelectorAll('.dm-toggle-btn').forEach(x => x.classList.toggle('active', x === b)); updateDateFieldVisibility(); };
            });
            updateDateFieldVisibility();
        }
        const delBtn0 = document.getElementById('settings-delete-btn');
        if (delBtn0) delBtn0.style.display = isCreatingHabit ? 'none' : ''; // создание — удалять пока нечего
        modal.classList.add('active');
        // переклонируем кнопки, чтобы сбросить старые обработчики
        const saveBtn = document.getElementById('settings-save-btn').cloneNode(true);
        const cancelBtn = document.getElementById('settings-cancel-btn').cloneNode(true);
        const closeBtn = document.getElementById('habit-settings-close').cloneNode(true);
        const delBtn = document.getElementById('settings-delete-btn').cloneNode(true);
        document.getElementById('settings-save-btn').replaceWith(saveBtn);
        document.getElementById('settings-cancel-btn').replaceWith(cancelBtn);
        document.getElementById('habit-settings-close').replaceWith(closeBtn);
        document.getElementById('settings-delete-btn').replaceWith(delBtn);
        const close = () => { modal.classList.remove('active'); currentEditIndex = null; isCreatingHabit = false; newHabitContextDate = null; pendingOneTimeDate = null; };
        saveBtn.addEventListener('click', () => { saveSettings(close); });
        cancelBtn.addEventListener('click', close);
        closeBtn.addEventListener('click', close);
        delBtn.addEventListener('click', () => {
            if (currentEditIndex === null) return;
            const idx = currentEditIndex;          // фиксируем: confirmDialog асинхронный
            const h = dashState.habits[idx];
            confirmDialog(`Удалить «${h.text}»?`, () => {
                // подчищаем историю удаляемой привычки
                Object.keys(dashState.history || {}).forEach(d => {
                    if (dashState.history[d][h.uid]) {
                        delete dashState.history[d][h.uid];
                        if (!Object.keys(dashState.history[d]).length) delete dashState.history[d];
                    }
                });
                dashState.habits.splice(idx, 1);
                saveProgress(); renderMonthView();
                close(); // закрываем модалку настроек привычки
            });
        });
        document.querySelector('#setting-reminder-toggle').addEventListener('change', (e) => { timeInput.disabled = !e.target.checked; });
    }
    // onSaved — коллбэк close() из openHabitModalCommon; вызывается только если реально сохранили
    // (пустое имя при СОЗДАНИИ — no-op, модалка остаётся открытой, как раньше вело себя Enter в
    // пустом инлайн-инпуте).
    function saveSettings(onSaved) {
        const nameInput = document.getElementById('setting-name-input');
        const name = nameInput ? nameInput.value.trim() : '';
        if (isCreatingHabit && !name) return;
        const triggerText = document.getElementById('setting-trigger-input').value.trim();
        const reminderTime = document.getElementById('setting-reminder-toggle').checked ? document.getElementById('setting-time-input').value : null;
        const areasBox = document.getElementById('setting-areas');
        const areas = areasBox ? [...areasBox.querySelectorAll('.area-chip.sel')].map(c => c.dataset.area) : [];
        const typeToggle = document.getElementById('habit-type-toggle');
        const activeBtn = typeToggle ? typeToggle.querySelector('.dm-toggle-btn.active') : null;
        const type = (activeBtn && activeBtn.dataset.type === 'oneTime') ? 'oneTime' : 'regular';

        if (isCreatingHabit) {
            const habit = { text: name, completed: false, uid: newUid(), areas, triggerText, reminderTime, type };
            if (type === 'oneTime') habit.date = pendingOneTimeDate || newHabitContextDate || todayKey();
            dashState.habits.push(habit);
        } else {
            if (currentEditIndex === null) return;
            const h = dashState.habits[currentEditIndex];
            if (name) h.text = name;
            h.triggerText = triggerText;
            h.reminderTime = reminderTime;
            h.areas = areas;
            h.type = type;
            if (type === 'oneTime') h.date = pendingOneTimeDate || h.date || newHabitContextDate || todayKey();
        }
        saveProgress(); renderMonthView();
        if (onSaved) onSaved();
    }

    // Горизонтальный скролл выбора времени (шаг 30 минут, 00:00-23:30) — используется вместо
    // нативного <input type="time"> для «во сколько лёг/встал» в чек-апе (см. HANDOFF.md §15).
    // onSelect опущен → рендерится в «залоченном» виде (кнопки disabled, для истории/после сохранения).
    function renderTimeScroll(container, currentVal, onSelect) {
        container.innerHTML = '';
        container.className = 'time-scroll-container';
        let activeBtn = null;
        for (let h = 0; h < 24; h++) {
            for (const mm of [0, 30]) {
                const label = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
                const btn = document.createElement('button');
                btn.type = 'button';
                const isActive = label === currentVal;
                btn.className = `time-slot-btn${isActive ? ' active' : ''}`;
                btn.textContent = label;
                if (isActive) activeBtn = btn;
                if (onSelect) {
                    btn.addEventListener('click', () => {
                        container.querySelectorAll('.time-slot-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        onSelect(label);
                    });
                } else {
                    btn.disabled = true;
                }
                container.appendChild(btn);
            }
        }
        requestAnimationFrame(() => {
            (activeBtn || container.children[16]).scrollIntoView({ inline: 'center', block: 'nearest' });
        });
    }

    // === ЧЕКАПЫ ===
    // Нет отдельной кнопки «Сохранить» — форма за СЕГОДНЯ всегда интерактивна и автосохраняется
    // после каждого нажатия/ввода (см. autoSaveCheckin). Заблокированный read-only режим остаётся
    // только для просмотра ПРОШЛЫХ дней через календарь (см. loadHistoryData).
    function initCheckins(type) {
        if (!dashState.checkins) dashState.checkins = { morning: {}, evening: {} };
        if (!dashState.checkins.morning) dashState.checkins.morning = {};
        if (!dashState.checkins.evening) dashState.checkins.evening = {};
        if (!dashState.checkinHistory) dashState.checkinHistory = {};

        setTimeout(() => {
            const prefix = type;
            const form = document.getElementById(`${prefix}-form`);
            if (!form) { console.error(`❌ Форма ${prefix}-form не найдена!`); return; }
            
            // Инициализация шкал 1-10
            const scaleContainers = form.querySelectorAll('.scale-container');
            scaleContainers.forEach((container) => {
                const key = container.dataset.key;
                if (!key) return;
                const checkinsData = dashState.checkins[prefix] || {};
                const currentVal = checkinsData[key] || 0;
                container.innerHTML = '';
                container.className = 'scale-container';
                for (let i = 1; i <= 10; i++) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = `scale-btn ${i === currentVal ? 'active' : ''}`;
                    btn.textContent = i;
                    btn.addEventListener('click', () => {
                        container.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        if (!dashState.checkins[prefix]) dashState.checkins[prefix] = {};
                        dashState.checkins[prefix][key] = i;
                        autoSaveCheckin(prefix);
                        // Юзер попросил: если настроение ниже 4 — семья/друзья узнают об этом
                        // пушем в боте (см. notify-mood-alert). Дедуп «раз в день» — на сервере.
                        if (key === 'mood' && i < 4 && window.notifyMoodAlert) window.notifyMoodAlert(i);
                    });
                    container.appendChild(btn);
                }
            });

            // Инициализация горизонтальных пикеров времени (лёг/встал)
            form.querySelectorAll('.time-scroll-container').forEach((container) => {
                const key = container.dataset.key;
                if (!key) return;
                const checkinsData = dashState.checkins[prefix] || {};
                renderTimeScroll(container, checkinsData[key] || '', (label) => {
                    if (!dashState.checkins[prefix]) dashState.checkins[prefix] = {};
                    dashState.checkins[prefix][key] = label;
                    autoSaveCheckin(prefix);
                });
            });

            // Инициализация полей ввода
            const inputs = form.querySelectorAll('.checkin-time, .checkin-text');
            inputs.forEach(input => {
                const key = input.dataset.key;
                if (!key) return;
                const checkinsData = dashState.checkins[prefix] || {};
                input.value = checkinsData[key] || '';
                const newInput = input.cloneNode(true);
                input.parentNode.replaceChild(newInput, input);
                newInput.addEventListener('input', (e) => {
                    if (!dashState.checkins[prefix]) dashState.checkins[prefix] = {};
                    dashState.checkins[prefix][key] = e.target.value;
                    autoSaveCheckin(prefix);
                });
                // Кнопка «Готово»/«Done» на мобильной клавиатуре — скрываем клавиатуру, значение уже
                // сохранено по input выше (автосохранение чек-апа, см. autoSaveCheckin).
                newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); newInput.blur(); } });
            });

            updateSavedStatus(prefix);
            updateDateLabel(type, null);
        }, 150);
    }

    // Автосохранение чек-апа — вызывается после КАЖДОГО взаимодействия (шкала/пикер времени/текст),
    // заменяет собой бывшую кнопку «Сохранить чек-ап» (юзер попросил убрать явное сохранение).
    // Коммитит черновик dashState.checkins[type] в постоянную dashState.checkinHistory[сегодня][type]
    // и начисляет +3 XP один раз за день (та же защита от фарма, что была у ручного сохранения).
    function autoSaveCheckin(type) {
        const today = new Date().toISOString().split('T')[0];
        if (!dashState.checkinHistory) dashState.checkinHistory = {};
        if (!dashState.checkinHistory[today]) dashState.checkinHistory[today] = {};

        const checkinData = JSON.parse(JSON.stringify(dashState.checkins[type] || {}));
        if (Object.keys(checkinData).length === 0) return;

        const wasAlreadySaved = !!dashState.checkinHistory[today][type];
        dashState.checkinHistory[today][type] = { ...checkinData, savedAt: new Date().toISOString() };

        if (!wasAlreadySaved) { dashState.currentXP += 3; updateProgressUI(); }

        saveProgress();
        updateSavedStatus(type);
        updateCheckinButtonPulse();
    }

    function updateSavedStatus(type) {
        const status = document.getElementById(`status-${type}`);
        if (!status || currentHistoryType === type) return;
        const today = new Date().toISOString().split('T')[0];
        const saved = dashState.checkinHistory[today]?.[type];
        status.textContent = saved ? 'Сохранено' : '';
        status.classList.toggle('show', !!saved);
    }

    // === ТАЙМЕР ===
    function startDayTimer() {
        const timerEl = document.getElementById('reset-timer');
        if (!timerEl) return;
        if (timerInterval) clearInterval(timerInterval);
        function update() {
            const now = new Date();
            const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            const diff = tomorrow - now;
            if (diff <= 0) { location.reload(); return; }
            const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            timerEl.textContent = `до обновления: ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        update();
        timerInterval = setInterval(update, 1000);
    }

    // === НАПОМИНАНИЯ ===
    function startReminderChecker() {
        if (reminderInterval) clearInterval(reminderInterval);
        checkReminders();
        reminderInterval = setInterval(checkReminders, 30000);
    }
    function checkReminders() {
        // В режиме просмотра члена семьи (Фаза 19) dashState — чужой: без этой проверки интервал
        // startReminderChecker раз в 30с показывал бы тосты «Время действовать» по ЕГО
        // напоминаниям и пищал бы мне. Интервал не гасим — просто пропускаем тик.
        if (familyView) return;
        if (!dashState.habits) return;
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const tKey = todayKey();
        dashState.habits.forEach(habit => {
            if (habit.reminderTime !== currentTime) return;
            // Разовая задача привязана к своему дню — в остальные дни не напоминаем (та же правка,
            // что и в supabase/functions/send-habit-reminders: раньше срабатывало ежедневно).
            if (habit.type === 'oneTime' && habit.date !== tKey) return;
            // Отметка о выполнении живёт в history[дата][uid] (см. isDone/toggleHabitForDate);
            // habit.completed — рудимент старой модели, он давно никем не проставляется, поэтому
            // условие `!habit.completed` было всегда истинным и тост прилетал даже по выполненной.
            if (isDone(habit.uid, tKey)) return;
            showReminderToast(habit); playReminderSound();
        });
    }
    function showReminderToast(habit) {
        document.querySelectorAll('.reminder-toast').forEach(t => t.remove());
        const toast = document.createElement('div'); toast.className = 'reminder-toast';
        toast.innerHTML = `<span class="toast-icon">🔔</span><div><strong>Время действовать</strong><p>${esc(habit.text)}</p>${habit.triggerText ? `<small>Привязка: ${esc(habit.triggerText)}</small>` : ''}</div><button class="toast-close">✕</button>`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        const closeBtn = toast.querySelector('.toast-close');
        closeBtn.addEventListener('click', () => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); });
        setTimeout(() => { if (document.body.contains(toast)) { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); } }, 6000);
    }
    function playReminderSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine'; osc.frequency.setValueAtTime(880, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.08, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(); osc.stop(ctx.currentTime + 0.4);
        } catch (e) {}
    }

    // === НАЧИСЛЕНИЕ XP (единая точка: уровень + разблокировка игр) ===
    function awardXP(amount) {
        dashState.currentXP += amount;
        const stats = getLevelStats(dashState.level);
        if (dashState.currentXP >= stats.xpNeeded) {
            dashState.level++; dashState.currentXP = 0;
            pulseLevel();
            updateProgressUI(); saveProgress();
            checkGameUnlock(); // выбор новой игры на ур. 3 / 7
        } else {
            updateProgressUI(); saveProgress();
        }
    }
    window.awardXP = awardXP;

    // === ИГРЫ: ЛИЧНЫЕ РЕКОРДЫ (вместо XP за игру — юзер попросил не копить историю, а просто
    // хранить лучший результат: время — там, где играют «на скорость» (память/судоку), количество
    // верных ответов — там, где играют на фиксированное время (посчитай/слова)). ===
    function fmtGameTime(ms) {
        const s = ms / 1000;
        if (s < 60) return `${s.toFixed(1)} с`;
        const m = Math.floor(s / 60);
        return `${m}:${String(Math.round(s - m * 60)).padStart(2, '0')}`;
    }
    // higherIsBetter=false — время (меньше=лучше), true — количество верных ответов (больше=лучше).
    // Возвращает { best, isNew } — best актуален уже ПОСЛЕ сравнения (сохранён, если побит).
    function updateGameRecord(game, key, value, higherIsBetter) {
        if (!dashState.gameRecords) dashState.gameRecords = {};
        if (!dashState.gameRecords[game]) dashState.gameRecords[game] = {};
        const rec = dashState.gameRecords[game];
        const prev = rec[key];
        const isNew = prev == null || (higherIsBetter ? value > prev : value < prev);
        if (isNew) { rec[key] = value; saveProgress(); }
        return { best: isNew ? value : prev, isNew };
    }
    // Единая разметка бейджа результата — переиспользует стиль .training-xp-badge (раньше был
    // «+N XP»), просто теперь это рекорд.
    function gameRecordBadgeHtml(text, isNew) {
        return `<div class="training-xp-badge">${text}${isNew ? '<span class="training-record-new"> · новый рекорд!</span>' : ''}</div>`;
    }

    // === ИГРЫ: МЕНЮ ===
    function initTrainingMenu() {
        const container = document.getElementById('training-games-container');
        if (!container) return;
        // #view-training сейчас недостижим из таб-бара вообще (родная кнопка «Игры» скрыта
        // FEATURES.games=false, а Pro mode больше не имеет своего входа в игры, см. HANDOFF.md
        // §43) — код/данные не удаляем, только прячем UI, как и с остальными фиче-флагами.
        // allUnlocked оставлен на случай возврата фичи: доступ и так был бы за платной подпиской,
        // левел-гейт был бы не нужен.
        const allUnlocked = dashState.psychoMode;
        if (!allUnlocked) checkGameUnlock(); // если есть невыбранная разблокировка — предложить выбор
        const cards = GAME_ORDER.map(g => {
            const unlocked = allUnlocked || dashState.unlockedGames.includes(g);
            const meta = GAME_RECORD_META[g];
            const recVal = unlocked ? ((dashState.gameRecords || {})[g] || {})[meta.key] : null;
            return `<div class="training-card${unlocked ? '' : ' locked'}" data-game="${unlocked ? g : ''}">
                <span class="training-name">${GAMES[g].name}</span>
                <span class="training-desc">${unlocked ? GAMES[g].desc : 'Откроется с уровнем'}</span>
                ${recVal != null ? `<span class="training-record">рекорд: ${meta.fmt(recVal)}</span>` : ''}
                ${unlocked ? '' : `<span class="training-lock">${LOCK}</span>`}
            </div>`;
        }).join('');
        let hint = '';
        if (!allUnlocked) {
            const remaining = UNLOCK_LEVELS.filter(l => dashState.level < l).slice(0, lockedGames().length);
            const remainingStr = remaining.length > 1 ? remaining.slice(0, -1).join(', ') + ' и ' + remaining.slice(-1) : remaining[0];
            hint = remaining.length ? `<div class="training-hint">Новые игры открываются на ур. ${remainingStr}</div>` : '';
        }
        container.innerHTML = `<div class="training-menu">${cards}</div>${hint}`;
        container.querySelectorAll('.training-card:not(.locked)').forEach(card => {
            card.addEventListener('click', () => startTrainingGame(card.dataset.game));
        });
    }

    function startTrainingGame(gameName) {
        const container = document.getElementById('training-games-container');
        if (!container) return;
        currentTrainingGame = gameName;
        stopTrainingGame();
        switch (gameName) {
            case 'count': renderCountGame(container); break;
            case 'words': renderWordsGame(container); break;
            case 'sudoku': renderSudokuGame(container); break;
        }
    }

    // === ИГРА: БЫСТРОЕ СУДОКУ (1 пропуск в каждом квадрате 3×3) ===
    function renderSudokuGame(container) {
        // 1) генерируем валидное решение 9×9 перестановками базового шаблона
        const b = 3, side = 9, rb = [0, 1, 2];
        const sh = a => a.slice().sort(() => Math.random() - 0.5);
        const pat = (r, c) => (b * (r % b) + Math.floor(r / b) + c) % side;
        const rows = [].concat(...sh(rb).map(g => sh(rb).map(r => g * b + r)));
        const cols = [].concat(...sh(rb).map(g => sh(rb).map(c => g * b + c)));
        const nums = sh([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const solution = rows.map(r => cols.map(c => nums[pat(r, c)]));

        // 2) в каждом из 9 квадратов 3×3 убираем ровно одну клетку
        const blanks = {}; // "r-c" -> правильное значение
        for (let br = 0; br < 3; br++) for (let bc = 0; bc < 3; bc++) {
            const rr = br * 3 + Math.floor(Math.random() * 3);
            const cc = bc * 3 + Math.floor(Math.random() * 3);
            blanks[`${rr}-${cc}`] = solution[rr][cc];
        }

        let cells = '';
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
            const edgeR = (r % 3 === 0 && r !== 0) ? ' br-top' : '';
            const edgeC = (c % 3 === 0 && c !== 0) ? ' br-left' : '';
            if (blanks[`${r}-${c}`] !== undefined) {
                cells += `<input class="sudoku-cell blank${edgeR}${edgeC}" inputmode="numeric" enterkeyhint="done" maxlength="1" data-key="${r}-${c}">`;
            } else {
                cells += `<div class="sudoku-cell given${edgeR}${edgeC}">${solution[r][c]}</div>`;
            }
        }

        container.innerHTML = `
            <div class="game-setup" style="text-align:center">
                <h3 class="dash-subtitle" style="margin-bottom:4px">Быстрое судоку</h3>
                <p class="training-desc" style="margin-bottom:14px">Заполни по одной пустой клетке в каждом квадрате</p>
                <div class="game-timer" id="sudoku-timer">0.0 с</div>
                <div id="sudoku-grid">${cells}</div>
                <button class="training-btn primary" id="sudoku-check" style="margin-top:16px">Проверить</button>
            </div>
            <button class="training-back-btn" id="training-back">← Назад</button>`;

        // Рекорд тут — время до верного решения (см. HANDOFF), тикающий таймер живой на экране.
        const startedAt = Date.now();
        trainingGameInterval = setInterval(() => {
            document.getElementById('sudoku-timer').textContent = fmtGameTime(Date.now() - startedAt);
        }, 100);

        // ввод только цифр 1-9, авто-переход к следующей пустой клетке
        const inputs = [...container.querySelectorAll('.sudoku-cell.blank')];
        inputs.forEach((inp, i) => {
            inp.addEventListener('input', () => {
                inp.value = inp.value.replace(/[^1-9]/g, '').slice(0, 1);
                inp.classList.remove('wrong', 'right');
                if (inp.value && inputs[i + 1]) inputs[i + 1].focus();
            });
        });

        document.getElementById('sudoku-check').onclick = () => {
            let correct = 0, filled = 0;
            inputs.forEach(inp => {
                const ok = +inp.value === blanks[inp.dataset.key];
                if (inp.value) filled++;
                inp.classList.toggle('right', ok);
                inp.classList.toggle('wrong', !!inp.value && !ok);
                if (ok) correct++;
            });
            if (correct < 9) return; // не всё верно — даём дорешать
            clearInterval(trainingGameInterval);
            const elapsedMs = Date.now() - startedAt;
            const { best, isNew } = updateGameRecord('sudoku', 'bestTimeMs', elapsedMs, false);
            container.innerHTML = `<div class="training-result"><div class="training-result-title">Решено!</div><div class="training-result-message">Все 9 клеток верны за ${fmtGameTime(elapsedMs)}</div>${gameRecordBadgeHtml(`Рекорд: ${fmtGameTime(best)}`, isNew)}<div class="training-result-buttons"><button class="training-btn primary" id="retry-sudoku">Ещё раз</button><button class="training-btn secondary" id="menu-sudoku">В меню</button></div><button class="training-back-btn" id="back-sudoku">← Назад</button></div>`;
            document.getElementById('retry-sudoku').onclick = () => renderSudokuGame(container);
            document.getElementById('menu-sudoku').onclick = () => initTrainingMenu();
            document.getElementById('back-sudoku').onclick = () => initTrainingMenu();
        };
        document.getElementById('training-back').onclick = () => initTrainingMenu();
    }

    function stopTrainingGame() {
        if (trainingGameInterval) { clearInterval(trainingGameInterval); trainingGameInterval = null; }
    }

    function renderCountGame(container) {
        container.innerHTML = `
            <div class="game-setup" id="count-setup"><h3 style="margin-bottom:15px">Выбери сложность</h3><button class="difficulty-btn" data-diff="1">1-9</button><button class="difficulty-btn" data-diff="2">10-99</button><button class="difficulty-btn" data-diff="3">100-999</button></div>
            <div class="game-area" id="count-area" style="display:none"><div class="game-timer" id="count-timer">60</div><div class="game-equation" id="count-equation"></div><input type="text" class="game-input" id="count-input" inputmode="numeric" enterkeyhint="done" placeholder="?" autocomplete="off"></div>
            <button class="training-back-btn" id="training-back">← Назад</button>`;
        let difficulty = 1, timer = 60, correct = 0, total = 0, currentEq = null;
        function getRandom(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        function generate() {
            const ranges = { 1: [1, 9], 2: [10, 99], 3: [100, 999] };
            const [min, max] = ranges[difficulty];
            let a = getRandom(min, max), b = getRandom(min, max), op = Math.random() > 0.5 ? '+' : '-';
            if (op === '-' && a < b) [a, b] = [b, a];
            return { a, b, op, result: op === '+' ? a + b : a - b };
        }
        function showEq() {
            currentEq = generate();
            document.getElementById('count-equation').textContent = `${currentEq.a} ${currentEq.op} ${currentEq.b} =`;
            const input = document.getElementById('count-input'); input.value = ''; input.focus();
        }
        function start(diff) {
            difficulty = diff; timer = 60; correct = 0; total = 0;
            document.getElementById('count-setup').style.display = 'none';
            document.getElementById('count-area').style.display = 'block';
            document.getElementById('count-timer').textContent = timer;
            showEq();
            trainingGameInterval = setInterval(() => { timer--; document.getElementById('count-timer').textContent = timer; if (timer <= 0) endGame(); }, 1000);
        }
        function endGame() {
            clearInterval(trainingGameInterval);
            const { best, isNew } = updateGameRecord('count', 'bestCorrect', correct, true);
            container.innerHTML = `<div class="training-result"><div class="training-result-title">Результат</div><div class="training-result-message">Правильных ответов: ${correct} из ${total}</div>${gameRecordBadgeHtml(`Рекорд: ${best}`, isNew)}<div class="training-result-buttons"><button class="training-btn primary" id="retry-count">Ещё раз</button><button class="training-btn secondary" id="menu-count">В меню</button></div><button class="training-back-btn" id="back-count">← Назад</button></div>`;
            document.getElementById('retry-count').onclick = () => renderCountGame(container);
            document.getElementById('menu-count').onclick = () => initTrainingMenu();
            document.getElementById('back-count').onclick = () => initTrainingMenu();
        }
        document.querySelectorAll('#count-setup .difficulty-btn').forEach(btn => btn.addEventListener('click', (e) => start(parseInt(e.target.dataset.diff))));
        // type="text" (не "number") — только так iOS показывает Enter на цифровой раскладке (см.
        // HANDOFF.md), поэтому сами фильтруем нецифровые символы вместо валидации браузером.
        document.getElementById('count-input')?.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, ''); });
        document.getElementById('count-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && currentEq) {
                e.preventDefault();
                const ans = parseInt(e.target.value);
                if (!isNaN(ans)) {
                    total++; const isCorrect = (ans === currentEq.result);
                    if (isCorrect) correct++;
                    // Подсвечиваем только само поле ввода (юзер попросил — раньше красился весь
                    // #count-area целиком). filter:invert(1) на самом элементе отменяет инверсию
                    // Pro mode (игры теперь живут только там, см. HANDOFF.md §34/36) — без него
                    // зелёный/красный визуально менялись местами под общим invert(1) дашборда.
                    e.target.style.backgroundColor = isCorrect ? '#c8e6c9' : '#ffcdd2';
                    e.target.style.filter = 'invert(1)';
                    setTimeout(() => { e.target.style.backgroundColor = ''; e.target.style.filter = ''; }, 250);
                    showEq();
                }
            }
        });
        document.getElementById('training-back').onclick = () => initTrainingMenu();
        start(1);
    }

    function renderWordsGame(container) {
        const allWords = ["яблоко", "машина", "дом", "книга", "ручка", "солнце", "вода", "дерево", "окно", "стул", "стол", "кошка", "собака", "цветок", "птица", "небо", "облако", "лес", "озеро", "река", "камень", "песок", "море", "снег", "дождь", "ветер", "луна", "звезда", "свет", "тень", "путь", "дверь", "замок", "ключ", "часы", "телефон", "ноутбук", "клавиатура", "мышь", "экран", "зеркало", "картина", "стена", "крыша", "крыло", "хвост", "лапа", "нос", "глаз", "рот", "ухо", "волос", "кожа", "платье", "рубашка", "ботинок", "сапог", "шляпа", "очки", "сумка", "портфель", "карандаш", "тетрадь", "доска", "мел", "сцена", "актер", "роль", "театр", "музыка", "песня", "танец", "праздник", "рождение", "день", "ночь", "сон", "мысль", "чувство", "ум", "сердце", "рука", "нога", "голова", "тело", "жизнь", "смерть", "время", "история", "мир", "война", "дружба", "любовь", "ненависть", "радость", "печаль", "страх", "надежда", "вера"];
        const WORDS_COUNT = 10; // «10 слов» — юзер указал, что должно быть именно 10, а не 8
        let targetWords = [], entered = [], memorizeTime = 15, guessTime = 45, phase = 'memorize';
        container.innerHTML = `<div class="game-timer" id="words-timer">${memorizeTime}</div><div id="words-display" style="margin:15px 0;font-size:16px"></div><div id="words-input-area" style="display:none"><input type="text" class="game-input" id="words-input" enterkeyhint="done" autocomplete="off" placeholder="Введи слово и нажми Enter" style="width:200px;margin:10px auto"><div class="word-placeholders" id="words-placeholders"></div></div><button class="training-back-btn" id="training-back">← Назад</button>`;
        function getRandomWords(n) { return [...allWords].sort(() => Math.random() - 0.5).slice(0, n); }
        function setupPlaceholders() {
            const c = document.getElementById('words-placeholders'); c.innerHTML = '';
            targetWords.forEach((_, i) => { const ph = document.createElement('div'); ph.className = 'word-placeholder'; ph.id = `ph-${i}`; c.appendChild(ph); });
        }
        function start() {
            targetWords = getRandomWords(WORDS_COUNT); entered = []; phase = 'memorize'; memorizeTime = 15;
            document.getElementById('words-display').textContent = targetWords.join(', ');
            document.getElementById('words-input-area').style.display = 'none';
            document.getElementById('words-timer').textContent = memorizeTime; setupPlaceholders();
            trainingGameInterval = setInterval(() => {
                if (phase === 'memorize') { memorizeTime--; document.getElementById('words-timer').textContent = memorizeTime; if (memorizeTime <= 0) { phase = 'guess'; guessTime = 45; document.getElementById('words-display').style.visibility = 'hidden'; document.getElementById('words-input-area').style.display = 'block'; document.getElementById('words-input').focus(); document.getElementById('words-timer').textContent = guessTime; } }
                else { guessTime--; document.getElementById('words-timer').textContent = guessTime; if (guessTime <= 0) endGame(); }
            }, 1000);
        }
        function endGame() {
            clearInterval(trainingGameInterval);
            const correct = targetWords.filter(w => entered.includes(w)).length;
            const { best, isNew } = updateGameRecord('words', 'bestCorrect', correct, true);
            container.innerHTML = `<div class="training-result"><div class="training-result-title">Результат</div><div class="training-result-message">Угадано слов: ${correct} из ${WORDS_COUNT}</div>${gameRecordBadgeHtml(`Рекорд: ${best}`, isNew)}<div class="training-result-buttons"><button class="training-btn primary" id="retry-words">Ещё раз</button><button class="training-btn secondary" id="menu-words">В меню</button></div><button class="training-back-btn" id="back-words">← Назад</button></div>`;
            document.getElementById('retry-words').onclick = () => renderWordsGame(container);
            document.getElementById('menu-words').onclick = () => initTrainingMenu();
            document.getElementById('back-words').onclick = () => initTrainingMenu();
        }
        document.getElementById('words-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && phase === 'guess') {
                e.preventDefault();
                const word = e.target.value.trim().toLowerCase(); e.target.value = '';
                if (word && !entered.includes(word)) {
                    entered.push(word);
                    const idx = targetWords.indexOf(word);
                    if (idx >= 0) { const ph = document.getElementById(`ph-${idx}`); if (ph) { ph.classList.add('filled'); ph.textContent = word; } }
                    if (targetWords.every(w => entered.includes(w))) endGame();
                }
            }
        });
        document.getElementById('training-back').onclick = () => initTrainingMenu();
        start();
    }

    // =========================================
    // 📅 ЛОГИКА ИСТОРИИ И 📊 АНАЛИТИКИ
    // =========================================

    function initHistoryLogic() {
        if (isHistoryInitialized) return;
        isHistoryInitialized = true;
    
        ['morning', 'evening'].forEach(type => {
            const btn = document.getElementById(`history-btn-${type}`);
            const dateInput = document.getElementById(`date-input-${type}`);
            
            if (!btn || !dateInput) return;
    
            // Календарь
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                if (currentHistoryType === type) {
                    loadTodayData(type);
                    btn.classList.remove('active');
                    currentHistoryType = null;
                } else {
                    // кастомный календарь → пишем выбранную дату в hidden-инпут и дёргаем его change
                    openCalendar({
                        value: currentHistoryDate,
                        onPick: (dateStr) => {
                            const di = document.getElementById(`date-input-${type}`);
                            if (di) { di.value = dateStr; di.dispatchEvent(new Event('change')); }
                        }
                    });
                }
            });
    
            // Выбор даты
            dateInput.addEventListener('change', (e) => {
                const date = e.target.value;
                if (!date) return;
                currentHistoryType = type;
                currentHistoryDate = date;
                btn.classList.add('active');
                loadHistoryData(type, date);
            });
        });
    }

    // Сегодняшняя форма больше никогда не блокируется (нет кнопки «Сохранить» — см. autoSaveCheckin
    // выше) — просто перерисовываем её интерактивной поверх черновика dashState.checkins[type].
    function loadTodayData(type) {
        const form = document.getElementById(`${type}-form`);
        if (form) form.classList.remove('history-mode');

        const dateInput = document.getElementById(`date-input-${type}`);
        if (dateInput) dateInput.value = '';

        initCheckins(type);

        const backBtn = document.getElementById('back-to-today-btn');
        if (backBtn) backBtn.remove();
    }

    // Коммитит правку прошлого дня прямо в dashState.checkinHistory[date][type] — в отличие от
    // autoSaveCheckin (которая всегда пишет в new Date(), т.е. только «сегодня»), здесь дата
    // фиксированная, взятая из календаря (см. loadHistoryData). XP за прошлые дни не начисляем —
    // тот +3 уже был выдан (или не был, если юзер тогда пропустил чек-ап) в свой день.
    function saveHistoryCheckin(type, date, key, value) {
        if (!dashState.checkinHistory) dashState.checkinHistory = {};
        if (!dashState.checkinHistory[date]) dashState.checkinHistory[date] = {};
        if (!dashState.checkinHistory[date][type]) dashState.checkinHistory[date][type] = {};
        dashState.checkinHistory[date][type][key] = value;
        dashState.checkinHistory[date][type].savedAt = new Date().toISOString();
        saveProgress();
        const status = document.getElementById(`status-${type}`);
        if (status) { status.textContent = 'Сохранено'; status.classList.add('show'); }
    }

    // Просмотр И редактирование прошлого дня — юзер попросил возможность поправить данные задним
    // числом (раньше форма была жёстко заблокирована disabled+pointer-events:none, см. HANDOFF.md).
    // Формы для дней без данных тоже открываются пустыми — можно заполнить чек-ап задним числом,
    // а не только смотреть уже существующий.
    function loadHistoryData(type, date) {
        if (!dashState.checkinHistory) dashState.checkinHistory = {};
        const data = dashState.checkinHistory[date]?.[type] || {};

        const form = document.getElementById(`${type}-form`);
        form.classList.remove('history-mode'); // теперь интерактивно, не только просмотр

        // Шкалы 1-10 — как в initCheckins, но пишут через saveHistoryCheckin в фиксированную дату
        form.querySelectorAll('.scale-container').forEach(container => {
            const key = container.dataset.key;
            if (!key) return;
            const val = data[key] || 0;
            container.innerHTML = '';
            container.className = 'scale-container';
            for (let i = 1; i <= 10; i++) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `scale-btn ${i === val ? 'active' : ''}`;
                btn.textContent = i;
                btn.addEventListener('click', () => {
                    container.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    saveHistoryCheckin(type, date, key, i);
                });
                container.appendChild(btn);
            }
        });
        form.querySelectorAll('.time-scroll-container').forEach(container => {
            const key = container.dataset.key;
            if (!key) return;
            renderTimeScroll(container, data[key] || '', (label) => saveHistoryCheckin(type, date, key, label));
        });

        // Инпуты — снимаем блокировку и вешаем автосохранение на конкретную дату
        form.querySelectorAll('input').forEach(input => {
            const key = input.dataset.key;
            if (!key) return;
            input.disabled = false;
            input.readOnly = false;
            const newInput = input.cloneNode(true);
            newInput.value = data[key] || '';
            input.parentNode.replaceChild(newInput, input);
            newInput.addEventListener('input', (e) => saveHistoryCheckin(type, date, key, e.target.value));
            newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); newInput.blur(); } });
        });

        updateDateLabel(type, date);

        // Кнопка возврата
        const oldBackBtn = document.getElementById('back-to-today-btn');
        if (oldBackBtn) oldBackBtn.remove();

        const backBtn = document.createElement('button');
        backBtn.className = 'checkin-save-btn';
        backBtn.id = 'back-to-today-btn';
        backBtn.innerHTML = '← Вернуться к сегодня';
        backBtn.onclick = () => loadTodayData(type);
        const wrapper = form.querySelector('.checkin-save-wrapper');
        if (wrapper) wrapper.appendChild(backBtn);
    }
    // === ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ===
    window.dashState = dashState;
    window.saveProgress = saveProgress;
    window.updateProgressUI = updateProgressUI;
    window.getLevelStats = getLevelStats;

    // =========================================
    //   ПРОСМОТР ЭКРАНА ЧЛЕНА СЕМЬИ (Фаза 19) — ТОЛЬКО ЧТЕНИЕ
    // =========================================
    // Юзер попросил: «в блоке семьи можно будет нажать "посмотреть" и открыть экран приложения
    // члена семьи полностью, просто без возможности редактирования».
    //
    // МЕХАНИКА. Подменяем ЗАМЫКАНИЕВУЮ переменную dashState чужим состоянием (его отдаёт
    // SECURITY DEFINER RPC get_family_state — см. db/phase19_family_share_access.sql и auth.js
    // openFamilyMemberState). Все рендеры (renderMonthView / renderTaskDayView / renderPsychoDay /
    // renderPsychoMonth / initCheckins / renderCheckupCharts / renderFood / renderPet) читают
    // dashState через это же замыкание, поэтому одной подмены хватает, чтобы ВЕСЬ дашборд показал
    // чужие данные. Второй набор рендеров или iframe тут были бы дороже и разъезжались бы с
    // основным кодом при каждой правке (плюс iframe отдельно тянет весь Supabase-клиент и вторую
    // сессию).
    //
    // ЧТО ГАРАНТИРУЕТ, ЧТО ЧУЖИЕ ДАННЫЕ НЕ УЕДУТ В МОЙ АККАУНТ (главный риск фичи):
    //  1. saveProgress() — жёсткий no-op, пока familyView != null. Это ЕДИНСТВЕННАЯ точка записи
    //     в приложении: и localStorage, и облако (window.syncStats/window.syncAppState из auth.js)
    //     дёргаются только из неё. Значит ни один из её вызовов ничего не запишет.
    //  2. Своё состояние НЕ копируем: familyView.ownState держит ТОТ ЖЕ объект, что лежал в
    //     dashState до входа. Чужие рендеры мутируют только новый объект, мой остаётся байт-в-байт
    //     тем же — на выходе просто возвращаем ссылку назад, ничего не пересобирая.
    //  3. window.dashState продолжает указывать на МОЁ состояние — его читает auth.js loadAppState
    //     (`syncAppState(window.dashState)`, когда в облаке пусто).
    //  4. Реалтайм (auth.js subscribeAppStateRealtime) не отписываем — вместо этого откладываем
    //     applyCloudState до выхода (pendingCloudState выше). Отписка/переподписка рискует
    //     пропустить событие и молча разъехаться с другим устройством.
    //  5. auth.js syncMyStats() сам выходит при window.familyViewMode: он читает ЖИВОЙ
    //     window.getSummary() (то есть текущий dashState), и уже заведённый ДО входа дебаунс-
    //     таймер (1.5с), сработав внутри режима, записал бы в МОЮ строку stats чужую серию,
    //     процент недели и настроение — их видит вся моя семья.
    //     pushAppState специально НЕ гасим: он пушит объект, ЗАХВАЧЕННЫЙ в момент планирования,
    //     то есть всегда моё состояние (нового пуша в режиме просмотра не заводится — см. п.1),
    //     а глушение потеряло бы честное сохранение, сделанное за секунду до нажатия «Посмотреть».
    //
    // ПОБОЧКИ, КОТОРЫЕ ГАСЯТСЯ ОТДЕЛЬНО (каждая — свой ранний return, см. по коду выше):
    //   checkReminders() — тосты/звук по чужим напоминаниям раз в 30с;
    //   maybeShowViewHint() — подсказки онбординга + падение на отсутствующем seenHints;
    //   window.exitPsychoModeIfUnsubscribed() — сброс чужого Pro mode по моей подписке;
    //   пейволл в обработчике .view-btn — предложение мне купить подписку за чужие данные.
    //   XP/уровни (awardXP) отдельно гасить не нужно: FEATURES.xpLevels уже прячет .dash-level/
    //   .dash-footer, а сама мутация уходит в выбрасываемый при выходе объект.

    // Кнопки таб-бара, которые вообще могут быть показаны в режиме просмотра, и категория, которой
    // член семьи должен был поделиться. Ключи категорий — те же, что у family_allowed_keys() в SQL
    // и FAMILY_SHARE_CATS в auth.js: один словарь на три места. Категория не расшарена → кнопки
    // нет совсем (юзер просил прятать раздел, а не показывать пустой экран). Порядок = приоритет:
    // первая доступная вкладка и открывается при входе.
    // «Питомец» привязан к habits: его состояние считается из привычек и истории их выполнения.
    // «День», «Вечер» и «Игры» в режиме просмотра не показываем никогда: первые две скрыты
    // фиче-флагами и в обычной работе, игры — личная механика без чужих данных.
    const FAMILY_VIEW_TABS = [
        { sel: '#btn-tasks',     view: 'month',   cat: 'habits',  pro: false },
        { sel: '#btn-tasks-pro', view: 'month',   cat: 'metrics', pro: true  },
        { sel: '#btn-morning',   view: 'morning', cat: 'checkin', pro: false },
        { sel: '#btn-food',      view: 'food',    cat: 'food',    pro: false },
        { sel: '#btn-food-pro',  view: 'food',    cat: 'food',    pro: true  },
        { sel: '.view-btn[data-view="pet"]', view: 'pet', cat: 'habits', pro: false },
    ];

    // Что внутри #dashboard-screen ОСТАЁТСЯ кликабельным в режиме просмотра. Юзер должен свободно
    // листать дни/месяцы и вкладки чужого экрана — запрещено только менять данные. Единственное
    // место, где это решается; добавляя новую навигацию, дописывать сюда.
    const FAMILY_VIEW_ALLOWED = [
        '#top-nav-slot',         // стрелки дня/месяца и календарь в шапке
        '.view-switcher',        // таб-бар — это навигация, не редактирование
        '.dm-toggle',            // переключатель «День»/«Месяц» внутри «Задач» (обычный и Pro)
        '.chart-month-nav',      // навигация по месяцам над графиками чек-апа (chartHeaderHtml)
        '.chart-scroll',         // горизонтальный скролл графиков — перехватывать нельзя
        '#history-btn-morning',  // календарь истории чек-апа: открывает прошлый день на чтение
        '#history-btn-food',     // то же для «Питания» (см. isPro в renderFood)
        '#date-input-morning',   // скрытые инпуты дат: openCalendar пишет туда и шлёт change,
        '#date-input-evening',   // без них история чек-апа не откроется (см. initHistoryLogic)
    ].join(',');

    // НАСТОЯЩАЯ блокировка редактирования. Перехват в ФАЗЕ ПОГРУЖЕНИЯ на document — событие не
    // доходит вообще ни до одного обработчика приложения, включая назначенные через свойство
    // (.onclick у heatmap и стрелок месяца) и pointerdown драга задач (wireRowDrag). Одного CSS с
    // pointer-events для этого мало: половина кликабельных элементов — обычные div (.hm-row,
    // .task-day-row, .dash-habit-row), белый список в CSS протухал бы при каждой правке.
    // Плашка «Вернуться к себе» лежит ВНЕ #dashboard-screen (см. index.html), поэтому в
    // FAMILY_VIEW_ALLOWED её нет — она отсекается проверкой closest('#dashboard-screen') ниже.
    function familyViewEventGuard(e) {
        if (!familyView) return;
        const t = e.target;
        if (!(t instanceof Element)) return;
        // .cal-overlay (openCalendar/openMonthPicker) и модалки живут в body, а не в дашборде —
        // их не трогаем: они и так только читают и перерисовывают.
        if (!t.closest('#dashboard-screen')) return;
        if (t.closest(FAMILY_VIEW_ALLOWED)) return;
        e.stopPropagation();
        // preventDefault зовём только на click/mousedown — на pointerdown он в части мобильных
        // WebView рубит заодно и обычный скролл пальцем, а листать чужой экран надо.
        if (e.type === 'click' || e.type === 'mousedown') e.preventDefault();
        if (e.type === 'focusin' && typeof t.blur === 'function') t.blur();
    }
    ['pointerdown', 'mousedown', 'click', 'dblclick', 'focusin', 'input', 'change', 'keydown']
        .forEach(type => document.addEventListener(type, familyViewEventGuard, true));

    // Чужое состояние приходит ОТФИЛЬТРОВАННЫМ (get_family_state вырезает нерасшаренные
    // категории), поэтому в нём может не быть половины ключей — а рендеры это не всегда проверяют
    // (renderPsychoMonth читает dashState.metricLog[...] без гарда, maybeShowViewHint —
    // dashState.seenHints[view]). Прогоняем те же дефолты, что init() проставляет своему сейву,
    // с двумя отличиями: metrics НЕ сидируем из cloneMetrics() (пустой список тут значит
    // «показателями не поделился», дефолтный набор был бы враньём), и seenHints/onboardingDone
    // выставляем так, чтобы онбординг точно не запустился поверх чужих данных.
    function normalizeFamilyState(s) {
        if (!Array.isArray(s.habits)) s.habits = [];
        if (!s.checkinHistory) s.checkinHistory = {};
        // dashState.checkins — ЧЕРНОВИК текущего дня, и get_family_state его сознательно не
        // отдаёт (см. коммент в миграции): семье нужен зафиксированный лог, а не черновик.
        // Но initCheckins рисует форму «Чек-ап дня» ИСКЛЮЧИТЕЛЬНО из checkins[prefix] — с пустым
        // черновиком все шкалы выглядели незаполненными, хотя графики строчкой ниже читают
        // checkinHistory и УЖЕ показывают сегодняшнюю точку. Получался экран, который сам себе
        // противоречит: «сегодня чек-ап не заполняла» и её же сегодняшнее настроение на графике.
        // Поэтому черновик для чужого состояния собираем из зафиксированного лога за сегодня.
        const fvToday = s.checkinHistory[todayKey()] || {};
        s.checkins = {
            morning: { ...(fvToday.morning || {}) },
            evening: { ...(fvToday.evening || {}) },
        };
        delete s.checkins.morning.savedAt; // служебная метка автосохранения, в форме ей делать нечего
        delete s.checkins.evening.savedAt;
        if (!s.history) s.history = {};
        if (!s.foodLog) s.foodLog = {};
        if (!s.foodMealSlots) s.foodMealSlots = {};
        if (!s.gameRecords) s.gameRecords = {};
        if (!s.calorieLog) s.calorieLog = {};
        if (typeof s.calorieTarget !== 'number') s.calorieTarget = 2000;
        if (!Array.isArray(s.unlockedGames)) s.unlockedGames = [];
        if (!Array.isArray(s.metrics)) s.metrics = [];
        if (!s.metricLog) s.metricLog = {};
        if (!s.metricTargets) s.metricTargets = {};
        if (!s.dayEvents) s.dayEvents = {};
        if (!s.dayTasks) s.dayTasks = {};
        if (typeof s.level !== 'number') s.level = 1;
        if (typeof s.currentXP !== 'number') s.currentXP = 0;
        if (typeof s.psychoMode !== 'boolean') s.psychoMode = false;
        s.onboardingDone = true;
        s.seenHints = {};
        // Привычки без uid уронили бы renderTaskDayView/history — у чужого состояния гарантий
        // меньше, чем у своего (ensureHabitUids чинит только МОЙ сейв, в init()).
        s.habits.forEach((h, i) => {
            if (!h.uid) h.uid = 'fv-' + i;
            if (!Array.isArray(h.areas)) h.areas = [];
        });
        return s;
    }

    // Сброс курсоров навигации: чужой экран должен открыться с сегодняшнего дня/месяца, а не там,
    // где я оставил свой (и наоборот при выходе).
    function resetViewCursors() {
        monthCursor = null;
        checkupChartCursor = null;
        currentFoodHistoryDate = null;
        currentHistoryType = null;
        currentHistoryDate = null;
        // Именно эти два и определяют, какой день откроется ПЕРВЫМ: taskViewMode по умолчанию
        // 'day', и renderMonthView сразу уходит в renderTaskDayView(currentTaskDate). Без сброса
        // чужой экран открывался бы на дате, где я оставил СВОЙ («Смотришь Аня», а в шапке 12
        // августа — выглядит как «она сегодня ничего не делала»), а на выходе дата, до которой я
        // долистал у неё, уезжала бы обратно в мой собственный трекер.
        currentTaskDate = todayKey();
        currentPsychoDate = todayKey();
    }

    // Вход в режим. payload = { name, allowed, state } — ровно то, что отдаёт auth.js
    // openFamilyMemberState по RPC get_family_state. Возвращает false, если показывать нечего —
    // вызывающая сторона сама объясняет это юзеру текстом.
    window.enterFamilyViewMode = function (payload) {
        if (!payload || !payload.state) return false;
        if (familyView) exitFamilyViewMode(true); // из просмотра одного члена семьи сразу в другого
        const allowed = Array.isArray(payload.allowed) ? payload.allowed : [];
        const tabs = FAMILY_VIEW_TABS.filter(t => allowed.indexOf(t.cat) !== -1);
        if (!tabs.length) return false;

        familyView = {
            ownState: dashState,               // ТОТ ЖЕ объект, не копия — см. п.2 в шапке блока
            name: payload.name || 'член семьи',
        };
        window.familyViewMode = true;          // читает auth.js syncMyStats()
        dashState = normalizeFamilyState(payload.state);
        // window.dashState НАМЕРЕННО не подменяем — auth.js loadAppState заливает в облако именно
        // его, туда должно уйти моё состояние, а не чужое.
        // checkNewDay() тут НЕ зовём принципиально: она мутирует состояние (сбрасывает checkins и
        // lastActiveDate) — на чужих данных это просто враньё в UI.
        dashState.psychoMode = !!tabs[0].pro;

        const nameEl = document.getElementById('family-view-banner-name');
        // Две строки, а не одна: имя может быть длинным (до 30 символов, см. #prof-name-input), и
        // единой строкой «Смотришь <имя> — только просмотр» на узком экране хвост про режим
        // просмотра обрезался бы многоточием — то есть пропадала бы ровно самая важная часть.
        // Собираем узлами, а не innerHTML: имя пришло с ЧУЖОГО устройства, и экранировать его тут
        // нечем (escHtml живёт в auth.js, это отдельный модуль). textContent безопасен по определению.
        if (nameEl) {
            nameEl.textContent = 'Смотришь ' + familyView.name;
            const sub = document.createElement('span');
            sub.className = 'family-view-banner-sub';
            sub.textContent = 'только просмотр';
            nameEl.appendChild(document.createElement('br'));
            nameEl.appendChild(sub);
        }
        document.body.classList.add('family-view');
        // psycho-invert переключаем НАПРЯМУЮ, а не через applyPsychoModeState(): та ещё и
        // сохраняет состояние/обновляет мои кнопки. Не «упрощать» обратно.
        dashboardScreen.classList.toggle('psycho-invert', !!dashState.psychoMode);
        // Прячем ВСЕ кнопки таб-бара и возвращаем только разрешённые категорией. Класс, а не
        // style.display: фиче-флаги в начале файла уже прячут часть кнопок инлайн-стилем, и выход
        // из режима не должен их «воскрешать».
        document.querySelectorAll('.view-btn').forEach(b => b.classList.add('fv-hidden'));
        tabs.forEach(t => document.querySelectorAll(t.sel).forEach(b => b.classList.remove('fv-hidden')));

        measureFamilyViewBanner(); // плашка уже с текстом — можно мерить её реальную высоту
        resetViewCursors();
        measureBottomBar(); // состав таб-бара изменился — перемерить резерв под .dash-content
        switchView(tabs[0].view);
        return true;
    };

    // Резерв сверху под плашку: она переносится на две-три строки, если имя длинное, поэтому
    // высоту меряем, а не зашиваем числом (CSS читает её из --family-view-banner-h). Пересчёт на
    // resize — поворот экрана меняет число строк.
    function measureFamilyViewBanner() {
        const banner = document.getElementById('family-view-banner');
        if (!banner) return;
        const h = banner.offsetHeight;
        if (h) document.documentElement.style.setProperty('--family-view-banner-h', (h + 10) + 'px');
    }
    window.addEventListener('resize', () => { if (familyView) measureFamilyViewBanner(); });

    // Выход. silent=true — только служебное восстановление состояния без перерисовки (нужно при
    // переходе «из просмотра одного члена семьи сразу в другого»).
    function exitFamilyViewMode(silent) {
        if (!familyView) return;
        const fv = familyView;
        familyView = null;
        window.familyViewMode = false;
        dashState = fv.ownState;      // та же ссылка, что была до входа — ничего не пересобираем
        window.dashState = dashState;
        document.body.classList.remove('family-view');
        document.querySelectorAll('.view-btn.fv-hidden').forEach(b => b.classList.remove('fv-hidden'));
        dashboardScreen.classList.toggle('psycho-invert', !!dashState.psychoMode);
        if (silent) return;
        // Облачное состояние, отложенное реалтаймом во время просмотра (см. window.applyCloudState):
        // применяем сейчас. Оно само делает location.reload(), дальше рендерить нечего.
        if (pendingCloudState) {
            const p = pendingCloudState;
            pendingCloudState = null;
            window.applyCloudState(p.remoteState, p.remoteUpdatedAt);
            return;
        }
        resetViewCursors();
        measureBottomBar();
        switchView('month');          // возвращаемся на основную вкладку своих данных
        updateProgressUI();
        updateCheckinButtonPulse();
    }
    window.exitFamilyViewMode = exitFamilyViewMode;

    const familyViewExitBtn = document.getElementById('family-view-exit');
    if (familyViewExitBtn) familyViewExitBtn.addEventListener('click', () => exitFamilyViewMode());

    // === КНОПКИ ПЕРЕКЛЮЧЕНИЯ ===
    // data-mode есть только у пар «Задачи»/«Питание» (base + Pro, см. index.html): такая кнопка
    // не тумблит режим, а ЗАДАЁТ его — нажал Pro-вариант, включился Pro mode, нажал обычный,
    // вернулся base. Режим применяем ДО switchView, иначе вкладка отрисуется в старом режиме
    // (ровно этот баг «переключается только со второго клика» был у прежней схемы с двумя
    // слушателями на одной кнопке, см. HANDOFF.md §61). Кнопки без data-mode режим не трогают.
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode) {
                const wantPro = mode === 'pro';
                // Pro-кнопки видны всегда, не только с подпиской (юзер: «в каждой из двух закрытых
                // вкладок показать детали») — без подписки клик открывает превью-пейволл ИМЕННО
                // этой вкладки вместо входа в режим (не общий, а под конкретное содержимое —
                // 'tasks' для «Задачи», 'food' для «Питание», см. openProModePaywall(kind)).
                // В режиме просмотра члена семьи (Фаза 19) Pro-вкладки открываются без пейволла:
                // это ЕГО данные и ЕГО оплаченный режим, гейт подписки тут не про мой доступ. Сам
                // режим всё равно переключается строкой ниже — иначе вкладка отрисуется не тем
                // рендером (renderPsychoDay вместо renderTaskDayView и наоборот).
                if (wantPro && !window.hasActiveSubscription && !familyView) {
                    openProModePaywall(btn.dataset.view === 'food' ? 'food' : 'tasks');
                    return;
                }
                if (wantPro !== !!dashState.psychoMode) applyPsychoModeState(wantPro);
            }
            switchView(btn.dataset.view);
        });
    });

    // === «СОБЫТИЕ ДНЯ» / «ЗАДАЧА ДНЯ» ===
    // Обе модалки открываются для дня, который сейчас пролистан в навигации «День» (см.
    // renderDayNavControls) — не всегда сегодня, dayModalTargetDate ставит вызывающая сторона.
    // onDayFieldsChanged — коллбэк, который renderDayEventAndTask регистрирует, чтобы точечно
    // перерисовать свой блок после автосохранения, без полного ре-рендера всей вкладки.
    let dayModalTargetDate = todayKey();
    let onDayFieldsChanged = null;

    const dayEventModal = document.getElementById('day-event-modal');
    const dayEventInput = document.getElementById('day-event-input');
    function openDayEventModal(dateKey) {
        if (!dayEventModal || !dayEventInput) return;
        dayModalTargetDate = dateKey || todayKey();
        dayEventInput.value = (dashState.dayEvents || {})[dayModalTargetDate] || '';
        dayEventModal.classList.add('active');
        setTimeout(() => dayEventInput.focus(), 50);
    }
    function closeDayEventModal() {
        if (dayEventModal) dayEventModal.classList.remove('active');
    }
    const dayEventCloseBtn = document.getElementById('day-event-close');
    if (dayEventCloseBtn) dayEventCloseBtn.addEventListener('click', closeDayEventModal);
    if (dayEventModal) dayEventModal.addEventListener('click', (e) => { if (e.target === dayEventModal) closeDayEventModal(); });
    if (dayEventInput) dayEventInput.addEventListener('input', () => {
        if (!dashState.dayEvents) dashState.dayEvents = {};
        const text = dayEventInput.value.trim();
        if (text) dashState.dayEvents[dayModalTargetDate] = text;
        else delete dashState.dayEvents[dayModalTargetDate];
        saveProgress();
        if (onDayFieldsChanged) onDayFieldsChanged();
    });
    // Кнопка «Готово»/«Done» на мобильной клавиатуре шлёт keydown Enter — закрываем модалку так же,
    // как крестиком (данные уже сохранены по input выше, закрытие ничего дополнительно не пишет).
    if (dayEventInput) dayEventInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); closeDayEventModal(); } });

    // «Задача дня» — до DAY_TASKS_MAX штук на дату (юзер попросил: после добавления одной,
    // предложить добавить ещё, до трёх). dashState.dayTasks[date] хранится массивом [{text,done}];
    // старый формат (один объект {text,done} без массива, из версий до этой правки) — читаем через
    // getDayTasks, которая молча оборачивает его в массив из одного элемента, ничего не мигрируя
    // на диске явно (при следующем изменении само перезапишется уже массивом).
    const DAY_TASKS_MAX = 3;
    function getDayTasks(dateKey) {
        const raw = (dashState.dayTasks || {})[dateKey];
        if (!raw) return [];
        if (Array.isArray(raw)) return raw;
        return raw.text ? [raw] : [];
    }
    function setDayTasks(dateKey, arr) {
        if (!dashState.dayTasks) dashState.dayTasks = {};
        if (arr.length) dashState.dayTasks[dateKey] = arr;
        else delete dashState.dayTasks[dateKey];
    }

    const dayTaskModal = document.getElementById('day-task-modal');
    const dayTaskInput = document.getElementById('day-task-input');
    const dayTaskListEl = document.getElementById('day-task-list');
    function renderDayTaskModalList() {
        if (!dayTaskListEl) return;
        const tasks = getDayTasks(dayModalTargetDate);
        dayTaskListEl.innerHTML = tasks.map((t, i) => `
            <div class="cal-item">
                <span class="day-task-list-text${t.done ? ' done' : ''}" data-idx="${i}">${esc(t.text)}</span>
                <button type="button" class="cal-item-del" data-idx="${i}" aria-label="Удалить">✕</button>
            </div>`).join('');
        dayTaskListEl.querySelectorAll('.day-task-list-text').forEach(el => el.addEventListener('click', () => {
            const arr = getDayTasks(dayModalTargetDate);
            const idx = +el.dataset.idx;
            arr[idx].done = !arr[idx].done;
            setDayTasks(dayModalTargetDate, arr);
            saveProgress();
            renderDayTaskModalList();
            if (onDayFieldsChanged) onDayFieldsChanged();
        }));
        dayTaskListEl.querySelectorAll('.cal-item-del').forEach(el => el.addEventListener('click', () => {
            const arr = getDayTasks(dayModalTargetDate);
            arr.splice(+el.dataset.idx, 1);
            setDayTasks(dayModalTargetDate, arr);
            saveProgress();
            renderDayTaskModalList();
            if (onDayFieldsChanged) onDayFieldsChanged();
        }));
        const atMax = tasks.length >= DAY_TASKS_MAX;
        dayTaskInput.style.display = atMax ? 'none' : '';
        document.getElementById('day-task-add-btn').style.display = atMax ? 'none' : '';
        dayTaskInput.placeholder = tasks.length ? 'ещё одна задача' : 'главная задача на день';
    }
    function addDayTask() {
        const text = dayTaskInput.value.trim();
        if (!text) return;
        const arr = getDayTasks(dayModalTargetDate);
        if (arr.length >= DAY_TASKS_MAX) return;
        arr.push({ text, done: false });
        setDayTasks(dayModalTargetDate, arr);
        saveProgress();
        dayTaskInput.value = '';
        renderDayTaskModalList();
        if (onDayFieldsChanged) onDayFieldsChanged();
        if (dayTaskInput.style.display !== 'none') dayTaskInput.focus(); // готов вводить следующую сразу
    }
    function openDayTaskModal(dateKey) {
        if (!dayTaskModal || !dayTaskInput) return;
        dayModalTargetDate = dateKey || todayKey();
        dayTaskInput.value = '';
        renderDayTaskModalList();
        dayTaskModal.classList.add('active');
        setTimeout(() => { if (dayTaskInput.style.display !== 'none') dayTaskInput.focus(); }, 50);
    }
    function closeDayTaskModal() {
        if (dayTaskModal) dayTaskModal.classList.remove('active');
    }
    const dayTaskCloseBtn = document.getElementById('day-task-close');
    if (dayTaskCloseBtn) dayTaskCloseBtn.addEventListener('click', closeDayTaskModal);
    if (dayTaskModal) dayTaskModal.addEventListener('click', (e) => { if (e.target === dayTaskModal) closeDayTaskModal(); });
    const dayTaskAddBtn = document.getElementById('day-task-add-btn');
    if (dayTaskAddBtn) dayTaskAddBtn.addEventListener('click', addDayTask);
    if (dayTaskInput) dayTaskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDayTask(); } });

    // Рендерит «Событие дня» (текст) и «Задача дня» (до 3 штук, текст + чекбокс) для конкретного
    // dateKey — вызывается из Дня и normal-mode, и Pro mode (см. renderTaskDayView/renderPsychoDay).
    // onChange регистрируется в onDayFieldsChanged, чтобы автосохранение из модалок обновляло именно
    // этот блок.
    function renderDayEventAndTask(container, dateKey, onChange) {
        if (!container) return;
        onDayFieldsChanged = onChange;
        const eventText = (dashState.dayEvents || {})[dateKey] || '';
        const tasks = getDayTasks(dateKey);
        // Своя строка «Задача дня» на КАЖДУЮ уже добавленную задачу + ОДНА пустая строка сверху
        // лимита, чтобы можно было добавить следующую (юзер: не показывать сразу все 3 кнопки,
        // если ни одна задача не заполнена — следующая появляется только после заполнения
        // предыдущей). При достижении DAY_TASKS_MAX пустой строки уже нет.
        const rowsCount = Math.min(tasks.length + 1, DAY_TASKS_MAX);
        let taskRows = '';
        for (let i = 0; i < rowsCount; i++) {
            const t = tasks[i];
            taskRows += `<div class="day-field-row">
                <button type="button" class="day-event-btn day-task-btn">Задача дня</button>
                ${t ? `<span class="day-task-inline${t.done ? ' done' : ''}" data-idx="${i}">${esc(t.text)}</span>` : ''}
            </div>`;
        }
        container.innerHTML = `
            <div class="day-field-row">
                <button type="button" class="day-event-btn" id="open-day-event-btn">Событие дня</button>
                ${eventText ? `<span class="day-event-inline">${esc(eventText)}</span>` : ''}
            </div>
            ${taskRows}`;
        document.getElementById('open-day-event-btn').addEventListener('click', () => openDayEventModal(dateKey));
        container.querySelectorAll('.day-task-btn').forEach(btn => btn.addEventListener('click', () => openDayTaskModal(dateKey)));
        container.querySelectorAll('.day-task-inline').forEach(el => el.addEventListener('click', () => {
            const arr = getDayTasks(dateKey);
            const idx = +el.dataset.idx;
            arr[idx].done = !arr[idx].done;
            setDayTasks(dateKey, arr);
            saveProgress();
            renderDayEventAndTask(container, dateKey, onChange);
        }));
    }

    // === ПЕЙВОЛЛ PRO MODE — открывается кликом по закрытой Pro-кнопке «Задачи»/«Питание» без
    // подписки (см. обработчик .view-btn выше), отдельного тумблера-замка больше нет (юзер
    // попросил убрать) — сами эти две кнопки в таб-баре и есть «закрытые вкладки». ===
    // Превью/заголовок/описание — под конкретную вкладку (kind: 'tasks' | 'food'), а не общие —
    // юзер: «в каждой из двух закрытых вкладок показать детали этих вкладок, как раньше было
    // сделано только для pro mode задачи» (тот самый превью с км/сном/сигаретами уже был, но
    // только один на все случаи — теперь у «Питание» свой, про калории).
    const PROMODE_PREVIEWS = {
        tasks: {
            title: 'Pro mode — Задачи',
            rows: [
                ['км пробежал', '7.4 / 10 км'],
                ['часов поспал', '7.5 / 8 ч'],
                ['минут медитировал', '15 / 15 мин'],
                ['сигарет скурил', '0 / 0 шт'],
            ],
            desc: 'Числовые показатели дня вместо списка задач — своя метрика на всё, что хочешь считать: км, сон, кофе, деньги и что угодно ещё.',
        },
        food: {
            title: 'Pro mode — Питание',
            rows: [
                ['калории за день', '1450 / 2000 ккал'],
                ['булочка с корицей', '350 ккал'],
                ['капучино 350мл', '140 ккал'],
            ],
            desc: 'Счётчик калорий за день с поиском по базе продуктов вместо простого времени приёма пищи — заносишь, что съел, видно сумму и цель на день.',
        },
    };
    function openProModePaywall(kind) {
        const m = document.getElementById('promode-paywall-modal');
        if (!m) return;
        const cfg = PROMODE_PREVIEWS[kind] || PROMODE_PREVIEWS.tasks;
        const titleEl = document.getElementById('promode-modal-title');
        const previewEl = document.getElementById('promode-preview');
        const descEl = document.getElementById('promode-desc');
        if (titleEl) titleEl.textContent = cfg.title;
        if (previewEl) previewEl.innerHTML = cfg.rows.map(([label, val]) => `<div class="promode-preview-row"><span>${label}</span><b>${val}</b></div>`).join('');
        if (descEl) descEl.textContent = cfg.desc;
        m.classList.add('active');
        updatePromodeFamilyButton();
    }
    function closeProModePaywall() {
        const m = document.getElementById('promode-paywall-modal');
        if (m) m.classList.remove('active');
    }
    // Family дешевле Personal именно за счёт нескольких человек — покупать его в одиночку
    // бессмысленно, поэтому пока в семье (window.familyMemberCount, см. auth.js renderInvitedFriends) никого
    // нет, кнопка вообще не показывается (а не просто дизейблится).
    function updatePromodeFamilyButton() {
        const btn = document.getElementById('promode-buy-family-btn');
        if (!btn) return;
        const hasFamily = (window.familyMemberCount || 0) > 0;
        btn.style.display = hasFamily ? '' : 'none';
    }
    const promodeCloseBtn = document.getElementById('promode-close');
    if (promodeCloseBtn) promodeCloseBtn.addEventListener('click', closeProModePaywall);
    const promodeModalEl = document.getElementById('promode-paywall-modal');
    if (promodeModalEl) promodeModalEl.addEventListener('click', (e) => { if (e.target === promodeModalEl) closeProModePaywall(); });
    const promodeBuyPersonalBtn = document.getElementById('promode-buy-personal-btn');
    if (promodeBuyPersonalBtn) promodeBuyPersonalBtn.addEventListener('click', () => {
        if (typeof window.buyPersonalPlanOneClick === 'function') window.buyPersonalPlanOneClick('promode-msg', 'promode-buy-personal-btn');
    });
    const promodeBuyFamilyBtn = document.getElementById('promode-buy-family-btn');
    if (promodeBuyFamilyBtn) promodeBuyFamilyBtn.addEventListener('click', () => {
        if (!(window.familyMemberCount || 0)) return; // недоступно — см. updatePromodeFamilyButton
        // Размер семьи = сам юзер + принятые приглашения (window.familyMemberCount, см. auth.js
        // renderFamily) — больше не спрашиваем числом вручную, считаем от реального состава семьи.
        const size = Math.max(2, Math.min(10, (window.familyMemberCount || 0) + 1));
        if (typeof window.buyFamilyPlanOneClick === 'function') window.buyFamilyPlanOneClick(size, 'promode-msg', 'promode-buy-family-btn');
    });
    const promodeInviteBtn = document.getElementById('promode-invite-btn');
    if (promodeInviteBtn) promodeInviteBtn.addEventListener('click', () => {
        if (typeof window.shareInviteLink === 'function') window.shareInviteLink();
    });

    // === ПЕЙВОЛЛ ПОСЛЕ ТРИАЛА (Фаза 7, см. HANDOFF.md) — жёсткий блок без активной подписки и
    // без бонусных дней, но с кнопкой «Пригласить друга» прямо на экране блокировки (юзер может
    // разблокировать доступ без оплаты). Показывается/скрывается через window.applyAppAccessGate,
    // которую дёргает auth.js после каждого loadSubscription() и на visibilitychange.
    const paywallBuyPersonalBtn = document.getElementById('paywall-buy-personal-btn');
    if (paywallBuyPersonalBtn) paywallBuyPersonalBtn.addEventListener('click', () => {
        if (typeof window.buyPersonalPlanOneClick === 'function') window.buyPersonalPlanOneClick('paywall-msg', 'paywall-buy-personal-btn');
    });
    const paywallBuyFamilyBtn = document.getElementById('paywall-buy-family-btn');
    if (paywallBuyFamilyBtn) paywallBuyFamilyBtn.addEventListener('click', () => {
        if (!(window.familyMemberCount || 0)) return; // недоступно — см. updatePromodeFamilyButton
        const size = Math.max(2, Math.min(10, (window.familyMemberCount || 0) + 1));
        if (typeof window.buyFamilyPlanOneClick === 'function') window.buyFamilyPlanOneClick(size, 'paywall-msg', 'paywall-buy-family-btn');
    });
    const paywallInviteBtn = document.getElementById('paywall-invite-btn');
    if (paywallInviteBtn) paywallInviteBtn.addEventListener('click', () => {
        if (typeof window.shareInviteLink === 'function') window.shareInviteLink();
    });
    window.applyAppAccessGate = function (hasAccess) {
        const screen = document.getElementById('paywall-screen');
        if (!screen) return;
        screen.style.display = hasAccess ? 'none' : 'flex';
        if (!hasAccess && paywallBuyFamilyBtn) paywallBuyFamilyBtn.style.display = (window.familyMemberCount || 0) > 0 ? '' : 'none';
    };

    // === ПИТОМЕЦ: «бегающий» роумер (десктоп) ===
    const petRoamerEl = document.getElementById('pet-roamer');
    if (petRoamerEl) petRoamerEl.addEventListener('click', () => switchView('pet'));
    window.addEventListener('resize', () => { if (dashboardScreen.classList.contains('visible')) updatePetRoamer(); });

    // === ОНБОРДИНГ: кнопки тура, «?» и подсказки ===
    const coachNext = document.querySelector('.coach-next');
    const coachSkip = document.querySelector('.coach-skip');
    if (coachNext) coachNext.addEventListener('click', () => showCoachStep(tourIdx + 1));
    if (coachSkip) coachSkip.addEventListener('click', () => endTour());
    const helpBtn = document.getElementById('help-btn');
    if (helpBtn) helpBtn.addEventListener('click', () => { if (dashState.psychoMode) setPsychoMode(false); switchView('month'); setTimeout(() => startTour(DAY_TOUR), 200); });
    const hintClose = document.getElementById('onb-hint-close');
    if (hintClose) hintClose.addEventListener('click', () => { document.getElementById('onb-hint').style.display = 'none'; });
    window.addEventListener('resize', () => { if (document.getElementById('coach-overlay')?.classList.contains('active')) showCoachStep(tourIdx); });

    // === НИЖНИЙ КЛАСТЕР ЗАФИКСИРОВАН (position:fixed) — меряем его реальную высоту и резервируем
    // столько же места снизу в .dash-content (padding-bottom: var(--bottom-bar-h)), иначе контент
    // последних строк/вкладок будет прятаться под таб-баром. Мерить нужно повторно: высота зависит
    // от переноса текста на узких экранах и может измениться после первой отрисовки (шрифты и т.п.).
    function measureBottomBar() {
        const bar = document.getElementById('dash-bottom-bar');
        if (!bar) return;
        const h = bar.getBoundingClientRect().height;
        if (h > 0) document.documentElement.style.setProperty('--bottom-bar-h', h + 'px');
    }
    measureBottomBar();
    setTimeout(measureBottomBar, 300);
    setTimeout(measureBottomBar, 1200);
    window.addEventListener('resize', measureBottomBar);

    // === МОДАЛКИ НАД КЛАВИАТУРОЙ (мобильная адаптация) ===
    // На мобильном (особенно в Telegram WebView) `position:fixed` центрируется по ПОЛНОЙ высоте
    // layout-вьюпорта, а не по видимой области — когда открывается системная клавиатура, видимая
    // область (visualViewport) сжимается, но фиксированная модалка остаётся «отцентрована» по
    // старой полной высоте и может уехать за клавиатуру вместе с полем ввода. Держим модалку
    // подогнанной под текущий visualViewport (юзер попросил: «поднимать окно... чтоб было видно
    // где пишешь»). Работает для всех модалок на классе .habit-settings-modal (настройки задачи,
    // событие/задача дня, подтверждение, пейволл) — они все текстовые «окна для написания».
    if (window.visualViewport) {
        const vv = window.visualViewport;
        const repositionModals = () => {
            document.querySelectorAll('.habit-settings-modal.active').forEach(overlay => {
                overlay.style.height = vv.height + 'px';
                overlay.style.top = vv.offsetTop + 'px';
            });
        };
        vv.addEventListener('resize', repositionModals);
        vv.addEventListener('scroll', repositionModals);
        // На случай если модалка открывается, пока клавиатура уже поднята (напр. повторное
        // открытие) — подгоняем сразу при открытии, а не ждём следующего resize.
        document.addEventListener('focusin', (e) => {
            if (e.target.closest && e.target.closest('.habit-settings-modal.active')) {
                repositionModals();
                setTimeout(repositionModals, 300); // клавиатура анимируется — догоняем после анимации
            }
        });
    }

    // === НИЖНЯЯ ПАНЕЛЬ ПРЯЧЕТСЯ ПРИ ОТКРЫТОЙ КЛАВИАТУРЕ ===
    // `#dash-bottom-bar` зафиксирована снизу вьюпорта поверх контента (см. measureBottomBar выше) —
    // юзер сообщил, что при открытой клавиатуре она остаётся поверх того, что он в этот момент
    // печатает/видит (в том числе на игровых экранах — там обычные <input>, не модалки, поэтому их
    // не покрывает фикс из блока выше). Прячем панель по фокусу на ЛЮБОМ текстовом поле где угодно
    // в приложении — привязываться к высоте visualViewport ненадёжно (клавиатура анимируется,
    // высота меняется постепенно), а фокус/блюр поля — прямой и мгновенный сигнал «клавиатура
    // открылась/закрылась». setTimeout в focusout — иначе смена фокуса МЕЖДУ двумя полями (клик из
    // одного инпута в другой) на миг покажет и тут же спрячет панель.
    (function initKeyboardAwareBottomBar() {
        const bottomBar = document.getElementById('dash-bottom-bar');
        if (!bottomBar) return;
        // ВАЖНО (баг «кнопки снизу вообще пропали», репорт юзера со скриншотом): полагаться ТОЛЬКО
        // на focusout нельзя. Если сфокусированный инпут УДАЛЯЕТСЯ из DOM (а это в приложении
        // происходит постоянно: renderPsychoMetrics чистит list.innerHTML, initCheckins/
        // loadHistoryData подменяют инпуты через replaceChild, renderDayEventAndTask/renderFood*
        // перерисовывают контейнер целиком), браузер не гарантирует focusout по удалённому узлу —
        // класс kb-hidden оставался навсегда, и таб-бар исчезал до перезагрузки приложения.
        // Поэтому «показать обратно» вынесено в отдельную проверку по РЕАЛЬНОМУ состоянию
        // (document.activeElement + наличие узла в документе) и дёргается из нескольких источников.
        const isTypable = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
            !['checkbox', 'radio', 'button', 'submit', 'range'].includes(el.type);
        const keyboardOpen = () => {
            const el = document.activeElement;
            return isTypable(el) && document.contains(el);
        };
        function syncBottomBar() { bottomBar.classList.toggle('kb-hidden', keyboardOpen()); }
        window.syncBottomBar = syncBottomBar; // switchView зовёт её при каждой смене вкладки

        document.addEventListener('focusin', (e) => { if (isTypable(e.target)) bottomBar.classList.add('kb-hidden'); });
        document.addEventListener('focusout', () => setTimeout(syncBottomBar, 50));
        // Страховки на случай, когда focusout не пришёл вовсе: закрытие клавиатуры меняет высоту
        // visualViewport, любой тап по экрану — тоже подходящий момент перепроверить, а
        // visibilitychange ловит возврат в приложение из фона.
        if (window.visualViewport) window.visualViewport.addEventListener('resize', syncBottomBar);
        window.addEventListener('resize', syncBottomBar);
        document.addEventListener('click', () => setTimeout(syncBottomBar, 50));
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncBottomBar(); });
    })();

    // === ПАНЕЛЬ ПОДТВЕРЖДЕНИЯ НАД ЦИФРОВОЙ КЛАВИАТУРОЙ ===
    // У цифровых клавиатур на телефоне нет Enter/«Готово» (жалоба юзера: ввёл число и непонятно,
    // чем подтвердить). Показываем над клавиатурой одну кнопку: «Принять изменения», если в поле
    // что-то введено, и «Отменить ввод», если пусто.
    // Подтверждение шлёт в поле НАСТОЯЩИЙ keydown Enter, а не просто blur: у части полей на Enter
    // висит не только сохранение, но и действие (.metric-input добавляет значение, #cal-manual-kcal
    // добавляет позицию, .goal-edit-input сохраняет цель) — blur там ничего бы не сделал. Поля с
    // автосохранением по input от лишнего Enter не пострадают.
    (function initNumericKeyboardBar() {
        const bar = document.getElementById('kb-accept-bar');
        const btn = document.getElementById('kb-accept-btn');
        if (!bar || !btn) return;
        // Только числовые поля — у обычных текстовых на клавиатуре Enter/«Готово» есть, там панель
        // была бы лишней (см. enterkeyhint="done" в разметке).
        const isNumeric = (el) => !!el && el.tagName === 'INPUT' &&
            (el.type === 'number' || ['decimal', 'numeric'].includes((el.getAttribute('inputmode') || '').toLowerCase()));
        let target = null;

        function place() {
            const vv = window.visualViewport;
            // Высота, которую занимает клавиатура снизу: сколько «съел» visualViewport у окна.
            const gap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
            bar.style.bottom = gap + 'px';
        }
        function refresh() {
            if (!target || !document.contains(target) || document.activeElement !== target) { hide(); return; }
            const filled = String(target.value || '').trim() !== '';
            btn.textContent = filled ? 'Принять изменения' : 'Отменить ввод';
            bar.classList.toggle('is-cancel', !filled);
            place();
        }
        function hide() { target = null; bar.classList.remove('show'); }

        document.addEventListener('focusin', (e) => {
            if (!isNumeric(e.target)) { hide(); return; }
            target = e.target;
            bar.classList.add('show');
            refresh();
        });
        document.addEventListener('focusout', () => setTimeout(() => { if (!isNumeric(document.activeElement)) hide(); }, 50));
        document.addEventListener('input', (e) => { if (e.target === target) refresh(); });
        if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (target) place(); });

        // mousedown/touchstart, а не click: к моменту click поле уже потеряет фокус, и target
        // обнулится обработчиком focusout выше. preventDefault не даёт фокусу уйти раньше времени.
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            const el = target;
            if (!el) return;
            if (String(el.value || '').trim() !== '') {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            }
            el.blur();
            hide();
        });
    })();

    // === СВАЙП МЕЖДУ ВКЛАДКАМИ (мобильная адаптация) ===
    // Влево — следующая вкладка, вправо — предыдущая. Порядок берём из видимых кнопок таб-бара
    // (питомец скрыт display:none — автоматически исключается). Свайп не зацикливается на краях.
    (function initSwipeNav() {
        if (!FEATURES.swipeNav) return;
        const content = document.querySelector('.dash-content');
        if (!content) return;
        const SWIPE_THRESHOLD = 60; // px — ниже считаем обычным тапом/скроллом, не свайпом
        let startX = 0, startY = 0, tracking = false, horizontal = false;

        content.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
            horizontal = false;
        }, { passive: true });

        content.addEventListener('touchmove', (e) => {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (!horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) horizontal = true;
            if (horizontal) e.preventDefault(); // блокируем вертикальный скролл, только когда жест явно горизонтальный
        }, { passive: false });

        content.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            if (!horizontal) return;
            const dx = e.changedTouches[0].clientX - startX;
            if (Math.abs(dx) < SWIPE_THRESHOLD) return;
            const order = Array.from(document.querySelectorAll('.view-btn'))
                .filter(b => getComputedStyle(b).display !== 'none')
                .map(b => b.dataset.view);
            const activeBtn = document.querySelector('.view-btn.active');
            const idx = activeBtn ? order.indexOf(activeBtn.dataset.view) : -1;
            if (idx === -1) return;
            const nextIdx = dx < 0 ? idx + 1 : idx - 1;
            if (nextIdx < 0 || nextIdx >= order.length) return;
            switchView(order[nextIdx]);
        }, { passive: true });
    })();

    // === ФОТО ГЛАВНОГО ЭКРАНА (интро + стартовый лоадер) ===
    // Просьба юзера: «сделай возможность в профиле настроить фотку главного экрана, где крупными
    // буквами написано live life, и сделай чтобы эта фотка была вместо белого экрана при открытии
    // приложения. её можно настраивать неограниченное кол-во раз».
    // ГДЕ ХРАНИМ И ПОЧЕМУ ИМЕННО ТАК: отдельный ключ localStorage (мгновенный старт без белой
    // вспышки — его читает инлайн-скрипт в <head> index.html) + отдельная облачная таблица
    // user_media (db/phase22_intro_photo.sql), чтобы фото переезжало на другое устройство.
    // Класть картинку в dashState НЕЛЬЗЯ: dashState целиком уезжает в облачную jsonb-колонку
    // app_state при КАЖДОМ сохранении (saveProgress → window.syncAppState → auth.js pushAppState,
    // см. db/phase11_app_state_sync.sql) — base64 на 250КБ означал бы лишние сотни килобайт
    // исходящего трафика на каждый поставленный чек-бокс и столько же входящего на каждое
    // realtime-событие другого устройства. Бонусом отдельный ключ переживает applyCloudState():
    // тот перезаписывает только 'habbittracker_progress', так что фото не слетает при синке.
    const INTRO_PHOTO_KEY = 'habbittracker_intro_photo';
    const INTRO_PHOTO_MAX_W = 1080;   // с камеры прилетает 3-4К; 1080px по ширине с запасом хватает любому телефонному экрану
    const INTRO_PHOTO_QUALITY = 0.82; // JPEG: на фотографии заметно легче PNG, прозрачность тут не нужна

    function getIntroPhoto() {
        try { return localStorage.getItem(INTRO_PHOTO_KEY) || ''; } catch (e) { return ''; }
    }

    // Ровно то же самое делает инлайн-скрипт в <head> index.html — он нужен, чтобы фото стояло ДО
    // первой отрисовки (иначе белая вспышка), а эта функция — чтобы смена фото в профиле была
    // видна мгновенно, без перезагрузки страницы. Сами правила — в habbittracker.css
    // (html.has-intro-photo #intro-screen / .loading-overlay).
    function applyIntroPhoto(dataUrl) {
        const root = document.documentElement;
        if (dataUrl) {
            root.style.setProperty('--intro-photo', `url("${dataUrl}")`);
            root.classList.add('has-intro-photo');
        } else {
            root.style.removeProperty('--intro-photo');
            root.classList.remove('has-intro-photo');
        }
    }

    // Ужимаем картинку канвасом ДО сохранения: файл с камеры телефона — это 3-8МБ, а в
    // localStorage на весь origin ~5МБ, и там уже лежит весь прогресс (habbittracker_progress).
    // Без сжатия setItem гарантированно упал бы с QuotaExceededError.
    function readIntroPhotoAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const scale = Math.min(1, INTRO_PHOTO_MAX_W / img.naturalWidth); // апскейлить маленькие картинки незачем
                const w = Math.max(1, Math.round(img.naturalWidth * scale));
                const h = Math.max(1, Math.round(img.naturalHeight * scale));
                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                cv.getContext('2d').drawImage(img, 0, 0, w, h);
                try { resolve(cv.toDataURL('image/jpeg', INTRO_PHOTO_QUALITY)); }
                catch (e) { reject(e); } // теоретически возможно только на «испорченном» канвасе
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('не удалось прочитать файл')); };
            img.src = url;
        });
    }

    (function initIntroPhoto() {
        const input = document.getElementById('intro-photo-input');
        const pickBtn = document.getElementById('intro-photo-pick');
        const clearBtn = document.getElementById('intro-photo-clear');
        const preview = document.getElementById('intro-photo-preview');
        const msg = document.getElementById('intro-photo-msg');
        if (!input || !pickBtn || !clearBtn || !preview || !msg) return;
        const HINT = 'Меняй сколько угодно раз — это фото встанет вместо белого экрана при запуске.';

        function renderPhotoUI() {
            const cur = getIntroPhoto();
            preview.style.backgroundImage = cur ? `url("${cur}")` : '';
            preview.classList.toggle('has-photo', !!cur);
            clearBtn.style.display = cur ? 'block' : 'none';
            pickBtn.textContent = cur ? 'Заменить фото' : 'Выбрать фото';
        }
        // auth.js зовёт её после loadIntroPhoto(), когда облачная копия приехала уже ПОСЛЕ того,
        // как профиль отрисовался (сеть медленнее, чем открытие модалки).
        window.refreshIntroPhotoUI = () => { applyIntroPhoto(getIntroPhoto()); renderPhotoUI(); };

        // input.value='' перед .click() — иначе повторный выбор ТОГО ЖЕ файла не даёт события
        // change, и юзеру кажется, что кнопка сломалась (а он просил менять фото неограниченно).
        pickBtn.addEventListener('click', () => { input.value = ''; input.click(); });

        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            msg.textContent = 'Обрабатываем фото…';
            try {
                const dataUrl = await readIntroPhotoAsDataUrl(file);
                localStorage.setItem(INTRO_PHOTO_KEY, dataUrl); // может бросить QuotaExceededError — ловим ниже
                applyIntroPhoto(dataUrl);
                renderPhotoUI();
                msg.textContent = 'Готово — фото уже стоит на главном экране.';
                // Облачная копия (user_media) — fire-and-forget: если сети нет, фото всё равно уже
                // работает на этом устройстве, а следующая смена фото зальёт его заново.
                if (window.saveIntroPhotoToCloud) window.saveIntroPhotoToCloud(dataUrl);
                setTimeout(() => { if (msg.textContent.startsWith('Готово')) msg.textContent = HINT; }, 2500);
            } catch (e) {
                // Практически всегда это переполнение localStorage: там уже лежит весь прогресс.
                // Старое фото при этом не трогаем — юзер не теряет то, что уже стояло.
                console.warn('⚠️ Фото главного экрана не сохранилось:', e);
                msg.textContent = 'Не получилось сохранить фото — попробуй картинку поменьше.';
            }
        });

        clearBtn.addEventListener('click', () => {
            try { localStorage.removeItem(INTRO_PHOTO_KEY); } catch (e) {}
            applyIntroPhoto('');
            renderPhotoUI();
            if (window.saveIntroPhotoToCloud) window.saveIntroPhotoToCloud('');
            msg.textContent = HINT;
        });

        renderPhotoUI();
    })();

    // === СТАРТОВЫЙ ЛОАДЕР ===
    // Юзер попросил показывать «терпение — ключ к успеху…» на первой загрузке, пока приложение
    // тянет облачное состояние (проверка бэкапа с других устройств, см. loadAppState в auth.js) —
    // минимум ~3 секунды, дальше по факту загрузки. Раньше этот оверлей включался только по тапу
    // по интро, и старт возвращающегося юзера выглядел как «пусто, потом резко дашборд».
    // Три условия снятия, чтобы лоадер не завис ни при каком раскладе:
    //   - облако ответило (markCloudStateSettled ниже — зовёт auth.js, в т.ч. при таймауте);
    //   - прошёл минимум MIN_MS (иначе на быстрой сети лоадер моргнул бы на 100мс);
    //   - истёк MAX_MS — жёсткий предохранитель, если auth.js вообще не догрузился (CDN/сеть).
    // ТОЛЬКО для возвращающегося юзера (у которого уже есть сохранённые данные и который сразу
    // попадает на дашборд, см. условие в init). У нового юзера показывать нечего: он ещё не
    // залогинен, облака у него нет, markCloudStateSettled никогда не придёт — лоадер просто
    // закрыл бы собой интро на все MAX_MS вместо «нажми на экран, чтобы начать».
    (function initBootLoader() {
        const saved = loadProgress();
        if (!saved || !Array.isArray(saved.habits)) return;
        const MIN_MS = 3000, MAX_MS = 8000;
        const startedAt = Date.now();
        let settled = false, done = false;
        loadingOverlay.classList.add('active');
        function finish() {
            if (done) return;
            done = true;
            loadingOverlay.classList.remove('active');
        }
        function tryFinish() {
            if (!settled) return;
            setTimeout(finish, Math.max(0, MIN_MS - (Date.now() - startedAt)));
        }
        window.markCloudStateSettled = () => { settled = true; tryFinish(); };
        // Не залогинен / не Telegram-контекст — облака не будет вовсе, ждать нечего.
        setTimeout(() => { if (!settled) { settled = true; tryFinish(); } }, MAX_MS);
    })();

    // === ЗАПУСК ===
    init();
});
