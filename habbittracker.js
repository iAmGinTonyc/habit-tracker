window.selectedIdentity = null;

document.addEventListener('DOMContentLoaded', () => {
    // === ЭЛЕМЕНТЫ ===
    const introScreen = document.getElementById('intro-screen');
    const introText = document.getElementById('intro-text');
    const dashboardScreen = document.getElementById('dashboard-screen');
    const resetBtn = document.getElementById('reset-btn');
    const loadingOverlay = document.getElementById('loading-overlay');

    const phrases = [
        "Повторение — это не рутина. Это ритм, в котором рождается мастерство.",
        "Ты не становишься кем-то за один день. Каждое действие — это голос за того, кем ты хочешь стать.",
        "Дисциплина — это не ограничение свободы. Это путь к ней."
    ];

    // === ПЕРЕМЕННЫЕ СОСТОЯНИЯ ===
    let phraseInterval = null;
    let currentPhraseIndex = 0;
    let isTransitioning = false;
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
    const DEFAULT_HABITS = ['Подъём до 6 утра', 'Книга', 'Тренировка'];
    const MAX_HABITS = 10;

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

    function createDefaultState() {
        return {
            level: 1,
            currentXP: 0,
            habits: DEFAULT_HABITS.map(text => ({ text, completed: false, uid: newUid(), areas: [] })),
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
            seenHints: {}
        };
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
        } else {
            introScreen.style.opacity = '1'; // статичный текст-интро, фразы больше не сменяются
        }
    }

    // === ИНТРО И ПЕРЕХОДЫ ===
    function changePhrase() {
        if (isTransitioning) return;
        isTransitioning = true;
        introText.classList.add('fade-out');
        setTimeout(() => {
            currentPhraseIndex = (currentPhraseIndex + 1) % phrases.length;
            introText.textContent = phrases[currentPhraseIndex];
            introText.classList.remove('fade-out');
            isTransitioning = false;
        }, 1500);
    }

    introScreen.addEventListener('click', () => {
        clearInterval(phraseInterval);
        loadingOverlay.classList.add('active');
        setTimeout(() => {
            introScreen.style.opacity = '0';
            setTimeout(() => {
                introScreen.style.display = 'none';
                loadingOverlay.classList.remove('active');
                dashState = createDefaultState(); // первый запуск — дефолтные привычки
                window.dashState = dashState;
                saveProgress();
                showDashboard(); // тап → «День»
            }, 500);
        }, 1500);
    });

    // Экран выбора идентичности и эволюции удалён — приложение сразу ведёт на «День».

    // === ПЕРЕКЛЮЧЕНИЕ ВИДОВ ===
    function switchView(viewName) {
        console.log('🔄 switchView:', viewName);
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
        else if (viewName === 'morning' || viewName === 'evening') initCheckins(viewName);
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
        updateDashDate();
        const pt = document.getElementById('psycho-toggle');
        if (pt) { pt.classList.toggle('on', !!dashState.psychoMode); pt.setAttribute('aria-pressed', dashState.psychoMode ? 'true' : 'false'); }
        dashboardScreen.classList.toggle('psycho-invert', !!dashState.psychoMode);
        switchView('habits');
        updateProgressUI();
        startReminderChecker();
        updateCheckinButtonPulse();
        initHistoryLogic();
        updatePetRoamer(); // десктоп: запустить «бегающего» питомца
        if (!dashState.onboardingDone) setTimeout(() => startTour(DAY_TOUR), 700); // новый пользователь — вводный тур
    }

    function updateDashDate() {
        const el = document.getElementById('dash-date');
        if (!el) return;
        const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
        const wd = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
        const d = new Date();
        el.textContent = `${d.getDate()} ${months[d.getMonth()]}, ${wd[d.getDay()]}`;
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
            add.innerHTML = `<input type="text" id="new-habit-input" maxlength="40" placeholder="+ добавить привычку">`;
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

    function updateProgressUI() {
        const stats = getLevelStats(dashState.level);
        const percent = Math.min(100, (dashState.currentXP / stats.xpNeeded) * 100);
        document.getElementById('progress-fill').style.width = `${percent}%`;
        document.getElementById('progress-text').textContent = `${dashState.currentXP} / ${stats.xpNeeded} XP`;
        document.getElementById('progress-percent').textContent = `${Math.round(percent)}%`;
        document.getElementById('dash-level-value').textContent = dashState.level;
    }

    resetBtn.addEventListener('click', () => {
        if (confirm('Сбросить прогресс?')) {
            localStorage.removeItem('habbittracker_progress');
            location.reload();
        }
    });

    // =========================================
    //   ВИД «МЕСЯЦ» — ИСТОРИЯ / ТЕПЛОВАЯ КАРТА
    // =========================================
    let monthCursor = null; // { y, m } — отображаемый месяц
    const MONTH_NAMES = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const WD_SHORT = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

    function renderMonthView() {
        const root = document.getElementById('view-month');
        if (!root) return;
        if (!monthCursor) { const t = new Date(); monthCursor = { y: t.getFullYear(), m: t.getMonth() }; }
        const { y, m } = monthCursor;
        if (dashState.psychoMode) { renderPsychoMonth(y, m); return; } // в psycho mode — сводка метрик
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

        root.innerHTML = `
            <div class="month-head">
                <button class="month-nav" id="month-prev">←</button>
                <span class="month-label">${MONTH_NAMES[m]} ${y}</span>
                <button class="month-nav" id="month-next">→</button>
            </div>
            <div class="month-summary">
                <div class="month-stat"><span>${st.done}</span>выполнено</div>
                <div class="month-stat"><span>${st.possible}</span>возможно</div>
                <div class="month-stat"><span>${st.pct}%</span>прогресс</div>
            </div>
            <div class="month-progress"><div class="month-progress-fill" style="width:${st.pct}%"></div></div>
            <div class="month-hint">клик по клетке — отметить день · сегодня выделено рамкой</div>
            ${habits.length ? `<div class="heatmap" id="heatmap"></div>` : `<p class="month-empty">Пока нет привычек — добавь их во вкладке «Привычки».</p>`}
            <div class="month-wheel-block">
                <div id="life-wheel-month"></div>
            </div>
            <div class="month-chart-block">
                <div class="month-chart-title">Настроение и качество сна</div>
                <canvas id="month-ms-chart" width="600" height="150"></canvas>
                <div class="month-legend"><span class="lg lg-mood">● Настроение</span><span class="lg lg-sleep">● Качество сна</span></div>
            </div>
        `;
        renderLifeWheel('month', 'life-wheel-month', y, m);

        const hm = document.getElementById('heatmap');
        if (hm) {
            habits.forEach(h => {
                const streak = currentStreak(h.uid);
                const monthDone = dayList.filter(d => isDone(h.uid, fdt(y, m, d))).length;
                const cells = dayList.map(d => {
                    const k = fdt(y, m, d);
                    const done = isDone(h.uid, k);
                    const future = k > tKey;
                    const wd = WD_SHORT[new Date(y, m, d).getDay()];
                    return `<div class="hm-cell${done ? ' done' : ''}${k === tKey ? ' today' : ''}${future ? ' future' : ''}" data-uid="${h.uid}" data-key="${k}" title="${d} ${MONTH_NAMES[m]} — ${done ? 'выполнено' : 'нет'}"><span class="hm-wd">${wd}</span></div>`;
                }).join('');
                const rowEl = document.createElement('div');
                rowEl.className = 'hm-row';
                rowEl.innerHTML = `
                    <div class="hm-row-head">
                        <span class="hm-label" title="${h.text}">${h.text}</span>
                        <span class="hm-meta">${streak > 0 ? `<span class="hm-streak">${FLAME}${streak}</span>` : ''}<span class="hm-count">${monthDone}/${days}</span></span>
                    </div>
                    <div class="hm-cells" style="grid-template-columns:repeat(${days},1fr)">${cells}</div>`;
                hm.appendChild(rowEl);
            });

            // редактирование задним числом (делегирование, без полного ре-рендера)
            hm.onclick = (e) => {
                const cell = e.target.closest('.hm-cell');
                if (!cell || cell.classList.contains('future')) return;
                const uid = cell.dataset.uid, key = cell.dataset.key;
                const now = !isDone(uid, key);
                setHistory(uid, key, now);
                cell.classList.toggle('done', now);
                // если правим сегодня — синхронизируем с дашбордом И начисляем XP (как toggleHabit:
                // один раз в день, без фарма, общий habit.xpDate с «Днём»). За прошлые дни XP НЕ даём.
                if (key === tKey) {
                    const h = habits.find(x => x.uid === uid);
                    if (h) {
                        h.completed = now;
                        if (now && h.xpDate !== todayKey()) { h.xpDate = todayKey(); awardXP(getLevelStats(dashState.level).xpPerHabit); }
                    }
                }
                saveProgress();
                // точечно обновляем мету строки и сводку месяца
                const rowEl = cell.closest('.hm-row');
                const md = dayList.filter(d => isDone(uid, fdt(y, m, d))).length;
                const s = currentStreak(uid);
                rowEl.querySelector('.hm-meta').innerHTML = `${s > 0 ? `<span class="hm-streak">${FLAME}${s}</span>` : ''}<span class="hm-count">${md}/${days}</span>`;
                const s2 = monthStats();
                const stats = root.querySelectorAll('.month-stat span');
                stats[0].textContent = s2.done; stats[1].textContent = s2.possible; stats[2].textContent = `${s2.pct}%`;
                root.querySelector('.month-progress-fill').style.width = `${s2.pct}%`;
            };
        }

        document.getElementById('month-prev').onclick = () => { if (--monthCursor.m < 0) { monthCursor.m = 11; monthCursor.y--; } renderMonthView(); };
        document.getElementById('month-next').onclick = () => { if (++monthCursor.m > 11) { monthCursor.m = 0; monthCursor.y++; } renderMonthView(); };

        drawMonthMoodSleep(y, m, days);
    }

    // Сводка метрик за календарный месяц (psycho mode)
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
        root.innerHTML = `
            <div class="month-head">
                <button class="month-nav" id="month-prev">←</button>
                <span class="month-label">${MONTH_NAMES[m]} ${y}</span>
                <button class="month-nav" id="month-next">→</button>
            </div>
            <div class="month-hint">сумма за месяц · цель = дневная × ${days} дн.</div>
            <div class="pm-list">${rows}</div>`;
        document.getElementById('month-prev').onclick = () => { if (--monthCursor.m < 0) { monthCursor.m = 11; monthCursor.y--; } renderMonthView(); };
        document.getElementById('month-next').onclick = () => { if (++monthCursor.m > 11) { monthCursor.m = 0; monthCursor.y++; } renderMonthView(); };
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
        renderDayView();
        switchView('habits');
    }

    function renderDayView() {
        const normal = document.getElementById('day-normal');
        const psycho = document.getElementById('day-psycho');
        if (normal && psycho) {
            normal.style.display = dashState.psychoMode ? 'none' : 'block';
            psycho.style.display = dashState.psychoMode ? 'block' : 'none';
        }
        if (dashState.psychoMode) renderPsychoMetrics();
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

    function renderPsychoMetrics() {
        const list = document.getElementById('psycho-list');
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
                    <span class="metric-name">${m.name}${isLimit ? '<span class="metric-tag">лимит</span>' : ''}</span>
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
    const FOOD_START = 5 * 60, FOOD_END = 24 * 60; // ось времени недельного графика: 5:00 .. 24:00
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
    // 'HH:MM' → процент позиции на оси времени (или null, если времени нет)
    function timeToPct(t) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
        if (!m) return null;
        const mins = (+m[1]) * 60 + (+m[2]);
        return Math.max(0, Math.min(100, (mins - FOOD_START) / (FOOD_END - FOOD_START) * 100));
    }

    function renderFood() {
        const root = document.getElementById('view-food');
        if (!root) return;
        if (!dashState.foodLog) dashState.foodLog = {};
        const tKey = todayKey();
        const today = dashState.foodLog[tKey] || {};
        const rows = MEALS.map(meal => {
            const rec = today[meal.id] || {};
            return `<div class="food-row" data-meal="${meal.id}">
                <span class="food-meal-name">${meal.name}</span>
                <input type="time" class="food-time" data-field="time" value="${escAttr(rec.time)}">
                <input type="text" class="food-text" data-field="text" maxlength="60" placeholder="что кушал" value="${escAttr(rec.text)}">
            </div>`;
        }).join('');
        root.innerHTML = `
            <h3 class="dash-subtitle">Питание сегодня</h3>
            <div class="food-form">${rows}</div>
            <h3 class="dash-subtitle food-week-title">Эта неделя</h3>
            <div class="food-week" id="food-week"></div>`;

        // автосохранение по вводу (перерисовываем только недельный график, инпуты не трогаем)
        root.querySelectorAll('.food-row').forEach(rowEl => {
            const mealId = rowEl.dataset.meal;
            rowEl.querySelectorAll('input').forEach(inp => {
                inp.addEventListener('input', () => {
                    if (!dashState.foodLog[tKey]) dashState.foodLog[tKey] = {};
                    if (!dashState.foodLog[tKey][mealId]) dashState.foodLog[tKey][mealId] = {};
                    dashState.foodLog[tKey][mealId][inp.dataset.field] = inp.value;
                    const r = dashState.foodLog[tKey][mealId];
                    if (!r.time && !r.text) delete dashState.foodLog[tKey][mealId];           // пустой приём — убрать
                    if (!Object.keys(dashState.foodLog[tKey]).length) delete dashState.foodLog[tKey]; // пустой день — убрать
                    saveProgress();
                    renderFoodWeek();
                });
            });
        });
        renderFoodWeek();
    }

    function renderFoodWeek() {
        const wk = document.getElementById('food-week');
        if (!wk) return;
        const days = weekDates();
        const axisRow = `<div class="fw-row fw-axis-row"><span class="fw-day"></span><div class="fw-body"><div class="fw-axis"><span style="left:0%">5:00</span><span style="left:36.8%">12:00</span><span style="left:68.4%">18:00</span><span style="left:100%">24:00</span></div></div></div>`;
        const rows = days.map(day => {
            const rec = (dashState.foodLog || {})[day.key] || {};
            const meals = MEALS.map(m => ({ name: m.name, time: (rec[m.id] || {}).time, text: (rec[m.id] || {}).text }))
                               .filter(m => m.time || m.text);
            const dots = meals.map(m => {
                const pct = timeToPct(m.time);
                if (pct === null) return '';
                return `<i class="fw-dot" style="left:${pct}%" title="${escAttr(m.name + ': ' + (m.time || '') + ' ' + (m.text || ''))}"></i>`;
            }).join('');
            const chips = meals.slice().sort((a, b) => (a.time || '99').localeCompare(b.time || '99'))
                .map(m => `<span class="fw-chip">${m.time ? `<b>${m.time}</b> ` : ''}${m.text || m.name}</span>`).join('');
            return `<div class="fw-row${day.isToday ? ' today' : ''}">
                <span class="fw-day">${day.wd}<small>${day.dayNum}</small></span>
                <div class="fw-body">
                    <div class="fw-track">${dots}</div>
                    <div class="fw-meals">${chips || '<span class="fw-empty">нет записей</span>'}</div>
                </div>
            </div>`;
        }).join('');
        wk.innerHTML = axisRow + rows;
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
    const DAY_TOUR = [
        { text: 'Привет! Это трекер привычек и твоего состояния. Покажу за 20 секунд, что где.' },
        { target: () => document.querySelector('.dash-habit-row .habit-check'), text: 'Нажимай по квадрату, чтобы отметить привычку за день. За регулярность копится серия.' },
        { target: () => document.querySelector('.dash-habit-row .habit-settings-icon'), text: 'Кнопка «⋯» — переименовать привычку, поставить напоминание, привязать к сфере жизни и удалить.' },
        { target: () => document.getElementById('new-habit-input') || document.querySelector('.dash-habit-limit') || document.getElementById('dash-habit-list'), text: 'Список — твой. Удали лишнее через «⋯», и появится поле, чтобы добавить свою привычку (до 10).' },
        { target: () => document.getElementById('life-wheel-day'), text: 'Привяжи привычки к сферам жизни (в «⋯») — колесо заполнится и покажет баланс.' },
        { target: () => document.getElementById('psycho-toggle'), text: 'Psycho mode — числовые показатели дня (км, сон, кофе…) вместо списка привычек.' },
        { target: () => document.querySelector('.view-switcher'), text: 'Месяц — история и графики. Игры — мини-игры за уровни. Утро и Вечер — чек-апы дня, Питание — дневник еды.' }
    ];

    const VIEW_HINTS = {
        month:   'История по дням: тёмная клетка — выполнено. Кликни по любому дню, чтобы отметить задним числом.',
        morning: 'Утренний чек-ап: во сколько лёг и встал, качество сна, настроение, фокус. Нажми «Сохранить» — данные пойдут в графики «Месяца».',
        evening: 'Вечерний чек-ап: оценка дня, за что благодарен и что улучшить завтра.'
    };

    let tourSteps = [], tourIdx = 0;
    function startTour(steps) {
        tourSteps = steps; tourIdx = 0;
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

    // === ЧЕКАПЫ ===
    function initCheckins(type) {
        console.log('🔍 initCheckins вызван для:', type);
        
        if (!dashState.checkins) dashState.checkins = { morning: {}, evening: {} };
        if (!dashState.checkins.morning) dashState.checkins.morning = {};
        if (!dashState.checkins.evening) dashState.checkins.evening = {};
        if (!dashState.checkinHistory) dashState.checkinHistory = {};
        
        // === ПРОВЕРКА: если уже сохранено за сегодня — блокируем форму ===
        const today = new Date().toISOString().split('T')[0];
        if (dashState.checkinHistory[today]?.[type]) {
            console.log(`✅ ${type} уже сохранён за сегодня, загружаем и блокируем`);
            setTimeout(() => lockFormAfterSave(type), 100);
            updateDateLabel(type, today);
            return;
        }
        // ================================================================
        
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
                        saveProgress();
                        updateCheckinButtonPulse();
                        checkSaveButtonState(prefix);
                    });
                    container.appendChild(btn);
                }
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
                    saveProgress();
                    updateCheckinButtonPulse();
                    checkSaveButtonState(prefix);
                });
            });
            
            initSaveButton(prefix);
            updateDateLabel(type, null);
            console.log('✅ initCheckins завершён');
        }, 150);
    }

    function initSaveButton(type) {
        const btn = document.getElementById(`save-${type}-btn`);
        const status = document.getElementById(`status-${type}`);
        if (!btn || !status) return;
        
        const today = new Date().toISOString().split('T')[0];
        const history = dashState.checkinHistory || {};
        const todayData = history[today];
        
        // Если мы в режиме истории, кнопку сохранения не показываем
        if (currentHistoryType === type) {
             btn.style.display = 'none';
             // Логика кнопки "Назад" обрабатывается в loadHistoryData
             return;
        }

        if (todayData && todayData[type] && Object.keys(todayData[type]).length > 0) {
            btn.classList.add('saved');
            btn.innerHTML = '✓ Сохранено';
            btn.disabled = true;
            status.textContent = 'Чек-ап сохранён';
            status.classList.add('show');
        } else {
            btn.classList.remove('saved');
            btn.innerHTML = 'Сохранить чек-ап';
            btn.disabled = false;
            status.classList.remove('show');
            btn.style.opacity = '0.5';
        }
        
        // Удаляем старую кнопку "Назад", если мы вернулись из истории
        const backBtn = document.getElementById('back-to-today-btn');
        if (backBtn) backBtn.remove();
        
        // Назначаем обработчик заново (на случай если он был удален клонированием)
        // Но лучше сделать один раз. Сделаем проверку.
        if (!btn.dataset.handlerAttached) {
            btn.onclick = () => saveCheckin(type);
            btn.dataset.handlerAttached = "true";
        }
    }

    function saveCheckin(type) {
        const today = new Date().toISOString().split('T')[0];
        if (!dashState.checkinHistory) dashState.checkinHistory = {};
        if (!dashState.checkinHistory[today]) dashState.checkinHistory[today] = {};
        
        const checkinData = JSON.parse(JSON.stringify(dashState.checkins[type] || {}));
        if (Object.keys(checkinData).length === 0) {
            alert('Заполни хотя бы одно поле перед сохранением!');
            return;
        }
        
        // Проверяем, было ли уже сохранено (чтобы не фармить XP)
        const wasAlreadySaved = !!dashState.checkinHistory[today][type];
        
        dashState.checkinHistory[today][type] = { ...checkinData, savedAt: new Date().toISOString() };
        
        // Начисляем XP только если это ПЕРВОЕ сохранение за сегодня
        if (!wasAlreadySaved) {
            const xpEarned = 3;
            dashState.currentXP += xpEarned;
            updateProgressUI();
        }
        
        saveProgress();
        
        const btn = document.getElementById(`save-${type}-btn`);
        const status = document.getElementById(`status-${type}`);
        const editBtn = document.getElementById(`edit-${type}-btn`);
        
        if (btn) {
            btn.classList.add('saved');
            btn.innerHTML = `✓ Сохранено`;
            btn.disabled = true;
            btn.style.transform = 'scale(1.05)';
            setTimeout(() => { btn.style.transform = ''; }, 200);
        }
        if (status) {
            status.textContent = wasAlreadySaved ? `Обновлено в ${today}` : `Сохранено в ${today}`;
            status.classList.add('show');
        }
        if (editBtn) {
            editBtn.style.display = 'inline-block';
            editBtn.onclick = () => enableEditing(type);
        }
        
        // Снова блокируем форму
        setTimeout(() => lockFormAfterSave(type), 100);
        
        updateCheckinButtonPulse();
    }

    function checkSaveButtonState(type) {
        const btn = document.getElementById(`save-${type}-btn`);
        if (!btn || btn.disabled) return;
        // Если мы в режиме истории, не трогаем прозрачность
        if (currentHistoryType === type) return;
        
        const checkinData = dashState.checkins[type] || {};
        const hasData = Object.keys(checkinData).some(key => checkinData[key] !== '');
        btn.style.opacity = hasData ? '1' : '0.5';
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
    
        // ✅ Аналитика через делегирование (работает всегда, независимо от перерисовок)
        document.addEventListener('click', (e) => {
            const analyticsBtn = e.target.closest('.checkin-analytics-btn');
            if (analyticsBtn) {
                const viewDiv = analyticsBtn.closest('.dash-view');
                if (viewDiv) {
                    const type = viewDiv.id.replace('view-', '');
                    openAnalytics(type);
                }
            }
        });
    }

    function loadTodayData(type) {
        const form = document.getElementById(`${type}-form`);
        if (form) form.classList.remove('history-mode');
        
        const dateInput = document.getElementById(`date-input-${type}`);
        if (dateInput) dateInput.value = '';
        
        const today = new Date().toISOString().split('T')[0];
        const isSaved = dashState.checkinHistory[today]?.[type];
        
        // === Если уже сохранено — сразу блокируем ===
        if (isSaved) {
            console.log(`🔒 ${type} за сегодня уже сохранён, блокируем`);
            setTimeout(() => lockFormAfterSave(type), 50);
            updateDateLabel(type, today);
            return;
        }
        // =========================================
        
        initCheckins(type);
        
        const btn = document.getElementById(`save-${type}-btn`);
        if (btn) btn.style.display = 'inline-block';
        
        updateDateLabel(type, null);
        
        const backBtn = document.getElementById('back-to-today-btn');
        if (backBtn) backBtn.remove();
    }

    function lockFormAfterSave(type) {
        const today = new Date().toISOString().split('T')[0];
        const savedData = dashState.checkinHistory[today]?.[type];
        
        if (!savedData) return; // Если нет сохранённых данных — не блокируем
        
        const form = document.getElementById(`${type}-form`);
        form.classList.add('history-mode');
        
        // Заполняем форму сохранёнными данными
        form.querySelectorAll('.scale-container').forEach(container => {
            const key = container.dataset.key;
            const val = savedData[key] || 0;
            container.innerHTML = '';
            container.className = 'scale-container';
            
            for (let i = 1; i <= 10; i++) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `scale-btn ${i === val ? 'active' : ''}`;
                btn.textContent = i;
                btn.disabled = true;
                container.appendChild(btn);
            }
        });
        
        form.querySelectorAll('input').forEach(input => {
            const key = input.dataset.key;
            if (key) input.value = savedData[key] || '';
            input.disabled = true;
            input.readOnly = true;
        });
        
        // Скрываем кнопку сохранения
        const saveBtn = document.getElementById(`save-${type}-btn`);
        if (saveBtn) saveBtn.style.display = 'none';
        
        // Показываем статус
        const status = document.getElementById(`status-${type}`);
        if (status) {
            status.textContent = 'Чек-ап сохранён';
            status.classList.add('show');
        }
        
        // === ПОКАЗЫВАЕМ КНОПКУ РЕДАКТИРОВАНИЯ ===
        const editBtn = document.getElementById(`edit-${type}-btn`);
        if (editBtn) {
            editBtn.style.display = 'inline-block';
            editBtn.onclick = () => enableEditing(type);
        }
        // =========================================
        
        // Обновляем метку даты
        updateDateLabel(type, today);
    }

    function enableEditing(type) {
        const form = document.getElementById(`${type}-form`);
        const today = new Date().toISOString().split('T')[0];
        
        // Загружаем сохранённые данные во временное хранилище
        const savedData = dashState.checkinHistory[today]?.[type] || {};
        dashState.checkins[type] = { ...savedData };
        
        form.classList.remove('history-mode');
        
        // UI обновления
        const editBtn = document.getElementById(`edit-${type}-btn`);
        const saveBtn = document.getElementById(`save-${type}-btn`);
        const status = document.getElementById(`status-${type}`);
        
        if (editBtn) editBtn.style.display = 'none';
        
        // === ИСПРАВЛЕНИЕ: Показываем кнопку и ВЕШАЕМ ОБРАБОТЧИК ===
        if (saveBtn) {
            saveBtn.style.display = 'inline-block';
            saveBtn.innerHTML = 'Обновить чек-ап';
            saveBtn.disabled = false;
            saveBtn.classList.remove('saved');
            // Явно назначаем функцию сохранения
            saveBtn.onclick = () => saveCheckin(type);
        }
        // =========================================
        
        if (status) status.classList.remove('show');
        
        // Перерисовываем интерактивные элементы
        setTimeout(() => {
            // Шкалы
            form.querySelectorAll('.scale-container').forEach(container => {
                const key = container.dataset.key;
                const val = dashState.checkins[type]?.[key] || 0;
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
                        dashState.checkins[type][key] = i;
                        saveProgress();
                    });
                    container.appendChild(btn);
                }
            });
            
            // Инпуты
            form.querySelectorAll('input').forEach(input => {
                const key = input.dataset.key;
                if (!key) return;
                input.value = dashState.checkins[type]?.[key] || '';
                input.disabled = false;
                input.readOnly = false;
                
                const newInput = input.cloneNode(true);
                input.parentNode.replaceChild(newInput, input);
                newInput.addEventListener('input', (e) => {
                    dashState.checkins[type][key] = e.target.value;
                    saveProgress();
                });
            });
        }, 50);
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
    
        // Блокируем инпуты
        form.querySelectorAll('input').forEach(input => {
            const key = input.dataset.key;
            if (key) input.value = data[key] || '';
            input.disabled = true;
            input.readOnly = true;
        });
    
        // Скрываем кнопку сохранения
        const saveBtn = document.getElementById(`save-${type}-btn`);
        if (saveBtn) saveBtn.style.display = 'none';
        
        updateDateLabel(type, date);

        // Кнопка возврата
        const oldBackBtn = document.getElementById('back-to-today-btn');
        if (oldBackBtn) oldBackBtn.remove();
        
        const backBtn = document.createElement('button');
        backBtn.className = 'checkin-save-btn';
        backBtn.id = 'back-to-today-btn';
        backBtn.innerHTML = '← Вернуться к сегодня';
        backBtn.onclick = () => loadTodayData(type);
        saveBtn.parentNode.appendChild(backBtn);
    }

    function openAnalytics(type) {
        console.log('📊 Opening analytics for:', type);
        
        let modal = document.getElementById('analytics-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'analytics-modal';
            modal.className = 'analytics-modal';
            document.body.appendChild(modal);
        }
        
        modal.innerHTML = `
            <div class="analytics-header">
                <h3>Аналитика</h3>
                <button class="analytics-close" id="analytics-close-btn">✕</button>
            </div>
            <div class="analytics-controls">
                <label>С:</label>
                <input type="date" id="analytics-start">
                <label>По:</label>
                <input type="date" id="analytics-end">
                <button class="checkin-save-btn" style="padding:6px 12px; font-size:12px;" id="analytics-build-btn">Построить</button>
            </div>
            <div id="charts-area"></div>
        `;
        
        modal.classList.add('active');
        
        const today = new Date();
        const weekAgo = new Date();
        weekAgo.setDate(today.getDate() - 7);
        
        document.getElementById('analytics-end').valueAsDate = today;
        document.getElementById('analytics-start').valueAsDate = weekAgo;
        
        // Обработчик закрытия
        document.getElementById('analytics-close-btn').onclick = closeAnalytics;
        
        // Обработчик построения
        document.getElementById('analytics-build-btn').onclick = () => renderCharts(type);
        
        // Строим сразу
        setTimeout(() => renderCharts(type), 100);
    }

    function closeAnalytics() {
        const modal = document.getElementById('analytics-modal');
        if (modal) modal.classList.remove('active');
    }

    function renderCharts(type) {
        const startDate = document.getElementById('analytics-start').value;
        const endDate = document.getElementById('analytics-end').value;
        if (!startDate || !endDate) return;
        
        const area = document.getElementById('charts-area');
        area.innerHTML = '<p style="color:#999;text-align:center">Генерация графиков...</p>';
        
        setTimeout(() => {
            area.innerHTML = '';
            const history = dashState.checkinHistory || {};
            
            // Порядок строго как в HTML-форме
            const metrics = type === 'morning' 
                ? ['sleepQuality', 'energy', 'mood'] 
                : ['dayRate', 'energy', 'satisfaction', 'calm', 'habitQuality'];
                
            // Названия точно как в вопросах
            const metricNames = {
                morning: {
                    sleepQuality: 'Качество сна',
                    energy: 'Уровень энергии утром',
                    mood: 'Настрой / Мотивация'
                },
                evening: {
                    dayRate: 'Общая оценка дня',
                    energy: 'Уровень энергии сейчас',
                    satisfaction: 'Удовлетворённость результатами',
                    calm: 'Уровень спокойствия',
                    habitQuality: 'Качество выполнения привычек'
                }
            };
            
            metrics.forEach(key => {
                const container = document.createElement('div');
                container.className = 'chart-container';
                const title = metricNames[type]?.[key] || key;
                container.innerHTML = `<div class="chart-title">${title}</div><canvas id="chart-${key}" width="600" height="200"></canvas>`;
                area.appendChild(container);
                
                const dataPoints = [];
                const labels = [];
                const d = new Date(startDate);
                const end = new Date(endDate);
                
                while (d <= end) {
                    const dateStr = d.toISOString().split('T')[0];
                    const dayData = history[dateStr]?.[type];
                    if (dayData && dayData[key]) {
                        dataPoints.push(dayData[key]);
                        labels.push(d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' }));
                    }
                    d.setDate(d.getDate() + 1);
                }
                
                if (dataPoints.length > 0) {
                    drawLineChart(`chart-${key}`, labels, dataPoints, '#111');
                } else {
                    container.innerHTML += '<p style="color:#999;text-align:center;font-size:12px">Нет данных</p>';
                }
            });
        }, 50);
    }

    function drawLineChart(canvasId, labels, data, color) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || data.length === 0) return;
        
        // Для четкости на Retina дисплеях
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        
        const w = rect.width;
        const h = rect.height;
        const padding = { top: 10, right: 10, bottom: 25, left: 25 };
        
        // Очистка
        ctx.clearRect(0, 0, w, h);
        
        const maxVal = 10;
        // Если данных мало, отступы больше, чтобы точка была по центру
        const xStep = labels.length > 1 ? (w - padding.left - padding.right) / (labels.length - 1) : (w - padding.left - padding.right);
        const yScale = (h - padding.top - padding.bottom) / maxVal;
        
        // --- Сетка (Очень тонкая) ---
        ctx.beginPath();
        ctx.strokeStyle = '#f0f0f0';
        ctx.lineWidth = 1;
        // Горизонтальные линии (5 и 10)
        const lines = [5, 10];
        lines.forEach(val => {
            const y = h - padding.bottom - (val * yScale);
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
        });
        ctx.stroke();
        
        // --- Линия графика ---
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        
        data.forEach((val, i) => {
            const x = padding.left + i * xStep;
            const y = h - padding.bottom - (val * yScale);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
        
        // --- Точки ---
        data.forEach((val, i) => {
            const x = padding.left + i * xStep;
            const y = h - padding.bottom - (val * yScale);
            
            ctx.beginPath();
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.arc(x, y, 3, 0, Math.PI * 2); // Маленькие точки (радиус 3)
            ctx.fill();
            ctx.stroke();
            
            // Значение над точкой
            ctx.fillStyle = '#111';
            ctx.font = '600 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(val, x, y - 8);
        });
        
        // --- Ось X (Даты) ---
        ctx.fillStyle = '#999';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        // Рисуем даты, но не слишком часто
        const step = Math.ceil(labels.length / 7); 
        labels.forEach((label, i) => {
            if (i % step === 0 || i === labels.length - 1) {
                const x = padding.left + i * xStep;
                ctx.fillText(label, x, h - 5);
            }
        });
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

    // === ТУМБЛЕР PSYCHO MODE ===
    const psychoToggleEl = document.getElementById('psycho-toggle');
    if (psychoToggleEl) psychoToggleEl.addEventListener('click', () => setPsychoMode(!dashState.psychoMode));

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
    if (helpBtn) helpBtn.addEventListener('click', () => { if (dashState.psychoMode) setPsychoMode(false); switchView('habits'); setTimeout(() => startTour(DAY_TOUR), 200); });
    const hintClose = document.getElementById('onb-hint-close');
    if (hintClose) hintClose.addEventListener('click', () => { document.getElementById('onb-hint').style.display = 'none'; });
    window.addEventListener('resize', () => { if (document.getElementById('coach-overlay')?.classList.contains('active')) showCoachStep(tourIdx); });

    // === ЗАПУСК ===
    init();
});
