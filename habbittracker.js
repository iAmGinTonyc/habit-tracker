window.selectedIdentity = null;

// === FEATURE FLAGS (упрощение продукта — прячем UI/логику, НЕ удаляем код и данные.
// Откат = поменять значение на true. См. HANDOFF.md §15) ===
const FEATURES = {
    psychoMode: true, // «Pro mode» (бывший psycho mode) — тумблер снова виден всем, но под замком
    // подписки: клик без активной подписки открывает пейволл (openProModePaywall), а не сам режим.
    // false тут полностью скрыл бы тумблер целиком, как раньше.
    games: false,
    xpLevels: false,
    legacyCheckinFields: false, // старые поля утро/вечер сверх «качество сна + настроение», и вкладка «Вечер»
    swipeNav: false, // свайп пальцем между вкладками — отключено по просьбе (некрасиво смотрелось на десктопе/Telegram Desktop)
    dayTab: false, // вкладка «День» — заменена вкладкой «Задачи» (бывший «Месяц»), см. HANDOFF.md §15
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
    if (!FEATURES.psychoMode) {
        const el = document.getElementById('psycho-toggle');
        if (el) el.style.display = 'none';
    }
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

    // Telegram Mini App: разворачиваем на весь экран, сигналим клиенту, что готовы
    if (isTelegramContext()) {
        try {
            window.Telegram.WebApp.ready();
            window.Telegram.WebApp.expand();
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

    // === ПЕРЕМЕННЫЕ СОСТОЯНИЯ ===
    let timerInterval;
    let reminderInterval;
    let currentEditIndex = null;
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
        foodLog: {},        // приёмы пищи по дням: { 'YYYY-MM-DD': { breakfast:{time,text}, lunch, dinner } }
        psychoMode: false,  // тумблер «psycho mode» (числовые метрики вместо привычек)
        metrics: [],        // живой список метрик (сидируется из DEFAULT_METRICS в init/createDefaultState)
        metricTargets: {},  // переопределённые цели метрик { metricId: число }
        metricLog: {},      // числовые метрики по дням: { 'YYYY-MM-DD': { metricId: число|bool } }
        onboardingDone: false, // пройден ли вводный тур
        seenHints: {}       // показанные контекстные подсказки по вкладкам
    };

    function saveProgress() {
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
        return { level: dashState.level || 1, streak, weekPct, mood };
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
    const MAX_HABITS = 10;

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
    const DEFAULT_METRICS = [
        { id: 'run',      name: 'км пробежал',          unit: 'км',    type: 'goal',  target: 10,   step: 0.1 },
        { id: 'sleep',    name: 'часов поспал',         unit: 'ч',     type: 'goal',  target: 8,    step: 0.5 },
        { id: 'money',    name: 'денег заработал',      unit: '₽',     type: 'goal',  target: 3000 },
        { id: 'meditate', name: 'минут медитировал',    unit: 'мин',   type: 'goal',  target: 15 },
        { id: 'pages',    name: 'страниц прочитал',     unit: 'стр',   type: 'goal',  target: 30 },
        { id: 'cigs',     name: 'сигарет скурил',       unit: 'шт',    type: 'limit', target: 0 },
        { id: 'coffee',   name: 'кофе выпил',           unit: 'чашек', type: 'limit', target: 2 }
    ];
    const cloneMetrics = () => DEFAULT_METRICS.map(m => ({ ...m }));
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
    // — пустой список привычек, юзер добавляет через «+ добавить привычку» в «Задачах»).
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
        if (saved && saved.habits && saved.habits.length) {
            dashState = { ...dashState, ...saved };
            if (!dashState.checkins) dashState.checkins = { morning: {}, evening: {} };
            if (!dashState.checkinHistory) dashState.checkinHistory = {};
            if (!dashState.history) dashState.history = {};
            if (!dashState.foodLog) dashState.foodLog = {};
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
        renderTopNavSlot(''); // «Задачи» (viewName === 'month') сама заполнит слот заново ниже
        document.querySelectorAll('.dash-view').forEach(view => view.classList.remove('active'));
        const target = document.getElementById(`view-${viewName}`);
        if (target) target.classList.add('active'); // синхронно — иначе быстрые переключения оставляют 2 активных вида
        if (viewName === 'habits') { startDayTimer(); } else if (timerInterval) { clearInterval(timerInterval); }
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.view === viewName) btn.classList.add('active');
        });
        if (viewName === 'habits') renderDayView();
        else if (viewName === 'training') initTrainingMenu();
        else if (viewName === 'month') { monthCursor = null; renderMonthView(); }
        else if (viewName === 'pet') renderPet();
        else if (viewName === 'food') renderFood();
        else if (viewName === 'morning' || viewName === 'evening') {
            initCheckins(viewName);
            // График «настроение и сон» переехал сюда из вкладки «Месяц» (см. HANDOFF.md §15) —
            // всегда за ТЕКУЩИЙ календарный месяц (тут навигации по месяцам нет, в отличие от «Задач»).
            if (viewName === 'morning') {
                const now = new Date();
                const days = daysInMonth(now.getFullYear(), now.getMonth());
                drawMonthMoodSleep(now.getFullYear(), now.getMonth(), days);
                drawSleepHoursChart(now.getFullYear(), now.getMonth(), days);
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
            const hasMorning = todayData.morning && Object.keys(todayData.morning).length > 0;
            morningBtn.classList.toggle('pulse', !hasMorning);
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
    const streakChip = n => n > 0 ? `<span class="dash-habit-streak">${FLAME}${n}</span>` : '';

    // === ИГРЫ: МЕТА И РАЗБЛОКИРОВКА ПО УРОВНЯМ ===
    const GAMES = {
        memory: { name: 'Найди пару', desc: 'Тренировка памяти' },
        count:  { name: 'Посчитай', desc: 'Быстрый счёт на время' },
        words:  { name: '10 слов', desc: 'Запомни и введи' },
        sudoku: { name: 'Быстрое судоку', desc: 'По пропуску в квадрате' }
    };
    const GAME_ORDER = ['memory', 'count', 'words', 'sudoku'];
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
        const pt = document.getElementById('psycho-toggle');
        if (pt) { pt.classList.toggle('on', !!dashState.psychoMode); pt.setAttribute('aria-pressed', dashState.psychoMode ? 'true' : 'false'); }
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
    function monthHeadHtml(y, m) {
        return `<div class="month-head">
            <button class="month-nav" id="month-prev">←</button>
            <span class="month-label" id="month-label" title="Открыть выбор месяца">${MONTH_NAMES[m]} ${y}</span>
            <button class="month-nav" id="month-next">→</button>
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

        dashState.habits.forEach((habit, index) => {
            const row = document.createElement('div');
            row.className = `dash-habit-row ${habit.completed ? 'completed' : ''}`;
            let subtextHtml = '';
            if (habit.triggerText) subtextHtml += `<span>после того как ${habit.triggerText}</span>`;
            if (habit.reminderTime) subtextHtml += `<span>напомнить в ${habit.reminderTime}</span>`;
            row.innerHTML = `<div class="habit-main-line"><span class="habit-check"></span><span class="dash-habit-text">${habit.text}</span>${streakChip(currentStreak(habit.uid))}<span class="habit-settings-icon">${DOTS}</span></div>${subtextHtml ? `<div class="habit-subtext">${subtextHtml}</div>` : ''}`;
            row.querySelector('.habit-check').addEventListener('click', () => toggleHabit(index, row));
            row.querySelector('.dash-habit-text').addEventListener('click', () => toggleHabit(index, row));
            row.querySelector('.habit-settings-icon').addEventListener('click', (e) => { e.stopPropagation(); openHabitSettings(index); });
            list.appendChild(row);
        });

        // добавление новой привычки (до лимита MAX_HABITS)
        if (dashState.habits.length < MAX_HABITS) {
            const add = document.createElement('div');
            add.className = 'dash-habit-add';
            // autocomplete="off" Chrome иногда игнорирует для полей, похожих на логин (эвристика
            // сохранённых паролей) — "new-password" он уважает надёжнее, хоть поле и не пароль.
            add.innerHTML = `<input type="text" id="new-habit-input" maxlength="40" placeholder="+ добавить привычку" autocomplete="new-password" name="habit-${Date.now()}">`;
            list.appendChild(add);
            const inp = add.querySelector('#new-habit-input');
            inp.addEventListener('keydown', e => {
                if (e.key !== 'Enter') return;
                const v = inp.value.trim();
                if (!v) return;
                dashState.habits.push({ text: v, completed: false, uid: newUid(), areas: [] });
                saveProgress();
                renderDashboardHabits();
                const ni = document.getElementById('new-habit-input');
                if (ni) ni.focus();
            });
        } else {
            const note = document.createElement('div');
            note.className = 'dash-habit-limit';
            note.textContent = `Максимум ${MAX_HABITS} привычек`;
            list.appendChild(note);
        }
        renderLifeWheel('day', 'life-wheel-day'); // колесо отражает выполнение
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
        renderLifeWheel('day', 'life-wheel-day'); // колесо обновляется при отметке

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
        const habits = dashState.habits || [];
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
            <div class="month-hint">нажми на привычку, чтобы открыть календарь отметок</div>
            ${habits.length ? `<div class="heatmap" id="heatmap"></div>` : `<p class="month-empty">Пока нет привычек — добавь ниже.</p>`}
            <div id="month-habit-add"></div>
            <div class="month-wheel-block">
                <div id="life-wheel-month"></div>
            </div>
        `;
        wireTaskViewToggle(root);
        renderLifeWheel('month', 'life-wheel-month', y, m);

        // «+ добавить привычку» — переехало сюда из бывшей вкладки «День» (см. HANDOFF.md §15).
        // Полный ре-рендер вида проще, чем точечно вставлять ещё одну строку тепловой карты.
        const addBox = document.getElementById('month-habit-add');
        if (addBox) {
            if (dashState.habits.length < MAX_HABITS) {
                addBox.innerHTML = `<div class="dash-habit-add"><input type="text" id="new-habit-input" maxlength="40" placeholder="+ добавить привычку" autocomplete="new-password" name="habit-${Date.now()}"></div>`;
                const inp = addBox.querySelector('#new-habit-input');
                inp.addEventListener('keydown', e => {
                    if (e.key !== 'Enter') return;
                    const v = inp.value.trim();
                    if (!v) return;
                    dashState.habits.push({ text: v, completed: false, uid: newUid(), areas: [] });
                    saveProgress();
                    renderMonthView();
                });
            } else {
                addBox.innerHTML = `<div class="dash-habit-limit">Максимум ${MAX_HABITS} привычек</div>`;
            }
        }

        const hm = document.getElementById('heatmap');
        if (hm) {
            // Вместо клеток на каждый день — одна полоса-прогресс за месяц (юзер попросил заменить
            // тепловую карту дней на сводку, см. HANDOFF.md). Отметка/снятие отметки за конкретный
            // день теперь только через модалку-календарь (openHabitHistoryCalendar) — открывается
            // кликом по строке, включает и сегодня, и задний числом.
            habits.forEach((h, hIdx) => {
                const streak = currentStreak(h.uid);
                const monthDone = dayList.filter(d => isDone(h.uid, fdt(y, m, d))).length;
                const pct = days ? Math.round(monthDone / days * 100) : 0;
                const doneToday = isDone(h.uid, tKey);
                // Подпись под названием — время напоминания и триггер «я сделаю после…», если заданы.
                let subtextHtml = '';
                if (h.reminderTime) subtextHtml += `<span>${h.reminderTime}</span>`;
                if (h.triggerText) subtextHtml += `<span>я сделаю после: ${h.triggerText}</span>`;
                const rowEl = document.createElement('div');
                rowEl.className = 'hm-row';
                rowEl.dataset.uid = h.uid;
                rowEl.innerHTML = `
                    <div class="hm-row-head">
                        <div class="hm-row-headline">
                            <span class="hm-label${doneToday ? ' done' : ''}" title="${h.text}">${h.text}</span>
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
        document.getElementById('month-label').onclick = () => {
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
    // та же history-запись/XP/леджер скидки, что и везде; за прошлые дни — тот же retroactive-режим,
    // что уже разрешён в тепловой карте, просто без начисления XP. Будущее — недоступно.
    function toggleHabitForDate(habit, dateKey) {
        if (dateKey > todayKey()) return null;
        const now = !isDone(habit.uid, dateKey);
        setHistory(habit.uid, dateKey, now);
        if (dateKey === todayKey()) {
            habit.completed = now;
            if (now && habit.xpDate !== todayKey()) { habit.xpDate = todayKey(); awardXP(getLevelStats(dashState.level).xpPerHabit); }
            if (window.syncTodayCompletion) window.syncTodayCompletion((dashState.habits || []).filter(h => isDone(h.uid, todayKey())).length);
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
        const habits = dashState.habits || [];
        const isFuture = dateKey > todayKey();
        const rows = habits.map((h, idx) => {
            const done = isDone(h.uid, dateKey);
            return `<div class="task-day-row${done ? ' done' : ''}" data-uid="${h.uid}">
                <span class="task-day-text">${h.text}</span>
                ${streakChip(currentStreak(h.uid))}
                <span class="task-day-settings" data-idx="${idx}">${DOTS}</span>
            </div>`;
        }).join('');
        renderTopNavSlot(dayNavHeaderHtml(dateKey, 'task-day-nav'));
        root.innerHTML = `
            ${taskViewToggleHtml()}
            <div id="task-day-fields"></div>
            ${habits.length ? `<div class="task-day-list${isFuture ? ' future' : ''}">${rows}</div>` : '<p class="month-empty">Пока нет привычек — добавь ниже.</p>'}
            <div id="task-day-add"></div>`;
        wireDayNavHeader('task-day-nav', dateKey, (newKey) => { currentTaskDate = newKey; renderTaskDayView(newKey); });
        wireTaskViewToggle(root);
        function refreshFields() { renderDayEventAndTask(document.getElementById('task-day-fields'), dateKey, refreshFields); }
        refreshFields();

        if (!isFuture) {
            root.querySelectorAll('.task-day-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.task-day-settings')) return;
                    const h = habits.find(x => x.uid === row.dataset.uid);
                    if (!h) return;
                    const now = toggleHabitForDate(h, dateKey);
                    row.classList.toggle('done', now);
                });
            });
        }
        root.querySelectorAll('.task-day-settings').forEach(s => s.addEventListener('click', (e) => { e.stopPropagation(); openHabitSettings(+s.dataset.idx); }));

        // «+ добавить привычку» — тот же паттерн, что в шапке тепловой карты (см. renderMonthView).
        const addBox = document.getElementById('task-day-add');
        if (addBox) {
            if (habits.length < MAX_HABITS) {
                addBox.innerHTML = `<div class="dash-habit-add"><input type="text" id="new-habit-input-day" maxlength="40" placeholder="+ добавить привычку" autocomplete="new-password" name="habit-${Date.now()}"></div>`;
                const inp = addBox.querySelector('#new-habit-input-day');
                inp.addEventListener('keydown', e => {
                    if (e.key !== 'Enter') return;
                    const v = inp.value.trim();
                    if (!v) return;
                    dashState.habits.push({ text: v, completed: false, uid: newUid(), areas: [] });
                    saveProgress();
                    renderTaskDayView(dateKey);
                });
            } else {
                addBox.innerHTML = `<div class="dash-habit-limit">Максимум ${MAX_HABITS} привычек</div>`;
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
    // либо через календарь (см. dayNavHeaderHtml/wireDayNavHeader). Прошлые дни — только чтение
    // (renderPsychoMetricsReadOnly), сегодня — живой ввод (renderPsychoMetrics). Уже внутри Pro mode
    // (сама вкладка под замком подписки) — отдельного гейта не нужно, в отличие от календаря питания
    // (тот доступен и без Pro mode, поэтому гейтится отдельно).
    let currentPsychoDate = todayKey();

    function renderPsychoDay() {
        const root = document.getElementById('view-month');
        const dateKey = currentPsychoDate;
        const isToday = dateKey === todayKey();
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
        if (isToday) renderPsychoMetrics(document.getElementById('psycho-list-tasks'));
        else renderPsychoMetricsReadOnly(document.getElementById('psycho-list-tasks'), dateKey);
    }

    // Читаемый снимок показателей за прошлый день (dashState.metricLog[date]) — без контролов
    // добавления/переименования/удаления, которые есть только у СЕГОДНЯШНЕГО ввода (см. renderPsychoMetrics).
    function renderPsychoMetricsReadOnly(container, date) {
        if (!container) return;
        const metrics = dashState.metrics || [];
        if (!metrics.length) { container.innerHTML = '<div class="dash-habit-limit">Нет показателей</div>'; return; }
        const rec = (dashState.metricLog || {})[date] || {};
        container.innerHTML = metrics.map(m => {
            const val = +rec[m.id] || 0;
            const target = metricTarget(m);
            const isLimit = m.type === 'limit';
            const over = isLimit && val > target;
            const pct = target > 0 ? Math.min(100, Math.round(val / target * 100)) : (val > 0 ? 100 : 0);
            return `<div class="metric-row">
                <div class="metric-top">
                    <span class="metric-name-wrap"><span class="metric-name">${m.name}</span>${isLimit ? '<span class="metric-tag">лимит</span>' : ''}</span>
                    <span class="metric-val ${over ? 'over' : ''}"><b>${fmtNum(val)}</b> / ${fmtNum(target)} ${m.unit || ''}</span>
                </div>
                <div class="metric-bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>
            </div>`;
        }).join('');
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
                <div class="pm-top"><span class="pm-name">${mt.name}${isLimit ? '<span class="metric-tag">лимит</span>' : ''}</span>
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
        document.getElementById('month-label').onclick = () => {
            openMonthPicker({ value: { y: monthCursor.y, m: monthCursor.m }, onPick: (py, pm) => { monthCursor.y = py; monthCursor.m = pm; renderMonthView(); } });
        };
        wirePsychoToggle(root);
    }

    // Линия настроения и качества сна за месяц (данные из утренних чек-апов)
    function drawMonthMoodSleep(y, m, days) {
        const canvas = document.getElementById('month-ms-chart');
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0) { setTimeout(() => drawMonthMoodSleep(y, m, days), 60); return; } // ещё не виден
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
        const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
        const w = rect.width, h = rect.height;
        const pad = { t: 8, r: 10, b: 16, l: 22 };
        const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
        ctx.clearRect(0, 0, w, h);

        // сетка 0 / 5 / 10
        ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 1; ctx.fillStyle = '#bbb'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
        [0, 5, 10].forEach(v => { const yy = pad.t + ih - (v / 10) * ih; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke(); ctx.fillText(v, pad.l - 4, yy + 3); });

        const hist = dashState.checkinHistory || {};
        const xAt = d => pad.l + (days > 1 ? (d - 1) / (days - 1) * iw : iw / 2);
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
    }

    // Часы сна отдельным графиком: Y — время суток (0–24), X — дни месяца; закрашенный отрезок —
    // промежуток от «лёг» до «встал» (см. чек-ап). Если сон переходит через полночь (обычный
    // случай — лёг вечером, встал утром), рисуем двумя отрезками в одной колонке: сверху (до 24) и
    // снизу (от 0) — так «через полночь» не выглядит как перенос на соседний день.
    function drawSleepHoursChart(y, m, days) {
        const canvas = document.getElementById('month-sleep-chart');
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0) { setTimeout(() => drawSleepHoursChart(y, m, days), 60); return; }
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
        const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
        const w = rect.width, h = rect.height;
        const pad = { t: 8, r: 10, b: 16, l: 26 };
        const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
        ctx.clearRect(0, 0, w, h);

        // сетка по часам суток
        ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 1; ctx.fillStyle = '#bbb'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
        [0, 6, 12, 18, 24].forEach(hr => {
            const yy = pad.t + ih - (hr / 24) * ih;
            ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
            ctx.fillText(hr, pad.l - 4, yy + 3);
        });

        const hist = dashState.checkinHistory || {};
        const xAt = d => pad.l + (days > 1 ? (d - 1) / (days - 1) * iw : iw / 2);
        const yAt = hr => pad.t + ih - (hr / 24) * ih;
        const parseHM = s => { if (!s) return null; const [hh, mm] = String(s).split(':').map(Number); return isNaN(hh) ? null : hh + (mm || 0) / 60; };
        const barW = Math.max(3, (iw / days) * 0.55);
        const drawSeg = (d, fromH, toH, color) => {
            const x = xAt(d) - barW / 2, y1 = yAt(fromH), y2 = yAt(toH);
            ctx.fillStyle = color;
            ctx.fillRect(x, Math.min(y1, y2), barW, Math.max(1, Math.abs(y2 - y1)));
        };
        for (let d = 1; d <= days; d++) {
            const rec = hist[fdt(y, m, d)]?.morning;
            if (!rec) continue;
            const sleepH = parseHM(rec.sleepTime), wakeH = parseHM(rec.wakeTime);
            if (sleepH == null || wakeH == null) continue;
            if (wakeH <= sleepH) { drawSeg(d, sleepH, 24, '#1e3a8a'); drawSeg(d, 0, wakeH, '#1e3a8a'); } // через полночь
            else drawSeg(d, sleepH, wakeH, '#1e3a8a');
            // Часы сна урывками (интервальный сон) — «добавить часы сна» в чек-апе, см.
            // index.html. Не привязаны к реальному времени наверняка, поэтому просто
            // достраиваем отрезок светлым цветом сразу после подъёма — показываем итоговое
            // количество сна за день, а не точное время дрёмы.
            const extra = parseFloat(rec.extraSleepHours);
            if (extra > 0) drawSeg(d, wakeH, Math.min(24, wakeH + extra), '#93c5fd');
        }
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
            el.innerHTML = `<div class="wheel-empty">Колесо жизни заполнится, когда привяжешь привычки к сферам — в настройках привычки (кнопка «⋯»).</div>`;
            return;
        }
        el.innerHTML = lifeWheelSVG(areaFractions(scope, y, m));
    }

    // =========================================
    //   PSYCHO MODE (числовые метрики)
    // =========================================
    const metricValue = id => { const day = dashState.metricLog[todayKey()]; return day ? day[id] : undefined; };
    function setMetricValue(id, val) {
        const k = todayKey();
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

    function setPsychoMode(on) {
        dashState.psychoMode = on;
        saveProgress();
        const t = document.getElementById('psycho-toggle');
        if (t) { t.classList.toggle('on', on); t.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        dashboardScreen.classList.toggle('psycho-invert', on); // инверсия цветов в режиме
        // «День» скрыт (см. HANDOFF.md §15) — Pro mode показывает переключатель «День»/«Месяц» во
        // вкладке «Задачи» (renderPsychoDay/renderPsychoMonth, см. renderMonthView).
        switchView('month');
    }

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

    // container — куда рендерить; при повторных внутренних вызовах (после каждого действия)
    // параметр можно не передавать — используется последний запомненный контейнер. Так один и тот
    // же рендер работает и из renderPsychoDay() (вкладка «Задачи», см. выше), и из старой (сейчас
    // недостижимой без FEATURES.dayTab, но не удалённой — см. HANDOFF.md про откат фич-флагов)
    // renderDayView(), без конфликта id между их разными контейнерами.
    let psychoMetricsList = null;
    function renderPsychoMetrics(container) {
        if (container) psychoMetricsList = container;
        const list = psychoMetricsList;
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

            const val = +metricValue(m.id) || 0;
            const target = metricTarget(m);
            const isLimit = m.type === 'limit';
            const over = isLimit && val > target;
            const pct = target > 0 ? Math.min(100, Math.round(val / target * 100)) : (val > 0 ? 100 : 0);
            row.innerHTML = `
                <div class="metric-top">
                    <span class="metric-name-wrap"><span class="metric-name" title="нажми, чтобы переименовать">${m.name}</span>${isLimit ? '<span class="metric-tag">лимит</span>' : ''}</span>
                    <span class="metric-val ${over ? 'over' : ''}"><b>${fmtNum(val)}</b> / ${fmtNum(target)} ${m.unit || ''}</span>
                </div>
                <div class="metric-bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>
                <div class="metric-actions">
                    <input type="number" class="metric-input" inputmode="decimal" placeholder="+ значение"${m.step ? ` step="${m.step}"` : ''}>
                    <button class="metric-add" type="button" aria-label="Добавить">＋</button>
                    <button class="metric-goal" type="button">${isLimit ? 'лимит' : 'цель'} ${fmtNum(target)}${m.unit ? ' ' + m.unit : ''}</button>
                    ${val ? '<button class="metric-reset" type="button">сброс</button>' : ''}
                    <button class="metric-del" type="button">удалить</button>
                </div>`;
            const input = row.querySelector('.metric-input');
            const add = () => {
                const v = parseFloat(String(input.value).replace(',', '.'));
                if (isNaN(v)) return;
                setMetricValue(m.id, Math.max(0, val + v));
                renderPsychoMetrics();
            };
            row.querySelector('.metric-add').addEventListener('click', add);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
            // Переименование — клик по названию превращает его в поле ввода; Enter/потеря
            // фокуса сохраняют, Esc отменяет. settled защищает от двойного срабатывания
            // (Esc пересобирает список → blur всё равно долетает до уже отсоединённого инпута).
            row.querySelector('.metric-name').addEventListener('click', () => {
                const nameSpan = row.querySelector('.metric-name');
                nameSpan.outerHTML = `<input type="text" class="metric-name-edit" value="${escAttr(m.name)}" maxlength="32">`;
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
                    <input type="number" class="goal-edit-input" value="${target}" min="0"${m.step ? ` step="${m.step}"` : ''}>
                    ${m.unit ? `<span class="goal-edit-unit">${m.unit}</span>` : ''}
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
            if (rb) rb.addEventListener('click', () => { setMetricValue(m.id, 0); renderPsychoMetrics(); });
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
                        <input type="number" class="pam-target" inputmode="decimal" placeholder="значение" min="0">
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
    const MEALS = [
        { id: 'breakfast', name: 'Завтрак' },
        { id: 'lunch',     name: 'Обед' },
        { id: 'dinner',    name: 'Ужин' }
    ];
    const escAttr = s => String(s == null ? '' : s).replace(/"/g, '&quot;');

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

    // null = сегодня (редактируемо); иначе 'YYYY-MM-DD' — просматриваем историю (только чтение).
    // Сама история питания по датам — фича Pro mode (см. HANDOFF.md §15), см. клик по history-btn-food.
    let currentFoodHistoryDate = null;

    function renderFood() {
        const root = document.getElementById('view-food');
        if (!root) return;
        if (!dashState.foodLog) dashState.foodLog = {};
        const tKey = todayKey();
        const isHistory = !!currentFoodHistoryDate;
        const viewDate = currentFoodHistoryDate || tKey;
        const dayRec = dashState.foodLog[viewDate] || {};
        const isPro = !!window.hasActiveSubscription;

        // Три простые ячейки (не график с часовой осью, см. HANDOFF.md §15): сверху время приёма
        // (тот же кнопочный time-scroll-container, что и «во сколько лёг/встал» в чек-апе — см.
        // renderTimeScroll — вместо нативного <input type="time">), ниже — что съел.
        const cells = MEALS.map(meal => {
            const rec = dayRec[meal.id] || {};
            return `<div class="food-cell" data-meal="${meal.id}">
                <div class="food-cell-head">
                    <span class="food-meal-name">${meal.name}</span>
                </div>
                <div class="time-scroll-container food-time" data-meal="${meal.id}"></div>
                <input type="text" class="food-text" enterkeyhint="done" data-field="text" maxlength="60" placeholder="что кушал" value="${escAttr(rec.text)}">
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
            <div class="food-form${isHistory ? ' history-mode' : ''}" id="food-form">${cells}</div>
            ${isHistory ? '<button class="checkin-save-btn" id="back-to-today-food-btn">← Вернуться к сегодня</button>' : `
            <h3 class="dash-subtitle food-week-title">Эта неделя</h3>
            <div class="food-week" id="food-week"></div>`}`;
        updateDateLabel('food', isHistory ? viewDate : null);

        function setMealField(mealId, field, value) {
            if (!dashState.foodLog[tKey]) dashState.foodLog[tKey] = {};
            if (!dashState.foodLog[tKey][mealId]) dashState.foodLog[tKey][mealId] = {};
            dashState.foodLog[tKey][mealId][field] = value;
            const r = dashState.foodLog[tKey][mealId];
            if (!r.time && !r.text) delete dashState.foodLog[tKey][mealId];           // пустой приём — убрать
            if (!Object.keys(dashState.foodLog[tKey]).length) delete dashState.foodLog[tKey]; // пустой день — убрать
            saveProgress();
            renderFoodWeek();
        }

        // автосохранение по вводу (перерисовываем только недельный список, инпуты не трогаем) —
        // только для сегодняшнего дня; в history-режиме ячейки заблокированы (см. .food-form.history-mode).
        root.querySelectorAll('.food-cell').forEach(cellEl => {
            const mealId = cellEl.dataset.meal;
            const rec = dayRec[mealId] || {};
            if (isHistory) {
                renderTimeScroll(cellEl.querySelector('.food-time'), rec.time || ''); // без onSelect → заблокировано
                const textInput = cellEl.querySelector('.food-text');
                textInput.disabled = true;
                textInput.readOnly = true;
            } else {
                renderTimeScroll(cellEl.querySelector('.food-time'), rec.time || '', (label) => setMealField(mealId, 'time', label));
                const textInput = cellEl.querySelector('.food-text');
                textInput.addEventListener('input', (e) => setMealField(mealId, 'text', e.target.value));
                // Кнопка «Готово»/«Done» на мобильной клавиатуре — скрываем клавиатуру, значение уже
                // сохранено по input выше.
                textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); textInput.blur(); } });
            }
        });
        if (!isHistory) renderFoodWeek();

        const backBtn = document.getElementById('back-to-today-food-btn');
        if (backBtn) backBtn.addEventListener('click', () => { currentFoodHistoryDate = null; renderFood(); });

        const historyBtn = document.getElementById('history-btn-food');
        if (historyBtn) historyBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!isPro) { if (typeof openProModePaywall === 'function') openProModePaywall(); return; }
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
            const meals = MEALS.map(m => ({ name: m.name, time: (rec[m.id] || {}).time, text: (rec[m.id] || {}).text }))
                               .filter(m => m.time || m.text);
            const chips = meals.slice().sort((a, b) => (a.time || '99').localeCompare(b.time || '99'))
                .map(m => `<span class="fw-chip">${m.time ? `<b>${m.time}</b> ` : ''}${m.text || m.name}</span>`).join('');
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
                <div class="cal-habit-title">${habit.text}</div>
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
        { text: 'Привет! Это трекер привычек и твоего состояния. 14 дней — бесплатно, дальше нужна подписка (либо бесплатные недели за приглашённых друзей). Покажу за минуту, что где.' },
        { target: () => document.getElementById('help-btn'), text: 'Этот значок открывает тур заново в любой момент, если что-то забудешь.' },
        { target: () => document.getElementById('profile-btn'), text: 'Кнопка профиля — там твой ID, статус подписки, правила скидки и бонусных недель за друзей. Добавляй друзей и смотри их успехи.' },
        { target: () => document.querySelector('#top-nav-slot .day-nav-row'), taskViewMode: 'day', text: 'Стрелками листаешь дни вперёд-назад, календарь справа — прыжок на любую дату.' },
        { target: () => document.querySelector('.task-day-row'), taskViewMode: 'day', text: 'Нажми на привычку, чтобы отметить её — текст перечеркнётся, а огонёк рядом покажет серию дней подряд.', requiresHabits: true },
        { target: () => document.querySelector('.task-day-settings'), taskViewMode: 'day', text: 'Кнопка «⋯» — переименовать привычку, поставить напоминание, привязать к сфере жизни и удалить.', requiresHabits: true },
        { target: () => document.getElementById('new-habit-input-day') || document.querySelector('.dash-habit-limit'), taskViewMode: 'day', text: 'Список — твой. Удали лишнее через «⋯», и появится поле, чтобы добавить свою привычку (до 10).' },
        { target: () => document.querySelector('.day-fields-row'), taskViewMode: 'day', text: '«Событие дня» и «Задача дня» — быстрые заметки на выбранный день, тоже с перечёркиванием.' },
        { target: () => document.querySelector('.dm-toggle'), taskViewMode: 'day', text: 'Переключай на «Месяц», чтобы увидеть прогресс за месяц и историю по дням.' },
        { target: () => document.querySelector('.hm-row-head'), taskViewMode: 'month', text: 'Нажми на привычку — откроется календарь, где отмечены выполненные дни. Можно поправить и задним числом.', requiresHabits: true },
        { target: () => document.getElementById('life-wheel-month'), taskViewMode: 'month', text: 'Привяжи привычки к сферам жизни (в «⋯») — колесо заполнится и покажет баланс.' },
        { target: () => document.getElementById('psycho-toggle'), text: 'Pro mode — числовые показатели дня (км, сон, кофе…) вместо списка привычек. Доступно только по платной подписке (не по бесплатным дням).', feature: 'psychoMode' },
        { target: () => document.querySelector('.view-btn[data-view="training"]'), text: 'Игры — мини-игры, разблокируются по мере роста уровня.', feature: 'games' },
        { target: () => document.getElementById('btn-morning'), text: 'Чек-ап — сон, настроение, энергия и здоровье шкалами 1–10, плюс графики за месяц.' },
        { target: () => document.getElementById('btn-evening'), text: 'Вечер — итог дня, благодарность и что улучшить завтра.', feature: 'legacyCheckinFields' },
        { target: () => document.getElementById('btn-food'), text: 'Питание — дневник завтрака/обеда/ужина и сводка за неделю.' }
        // «Питомец» (.view-btn[data-view="pet"]) в тур не включён — кнопка скрыта насовсем через
        // CSS (display:none, см. habbittracker.css), это не активная фича, а не флаг вроде games/
        // legacyCheckinFields, которые можно было бы просто прогейтить через FEATURES.
    ];

    const VIEW_HINTS = {
        month:   'В «Месяце» — прогресс за месяц по каждой привычке. Нажми на привычку, чтобы открыть календарь и отметить любой день, включая задний числом.',
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
    function openHabitSettings(index) {
        currentEditIndex = index;
        const habit = dashState.habits[index];
        const modal = document.getElementById('habit-settings-modal');
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
        // сферы колеса жизни (мультивыбор)
        const areasBox = document.getElementById('setting-areas');
        if (areasBox) {
            areasBox.innerHTML = LIFE_AREAS.map(a => `<button type="button" class="area-chip${(habit.areas || []).includes(a.id) ? ' sel' : ''}" data-area="${a.id}">${a.name}</button>`).join('');
            areasBox.querySelectorAll('.area-chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('sel')));
        }
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
        const close = () => { modal.classList.remove('active'); currentEditIndex = null; };
        saveBtn.addEventListener('click', () => { saveSettings(); close(); });
        cancelBtn.addEventListener('click', close);
        closeBtn.addEventListener('click', close);
        delBtn.addEventListener('click', () => {
            if (currentEditIndex === null) return;
            const idx = currentEditIndex;          // фиксируем: confirmDialog асинхронный
            const h = dashState.habits[idx];
            confirmDialog(`Удалить привычку «${h.text}»?`, () => {
                // подчищаем историю удаляемой привычки
                Object.keys(dashState.history || {}).forEach(d => {
                    if (dashState.history[d][h.uid]) {
                        delete dashState.history[d][h.uid];
                        if (!Object.keys(dashState.history[d]).length) delete dashState.history[d];
                    }
                });
                dashState.habits.splice(idx, 1);
                saveProgress(); renderDashboardHabits();
                close(); // закрываем модалку настроек привычки
            });
        });
        document.querySelector('#setting-reminder-toggle').addEventListener('change', (e) => { timeInput.disabled = !e.target.checked; });
    }
    function saveSettings() {
        if (currentEditIndex === null) return;
        const nameInput = document.getElementById('setting-name-input');
        const name = nameInput ? nameInput.value.trim() : '';
        if (name) dashState.habits[currentEditIndex].text = name;
        dashState.habits[currentEditIndex].triggerText = document.getElementById('setting-trigger-input').value.trim();
        dashState.habits[currentEditIndex].reminderTime = document.getElementById('setting-reminder-toggle').checked ? document.getElementById('setting-time-input').value : null;
        const areasBox = document.getElementById('setting-areas');
        if (areasBox) dashState.habits[currentEditIndex].areas = [...areasBox.querySelectorAll('.area-chip.sel')].map(c => c.dataset.area);
        saveProgress(); renderDashboardHabits();
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
        if (!dashState.habits) return;
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        dashState.habits.forEach(habit => {
            if (!habit.completed && habit.reminderTime === currentTime) {
                showReminderToast(habit); playReminderSound();
            }
        });
    }
    function showReminderToast(habit) {
        document.querySelectorAll('.reminder-toast').forEach(t => t.remove());
        const toast = document.createElement('div'); toast.className = 'reminder-toast';
        toast.innerHTML = `<span class="toast-icon">🔔</span><div><strong>Время действовать</strong><p>${habit.text}</p>${habit.triggerText ? `<small>Привязка: ${habit.triggerText}</small>` : ''}</div><button class="toast-close">✕</button>`;
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

    // === ИГРЫ: МЕНЮ ===
    function initTrainingMenu() {
        const container = document.getElementById('training-games-container');
        if (!container) return;
        checkGameUnlock(); // если есть невыбранная разблокировка — предложить выбор
        const cards = GAME_ORDER.map(g => {
            const unlocked = dashState.unlockedGames.includes(g);
            return `<div class="training-card${unlocked ? '' : ' locked'}" data-game="${unlocked ? g : ''}">
                <span class="training-name">${GAMES[g].name}</span>
                <span class="training-desc">${unlocked ? GAMES[g].desc : 'Откроется с уровнем'}</span>
                ${unlocked ? '' : `<span class="training-lock">${LOCK}</span>`}
            </div>`;
        }).join('');
        const remaining = UNLOCK_LEVELS.filter(l => dashState.level < l).slice(0, lockedGames().length);
        const remainingStr = remaining.length > 1 ? remaining.slice(0, -1).join(', ') + ' и ' + remaining.slice(-1) : remaining[0];
        const hint = remaining.length ? `<div class="training-hint">Новые игры открываются на ур. ${remainingStr}</div>` : '';
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
            case 'memory': renderMemoryGame(container); break;
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
                cells += `<input class="sudoku-cell blank${edgeR}${edgeC}" inputmode="numeric" maxlength="1" data-key="${r}-${c}">`;
            } else {
                cells += `<div class="sudoku-cell given${edgeR}${edgeC}">${solution[r][c]}</div>`;
            }
        }

        container.innerHTML = `
            <div class="game-setup" style="text-align:center">
                <h3 class="dash-subtitle" style="margin-bottom:4px">Быстрое судоку</h3>
                <p class="training-desc" style="margin-bottom:14px">Заполни по одной пустой клетке в каждом квадрате</p>
                <div id="sudoku-grid">${cells}</div>
                <button class="training-btn primary" id="sudoku-check" style="margin-top:16px">Проверить</button>
            </div>
            <button class="training-back-btn" id="training-back">← Назад</button>`;

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
            const xp = 9;
            container.innerHTML = `<div class="training-result"><div class="training-result-title">Решено!</div><div class="training-result-message">Все 9 клеток верны</div><div class="training-xp-badge">+${xp} XP</div><div class="training-result-buttons"><button class="training-btn primary" id="retry-sudoku">Ещё раз</button><button class="training-btn secondary" id="menu-sudoku">В меню</button></div><button class="training-back-btn" id="back-sudoku">← Назад</button></div>`;
            document.getElementById('retry-sudoku').onclick = () => renderSudokuGame(container);
            document.getElementById('menu-sudoku').onclick = () => initTrainingMenu();
            document.getElementById('back-sudoku').onclick = () => initTrainingMenu();
            if (window.awardXP) window.awardXP(xp);
        };
        document.getElementById('training-back').onclick = () => initTrainingMenu();
    }

    function stopTrainingGame() {
        if (trainingGameInterval) { clearInterval(trainingGameInterval); trainingGameInterval = null; }
    }

    function renderCountGame(container) {
        container.innerHTML = `
            <div class="game-setup" id="count-setup"><h3 style="margin-bottom:15px">Выбери сложность</h3><button class="difficulty-btn" data-diff="1">1-9</button><button class="difficulty-btn" data-diff="2">10-99</button><button class="difficulty-btn" data-diff="3">100-999</button></div>
            <div class="game-area" id="count-area" style="display:none"><div class="game-timer" id="count-timer">60</div><div class="game-equation" id="count-equation"></div><input type="number" class="game-input" id="count-input" placeholder="?" autocomplete="off"></div>
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
            container.innerHTML = `<div class="training-result"><div class="training-result-title">Результат</div><div class="training-result-message">Правильных ответов: ${correct} из ${total}</div><div class="training-xp-badge">+${Math.max(1, Math.min(10, correct))} XP</div><div class="training-result-buttons"><button class="training-btn primary" id="retry-count">Ещё раз</button><button class="training-btn secondary" id="menu-count">В меню</button></div><button class="training-back-btn" id="back-count">← Назад</button></div>`;
            document.getElementById('retry-count').onclick = () => renderCountGame(container);
            document.getElementById('menu-count').onclick = () => initTrainingMenu();
            document.getElementById('back-count').onclick = () => initTrainingMenu();
            const earned = Math.max(1, Math.min(10, correct));
            if (window.awardXP) window.awardXP(earned);
        }
        document.querySelectorAll('#count-setup .difficulty-btn').forEach(btn => btn.addEventListener('click', (e) => start(parseInt(e.target.dataset.diff))));
        document.getElementById('count-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && currentEq) {
                const ans = parseInt(e.target.value);
                if (!isNaN(ans)) {
                    total++; const isCorrect = (ans === currentEq.result);
                    if (isCorrect) { correct++; document.getElementById('count-area').style.backgroundColor = '#e8f5e9'; }
                    else { document.getElementById('count-area').style.backgroundColor = '#ffebee'; }
                    setTimeout(() => { document.getElementById('count-area').style.backgroundColor = ''; }, 250);
                    showEq();
                }
            }
        });
        document.getElementById('training-back').onclick = () => initTrainingMenu();
        start(1);
    }

    function renderMemoryGame(container) {
        const allCardImages = ['Буби 2.png', 'Буби 3.png', 'Буби 4.png', 'Буби 5.png', 'Буби 6.png', 'Буби 7.png', 'Буби 8.png', 'Буби 9.png', 'Буби 10.png', 'Буби Валет.png', 'Буби Дама.png', 'Буби Король.png', 'Буби Туз.png', 'Пики 2.png', 'Пики 3.png', 'Пики 4.png', 'Пики 5.png', 'Пики 6.png', 'Пики 7.png', 'Пики 8.png', 'Пики 9.png', 'Пики 10.png', 'Пики Валет.png', 'Пики Дама.png', 'Пики Король.png', 'Пики Туз.png', 'Трефы 2.png', 'Трефы 3.png', 'Трефы 4.png', 'Трефы 5.png', 'Трефы 6.png', 'Трефы 7.png', 'Трефы 8.png', 'Трефы 9.png', 'Трефы 10.png', 'Трефы Валет.png', 'Трефы Дама.png', 'Трефы Король.png', 'Трефы Туз.png', 'Черви 2.png', 'Черви 3.png', 'Черви 4.png', 'Черви 5.png', 'Черви 6.png', 'Черви 7.png', 'Черви 8.png', 'Черви 9.png', 'Черви 10.png', 'Черви Валет.png', 'Черви Дама.png', 'Черви Король.png', 'Черви Туз.png'];
        const selectedImages = [...allCardImages].sort(() => Math.random() - 0.5).slice(0, 8);
        let cards = [], flipped = [], matchedPairs = 0, moves = 0, canFlip = true;
        container.innerHTML = `<div id="game-grid" style="grid-template-columns:repeat(4,1fr);gap:5px;width:100%;max-width:400px;margin:0 auto"></div><button class="training-back-btn" id="training-back">← Назад</button>`;
        const gameGrid = document.getElementById('game-grid');
        function createCards() { cards = [...selectedImages, ...selectedImages].map((img, i) => ({ id: i, img, flipped: false, matched: false })).sort(() => Math.random() - 0.5); }
        function render() {
            gameGrid.innerHTML = '';
            cards.forEach(card => {
                const el = document.createElement('div');
                el.className = `card${card.flipped || card.matched ? ' flipped' : ''}${card.matched ? ' matched' : ''}`;
                el.dataset.id = card.id;
                const back = document.createElement('div'); back.className = 'card-back'; back.innerHTML = '<span style="font-size:18px;color:#888">?</span>'; el.appendChild(back);
                const img = document.createElement('img'); img.src = `pics/${card.img}`; img.alt = ''; img.draggable = false;
                img.onerror = () => { img.src = 'image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23ddd" width="100" height="100"/></svg>'; };
                el.appendChild(img); el.addEventListener('click', () => flip(card.id)); gameGrid.appendChild(el);
            });
        }
        function flip(id) {
            if (!canFlip) return;
            const card = cards.find(c => c.id === id);
            if (flipped.length === 2 || card.flipped || card.matched) return;
            card.flipped = true; flipped.push(card); render();
            if (flipped.length === 2) {
                moves++; canFlip = false;
                setTimeout(() => {
                    if (flipped[0].img === flipped[1].img) {
                        flipped.forEach(c => { c.matched = true; c.flipped = false; }); matchedPairs++;
                        if (matchedPairs === 8) { clearInterval(trainingGameInterval); endGame(); }
                    } else { flipped.forEach(c => c.flipped = false); }
                    flipped = []; canFlip = true; render();
                }, 400);
            }
        }
        function endGame() {
            const xp = Math.max(1, Math.round(matchedPairs * 1.25));
            container.innerHTML = `<div class="training-result"><div class="training-result-title">Результат</div><div class="training-result-message">Пар найдено: ${matchedPairs} из 8</div><div class="training-xp-badge">+${xp} XP</div><div class="training-result-buttons"><button class="training-btn primary" id="retry-memory">Ещё раз</button><button class="training-btn secondary" id="menu-memory">В меню</button></div><button class="training-back-btn" id="back-memory">← Назад</button></div>`;
            document.getElementById('retry-memory').onclick = () => renderMemoryGame(container);
            document.getElementById('menu-memory').onclick = () => initTrainingMenu();
            document.getElementById('back-memory').onclick = () => initTrainingMenu();
            if (window.awardXP) window.awardXP(xp);
        }
        createCards(); render();
        document.getElementById('training-back').onclick = () => initTrainingMenu();
    }

    function renderWordsGame(container) {
        const allWords = ["яблоко", "машина", "дом", "книга", "ручка", "солнце", "вода", "дерево", "окно", "стул", "стол", "кошка", "собака", "цветок", "птица", "небо", "облако", "лес", "озеро", "река", "камень", "песок", "море", "снег", "дождь", "ветер", "луна", "звезда", "свет", "тень", "путь", "дверь", "замок", "ключ", "часы", "телефон", "ноутбук", "клавиатура", "мышь", "экран", "зеркало", "картина", "стена", "крыша", "крыло", "хвост", "лапа", "нос", "глаз", "рот", "ухо", "волос", "кожа", "платье", "рубашка", "ботинок", "сапог", "шляпа", "очки", "сумка", "портфель", "карандаш", "тетрадь", "доска", "мел", "сцена", "актер", "роль", "театр", "музыка", "песня", "танец", "праздник", "рождение", "день", "ночь", "сон", "мысль", "чувство", "ум", "сердце", "рука", "нога", "голова", "тело", "жизнь", "смерть", "время", "история", "мир", "война", "дружба", "любовь", "ненависть", "радость", "печаль", "страх", "надежда", "вера"];
        let targetWords = [], entered = [], memorizeTime = 15, guessTime = 45, phase = 'memorize';
        container.innerHTML = `<div class="game-timer" id="words-timer">${memorizeTime}</div><div id="words-display" style="margin:15px 0;font-size:16px"></div><div id="words-input-area" style="display:none"><input type="text" class="game-input" id="words-input" placeholder="Введи слово и нажми Enter" style="width:200px;margin:10px auto"><div class="word-placeholders" id="words-placeholders"></div></div><button class="training-back-btn" id="training-back">← Назад</button>`;
        function getRandomWords(n) { return [...allWords].sort(() => Math.random() - 0.5).slice(0, n); }
        function setupPlaceholders() {
            const c = document.getElementById('words-placeholders'); c.innerHTML = '';
            targetWords.forEach((_, i) => { const ph = document.createElement('div'); ph.className = 'word-placeholder'; ph.id = `ph-${i}`; c.appendChild(ph); });
        }
        function start() {
            targetWords = getRandomWords(8); entered = []; phase = 'memorize'; memorizeTime = 15;
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
            const xp = Math.max(1, correct);
            container.innerHTML = `<div class="training-result"><div class="training-result-title">Результат</div><div class="training-result-message">Угадано слов: ${correct} из 8</div><div class="training-xp-badge">+${xp} XP</div><div class="training-result-buttons"><button class="training-btn primary" id="retry-words">Ещё раз</button><button class="training-btn secondary" id="menu-words">В меню</button></div><button class="training-back-btn" id="back-words">← Назад</button></div>`;
            document.getElementById('retry-words').onclick = () => renderWordsGame(container);
            document.getElementById('menu-words').onclick = () => initTrainingMenu();
            document.getElementById('back-words').onclick = () => initTrainingMenu();
            if (window.awardXP) window.awardXP(xp);
        }
        document.getElementById('words-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && phase === 'guess') {
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

    function loadHistoryData(type, date) {
        const history = dashState.checkinHistory || {};
        const data = history[date]?.[type];
        
        if (!data) {
            alert('Нет данных за этот день');
            loadTodayData(type);
            return;
        }
    
        const form = document.getElementById(`${type}-form`);
        form.classList.add('history-mode'); // Включаем визуальный режим чтения
        
        // Блокируем шкалы
        form.querySelectorAll('.scale-container').forEach(container => {
            const key = container.dataset.key;
            const val = data[key] || 0;
            container.innerHTML = '';
            container.className = 'scale-container';
            
            for (let i = 1; i <= 10; i++) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `scale-btn ${i === val ? 'active' : ''}`;
                btn.textContent = i;
                btn.disabled = true; // Жёсткая блокировка
                container.appendChild(btn);
            }
        });
        form.querySelectorAll('.time-scroll-container').forEach(container => {
            renderTimeScroll(container, data[container.dataset.key] || '');
        });

        // Блокируем инпуты
        form.querySelectorAll('input').forEach(input => {
            const key = input.dataset.key;
            if (key) input.value = data[key] || '';
            input.disabled = true;
            input.readOnly = true;
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

    // === КНОПКИ ПЕРЕКЛЮЧЕНИЯ ===
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
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

    const dayTaskModal = document.getElementById('day-task-modal');
    const dayTaskInput = document.getElementById('day-task-input');
    function openDayTaskModal(dateKey) {
        if (!dayTaskModal || !dayTaskInput) return;
        dayModalTargetDate = dateKey || todayKey();
        dayTaskInput.value = ((dashState.dayTasks || {})[dayModalTargetDate] || {}).text || '';
        dayTaskModal.classList.add('active');
        setTimeout(() => dayTaskInput.focus(), 50);
    }
    function closeDayTaskModal() {
        if (dayTaskModal) dayTaskModal.classList.remove('active');
    }
    const dayTaskCloseBtn = document.getElementById('day-task-close');
    if (dayTaskCloseBtn) dayTaskCloseBtn.addEventListener('click', closeDayTaskModal);
    if (dayTaskModal) dayTaskModal.addEventListener('click', (e) => { if (e.target === dayTaskModal) closeDayTaskModal(); });
    if (dayTaskInput) dayTaskInput.addEventListener('input', () => {
        if (!dashState.dayTasks) dashState.dayTasks = {};
        const text = dayTaskInput.value.trim();
        const prev = dashState.dayTasks[dayModalTargetDate];
        if (text) dashState.dayTasks[dayModalTargetDate] = { text, done: (prev && prev.done) || false };
        else delete dashState.dayTasks[dayModalTargetDate];
        saveProgress();
        if (onDayFieldsChanged) onDayFieldsChanged();
    });
    if (dayTaskInput) dayTaskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); closeDayTaskModal(); } });

    // Рендерит «Событие дня» (текст) и «Задача дня» (текст + чекбокс) для конкретного dateKey —
    // вызывается из Дня и normal-mode, и Pro mode (см. renderTaskDayView/renderPsychoDay). onChange
    // регистрируется в onDayFieldsChanged, чтобы автосохранение из модалок обновляло именно этот блок.
    function renderDayEventAndTask(container, dateKey, onChange) {
        if (!container) return;
        onDayFieldsChanged = onChange;
        const eventText = (dashState.dayEvents || {})[dateKey] || '';
        const task = (dashState.dayTasks || {})[dateKey] || null;
        container.innerHTML = `
            <div class="day-fields-row">
                <button type="button" class="day-event-btn" id="open-day-event-btn">Событие дня</button>
                <button type="button" class="day-event-btn" id="open-day-task-btn">Задача дня</button>
            </div>
            ${eventText ? `<div class="day-event-display show">${eventText}</div>` : ''}
            ${task ? `<div class="day-task-row${task.done ? ' done' : ''}" id="day-task-toggle"><span class="day-task-text">Задача дня: ${task.text}</span></div>` : ''}`;
        document.getElementById('open-day-event-btn').addEventListener('click', () => openDayEventModal(dateKey));
        document.getElementById('open-day-task-btn').addEventListener('click', () => openDayTaskModal(dateKey));
        const taskToggle = document.getElementById('day-task-toggle');
        if (taskToggle) taskToggle.addEventListener('click', () => {
            if (!dashState.dayTasks || !dashState.dayTasks[dateKey]) return;
            dashState.dayTasks[dateKey].done = !dashState.dayTasks[dateKey].done;
            saveProgress();
            renderDayEventAndTask(container, dateKey, onChange);
        });
    }

    // === ТУМБЛЕР PRO MODE (бывший psycho mode) — под замком подписки, см. HANDOFF.md §15 ===
    const promodeLockIcon = document.getElementById('promode-lock-icon');
    if (promodeLockIcon) promodeLockIcon.innerHTML = LOCK;
    const psychoToggleEl = document.getElementById('psycho-toggle');
    if (psychoToggleEl) psychoToggleEl.addEventListener('click', () => {
        if (window.hasActiveSubscription) { setPsychoMode(!dashState.psychoMode); return; }
        openProModePaywall();
    });
    function openProModePaywall() {
        const m = document.getElementById('promode-paywall-modal');
        if (m) m.classList.add('active');
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

    // === ЗАПУСК ===
    init();
});
