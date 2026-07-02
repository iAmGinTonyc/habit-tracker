# HANDOFF — continuity doc (read this first in a fresh session)

You are continuing work on a **habit-tracker web app** (vanilla HTML/CSS/JS, no build, no
deps, localStorage). This file is the technical + decisions map for YOU. There's also
`PROJECT.md` (user-facing feature doc — обновлён 24.06.2026, актуален: psycho/онбординг/колесо).
The code is the source of truth; this is the map. Communicate with the user in **Russian**.

---

## 1. Files
```
index.html          — все экраны/модалки (один <body>, скрипт в конце)
habbittracker.css   — вся стилизация (ч/б дизайн-система)
habbittracker.js    — вся логика, ОДИН IIFE на DOMContentLoaded (~2150 строк)
pics/               — картинки: игральные карты (мемори-игра), волки (питомец/интро)
PROJECT.md          — пользовательская дока (актуальна на 24.06.2026)
HANDOFF.md          — этот файл
.claude/launch.json — конфиг превью (python http.server 4599, имя "habits-static")
```
`habbittracker.js` — один большой IIFE. Почти всё — `function`-объявления (хойстятся),
поэтому порядок определения гибкий; `const`-стрелки определены до рантайм-вызовов.

**Прод (деплой):** GitHub Pages, статика из ветки `main` (корень). Аккаунт `iAmGinTonyc`.
- Репо: https://github.com/iAmGinTonyc/habit-tracker (публичный)
- Живой сайт: https://iamgintonyc.github.io/habit-tracker/
- **Передеплой = просто `git push` в `main`** (Pages пересобирается сам, ~30–60с). Проверка:
  `gh api /repos/iAmGinTonyc/habit-tracker/pages/builds/latest --jq .status` → `built`.
- Пути к ассетам в `index.html` ОТНОСИТЕЛЬНЫЕ (работает под подпутём `/habit-tracker/`) — не ломать на абсолютные.
- В git НЕ коммитим: `.DS_Store`, `.claude/settings.local.json` (см. `.gitignore`).

---

## 2. Как запускать и тестировать
- Превью: `preview_start("habits-static")` → вернёт `serverId`. Это static-сервер на :4599.
- Паттерн теста: положить в `localStorage['habbittracker_progress']` JSON-стейт (см. §3),
  `location.reload()`, потом гнать через `preview_eval` / `preview_screenshot`.
- **В конце всегда** сбрасывать: `localStorage.removeItem('habbittracker_progress')`.
- Машинные часы превью идут по РЕАЛЬНОМУ времени (дрейфуют между сессиями). ВСЕГДА сверяй
  `new Date()` / `todayKey()` перед сидированием дат — НЕ хардкодь конкретный день.
- Перед концом правки: `node --check habbittracker.js`, баланс тегов в HTML, скриншот
  изменённого вида, проверка `preview_console_logs` (level error), сброс localStorage.

### Грабли (проверено на практике)
- **Скриншот ловит транзишн вкладок** (0.2s): активная вкладка может выглядеть не-чёрной
  сразу после клика. Это артефакт — переснимай позже, а состояние читай через `eval`
  (`getComputedStyle` тоже может вернуть промежуточное значение анимации).
- **CSS иногда кэшируется** при reload — полный `location.reload()` подхватывает изменения.
- **reload внутри `preview_eval` обрывает промис** ("Inspected target navigated") — делай
  reload отдельным вызовом, потом следующий eval.
- Свежий поток: интро ~2000ms (loading 1500 + fade 500), тур стартует +700ms → ~2.7s после
  тапа по интро.

---

## 3. Модель данных — `dashState` (ключ `habbittracker_progress`)
```js
{
  level, currentXP,
  habits: [{ uid, text, completed, xpDate?, areas:[areaId...], triggerText?, reminderTime? }],
  unlockedGames: [gameId...],      // [] у нового → выбор ПЕРВОЙ игры; +1 на ур.3/7/10
  lastActiveDate,                  // 'YYYY-MM-DD' (UTC, как в checkNewDay)
  checkins: { morning:{}, evening:{} },               // черновик чек-апов на сегодня
  checkinHistory: { 'YYYY-MM-DD': { morning:{...}, evening:{...} } },
  history: { 'YYYY-MM-DD': { uid:true } },             // ВЕЧНЫЙ лог выполнения привычек
  foodLog: { 'YYYY-MM-DD': { breakfast:{time,text}, lunch:{...}, dinner:{...} } }, // вкладка Питание
  psychoMode: false,
  metrics: [{ id, name, type:'goal'|'limit', target, unit?, step? }], // ЖИВОЙ список метрик (юзер CRUD-ит)
  metricTargets: { metricId:number },                 // переопределённые цели метрик (override target)
  metricLog: { 'YYYY-MM-DD': { metricId:number } },
  onboardingDone: bool,
  seenHints: { month?, morning?, evening?: true }
}
```
**Даты:** `history` и `metricLog` ключуются ЛОКАЛЬНО через `fdt(y,m,d)` =
`` `${y}-${pad(m+1)}-${pad(d)}` ``. `checkinHistory` местами ключуется UTC
(`toISOString().split('T')[0]`). График настроения/сна читает с дабл-фолбэком local→UTC.
Это намеренная совместимость со старым кодом — не «чини» бездумно.

`checkNewDay()` на новый день обнуляет `habits[].completed` и `checkins`, но НЕ трогает
`history`/`checkinHistory`/`metricLog`.

**Миграция метрик (init):** проверяй именно `saved.metrics`, НЕ `dashState.metrics` — у скелета
`dashState` теперь `metrics:[]`, поэтому после слияния отличить «старый сейв без метрик» от «юзер
удалил все метрики» можно только по сырому `saved`. `!Array.isArray(saved.metrics)` → сидируем 7
дефолтов; `saved.metrics:[]` (пустой) → оставляем пусто. (Старые `calories`/`claude` в `metricLog`
остаются осиротевшими — безвредно, не рендерятся.)

---

## 4. Ключевые константы / хелперы (в habbittracker.js)
- `DEFAULT_HABITS` (3 шт.: Подъём до 6 утра / Книга / Тренировка), `MAX_HABITS=10`.
- `LIFE_AREAS` (7: career, home, energy, finance, social, growth, emotion) — колесо жизни.
- `DEFAULT_METRICS` (7, psycho mode; `type`: goal/limit — binary убран вместе с `claude`/`calories`).
  Это лишь СИД для новых юзеров → `cloneMetrics()` копирует в `dashState.metrics`; дальше юзер
  сам добавляет/удаляет (см. §5). `metricTarget(m)` — цель с учётом override (`metricTargets[id]`).
- `GAMES` + `GAME_ORDER = ['memory','count','words','sudoku']`; `UNLOCK_LEVELS=[3,7,10]`;
  `maxUnlockable()`, `lockedGames()`, `checkGameUnlock()`, `openGameUnlockModal()`.
- `PET_STAGES` (4), `PET_MOODS` (4), `petState()`, `setPetFigure()`.
- `DAY_TOUR` (8 шагов онбординга), `VIEW_HINTS` (month/morning/evening).
- `MEALS` (3: breakfast/lunch/dinner), `weekDates()` (Пн–Вс тек. недели), `timeToPct` (ось 5–24ч), `escAttr` — вкладка Питание.
- Хелперы: `fdt`, `todayKey`, `newUid`, `isDone`, `setHistory`, `currentStreak`,
  `getLevelStats`, `awardXP`, `streakChip`/`FLAME` (моно-SVG огонёк), `DOTS`/`LOCK` (SVG).
- На `window` выставлены: `dashState`, `saveProgress`, `updateProgressUI`, `getLevelStats`,
  `awardXP`, `petState`.

---

## 5. Что построено (фичи и где)
**Поток:** интро (волк+фраза) → тап → «День». Экранов идентичности/эволюции НЕТ (удалены).
Новый юзер: `createDefaultState()` (3 привычки, `unlockedGames:[]`, `metrics`=7 дефолтных, `onboardingDone:false`).
Вернувшийся: `init()` → `showDashboard()` сразу.

**Таб-бар (6 видимых):** День, Месяц, Игры, Утро, Вечер, Питание. (7-я «Питомец» — СКРЫТА, см. §7.)
`switchView(view)` — синхронно ставит `.active` (без setTimeout — иначе гонка двух активных
видов), вызывает рендер вида + `maybeShowViewHint(view)`.

**Нижний кластер зафиксирован (мобильная адаптация):** `#psycho-toggle` + `.view-switcher` +
`.dash-footer` (XP-бар) обёрнуты в `#dash-bottom-bar` — `position:fixed; bottom:0` (habbittracker.css).
`.dash-content` резервирует место под него через `padding-bottom: var(--bottom-bar-h)`; высоту
меряет `measureBottomBar()` (habbittracker.js, вызывается на старте + resize + два отложенных
ремера 300/1200мс на случай позднего reflow от шрифтов). Не хардкодь `padding-bottom` — высота
зависит от переноса текста на узких экранах.
**Свайп между вкладками:** `initSwipeNav()` на `.dash-content` — touchstart/move/end, порог 60px,
жест засчитывается только если горизонтальная составляющая явно больше вертикальной (не мешает
скроллу). Порядок вкладок берётся из ВИДИМЫХ `.view-btn` (питомец `display:none` — исключается
автоматически). Свайп НЕ зацикливается на первой/последней вкладке. `.dash-content` имеет
`touch-action: pan-y` — разрешает браузеру нативно обрабатывать только вертикальный скролл,
горизонтальный жест целиком на нашем JS (`preventDefault()` только когда жест распознан горизонтальным).

- **День** (`view-habits` → `#day-normal`): `renderDayView()`/`renderDashboardHabits()`.
  Строка = чекбокс + текст + (серия, моно-огонёк) + «⋯». `toggleHabit()` — XP без фарма
  (флаг `habit.xpDate` = дата начисления), пишет в `history`, обновляет колесо. Добавление
  `+ добавить привычку` (до 10) — инпут с `autocomplete="new-password"` (НЕ `"off"` — Chrome его
  игнорирует для полей, похожих на логин по эвристике; `new-password` уважает надёжнее) + уникальным
  `name` (иначе браузер предлагает сохранённый email/логин в это поле — было замечено юзером,
  дважды: первая попытка `autocomplete="off"` не помогла). Настройки: `openHabitSettings`/`saveSettings` — модалка с
  названием, триггером «после того как», напоминанием, **сферами колеса** (чипы), удалением.
  Удаление привычки И метрики идут через общий `confirmDialog`/`#confirm-modal` (стилизованная,
  не нативный `confirm`; `#confirm-modal{z-index:2700}` — поверх модалки настроек 2500/игр 2600).
  **Колесо жизни ПОД привычками** (без заголовка): `renderLifeWheel('day','life-wheel-day')`,
  `areaFractions()`, `lifeWheelSVG()` — заполняется автоматически от выполнения привычек,
  привязанных к сферам.
- **Месяц** (`renderMonthView`): тепловая карта (внутри клеток — сокр. день недели чёрным,
  исчезает при заливке), редактируемая задним числом, серии, **месячное колесо**, график
  настроения/сна (`drawMonthMoodSleep`). Клик по клетке СЕГОДНЯ даёт XP (как `toggleHabit`:
  общий `habit.xpDate`, один раз/день, без фарма); прошлые дни редактируются БЕЗ XP.
  В psycho mode → `renderPsychoMonth`: сводка метрик (сумма за месяц / дневная цель × дней),
  БЕЗ графика настроения/сна (он только в обычном «Месяце»).
- **Игры** (`initTrainingMenu`, `startTrainingGame`): 4 игры — `renderMemoryGame` (карты из
  `pics/`), `renderCountGame`, `renderWordsGame`, `renderSudokuGame` (9×9, 1 пропуск в каждом
  квадрате 3×3). Все дают XP через `window.awardXP`. Разблокировка: ПЕРВУЮ игру выбираешь сам
  при первом заходе (модалка «Выбери первую игру»), дальше по 1 на ур.3/7/10.
- **Утро/Вечер** (`initCheckins`, `saveCheckin` +3 XP за первое сохранение/день,
  `lockFormAfterSave`, история по дате, аналитика `openAnalytics`/`renderCharts`). Ч/б,
  шкалы 1–10 единым рядом, зелёного нет. В «Утре» поле `data-key="mood"` подписано
  «Настроение» (подпись ≠ ключ: ключ `mood` нужен графику/аналитике — не переименовывать ключ).
  **Утро = 4 поля:** уснул/проснулся (время), «Качество сна» (`data-key="sleepQuality"`),
  «Настроение» (`mood`), фокус. `energy` в «Утре» БОЛЬШЕ НЕТ (юзер заменил на sleepQuality) —
  осталось только в «Вечере» («Уровень энергии сейчас»). `drawMonthMoodSleep()` (месячный график,
  пунктир) и аналитика (`renderCharts`) читают `sleepQuality` — эта правка ЧИНИТ им источник данных
  (раньше поле было удалено из формы, но графики всё ещё ждали sleepQuality — мёртвый пайплайн).
- **Питание** (`renderFood`): дневник еды. `foodLog[date]={breakfast,lunch,dinner:{time,text}}`.
  Форма «сегодня» (3 приёма: время + текст), АВТОСОХРАНЕНИЕ по вводу (без кнопки/лока/XP, в отличие
  от чек-апов). Ниже — недельный график `renderFoodWeek()` (Пн–Вс тек. недели, `weekDates()`):
  на дорожке дня точки по времени (`timeToPct`, ось 5:00–24:00) + чипы «время · что ел». Сегодня — подсветка.
- **XP/уровни:** `getLevelStats` (xpNeeded=floor(15·lvl^1.8), xpPerHabit=5+(lvl-1)·3).
  `awardXP(amount)` централизует прибавку + level-up + `checkGameUnlock`. Уровни влияют ТОЛЬКО
  на разблокировку игр (и стадию питомца, скрытого). Шапка: «уровень N»; футер: XP-бар.
- **Psycho mode** (`setPsychoMode`): тумблер над таб-баром, заменяет «День» на числовые
  метрики (`renderPsychoMetrics`, инлайн-редактор цели). У каждой метрики кнопка «удалить»
  (стилизованная модалка `confirmDialog`/`#confirm-modal` + чистит `metricTargets[id]`; модалка
  ВНУТРИ `#dashboard-screen` → инвертируется в psycho); внизу `renderAddMetricControl` — свёрнутая кнопка
  «+ добавить показатель» → форма (название, сегмент цель/лимит, значение, ед.). Пустой список →
  «Нет показателей — добавь первый». **Инверсия цветов** всего дашборда
  (`#dashboard-screen.psycho-invert { filter:invert(1) }`, картинки контр-инвертируются).
- **Онбординг** (см. §6).
- **Шапка:** `.dash-toprow` = ↺ `#reset-btn` (слева) + ? `#help-btn` (справа), оба `.icon-btn`
  кружки. Ниже `.dash-header`: дата + уровень.

---

## 6. Онбординг (свежий код)
- **Коачмарк-тур** по «Дню» (новому юзеру после интро, и по кнопке «?»): `startTour(DAY_TOUR)`,
  `showCoachStep(i)`, `positionCoach(el,step,i)`. Затемнение = `#coach-hole` с
  `box-shadow:0 0 0 9999px`. Для шага без цели (приветствие) дырка 0×0 в центре (иначе нет
  затемнения). 8 шагов: приветствие, **кнопка профиля (друзья/ID)**, чекбокс, «⋯», список/добавление,
  колесо (с автоскроллом), psycho-тумблер, таб-бар. Кнопки «Пропустить»/«Далее»(/«Готово»). Оверлей
  блокирует клики. Шаг про профиль НЕ упоминает вход/регистрацию — к этому моменту юзер уже
  залогинен (вход обязателен сразу после тапа по заставке, см. §13), формулировка была поправлена
  юзером именно по этой причине.
- **Контекстные подсказки** при первом заходе в Месяц/Утро/Вечер: `maybeShowViewHint(view)`,
  баннер `#onb-hint` + «Понятно», тексты в `VIEW_HINTS`. Помечается `seenHints[view]`.
- **«?»** (`#help-btn`) — повтор тура (выключает psycho, идёт на «День», +200ms старт).
- Флаги: `onboardingDone`, `seenHints`. Существующие сейвы в `init()` помечаются
  `onboardingDone=true` (тур им не показываем).

---

## 7. Питомец — СКРЫТ (но код целиком на месте)
Контракт под будущий визуал готов. `petState()` → `{level, stage(1-4), stageName, care(0-100),
mood(0-3), moodLabel, moodNote, maxStreak, activeDays}`. Стадия от уровня
(1 / 2–4 / 5–9 / 10+ = Щенок/Подросток/Взрослый/Вожак). Настроение от «заботы за 7 дней»
(средний % выполнения привычек + бонусы за серии и чек-апы).
- Вкладка `view-pet` + `renderPet()` + `setPetFigure()` — грузит `pics/wolf {стадия}_{настроение}.png`
  с фолбэком (нет точной → `{стадия}_3` → плейсхолдер). У юзера есть `wolf 1_3.png`, `wolf 2_3.png`.
- Десктоп-роумер `#pet-roamer` (бегает) — `updatePetRoamer()`.
- **СКРЫТО так:** CSS `.view-btn[data-view="pet"]{display:none}`. Грид `.view-switcher` сейчас
  `repeat(6,1fr)`/`max-width:600px` (6 видимых вкладок, вкл. Питание); роумер — `ROAMER_ENABLED=false`.
- **Вернуть:** убрать правило скрытия пет-вкладки, поставить `repeat(7,1fr)` и поднять `max-width` (~680px),
  `ROAMER_ENABLED=true` (если нужен роумер). Новые `wolf {1-4}_{0-3}.png` подхватятся сами.
- Хуки для визуала: `#pet-figure` и `#pet-roamer` имеют `data-stage` и `data-mood`.

---

## 8. Дизайн-язык / конвенции
- Строго ч/б: `#111` / `#fff` / серые. Цветных акцентов нет. Inter, минимализм.
- Иконки — тонкие моно-SVG (вкладки), эмодзи в UI убраны (огонёк-серия = маленький SVG).
  Известный остаток: 🔔 в тосте напоминания (`showReminderToast`).
- Тексты на русском.

---

## 9. Принятые решения (НЕ переоткрывать)
- Убрали выбор идентичности/целей; сразу «День». Интро оставили (тап → День).
- XP/уровни влияют ТОЛЬКО на игры (и стадию питомца). Привычки — плоский список, лимит 10.
- Игры: первую выбираешь сам, остальные на 3/7/10.
- Колесо — авто от привычек (не ручная оценка), под привычками, без заголовка.
- Psycho mode: метрики — ОТДЕЛЬНЫЙ список (не привычки), юзер сам добавляет/удаляет, при
  добавлении выбирает цель/лимит; binary-тип убран. Инверсия цветов.
- Питомец временно скрыт (юзер делает визуал отдельно).
- Онбординг: коачмарки + контекстные подсказки + «?».

---

## 10. Стиль работы с юзером
- Русский, быстрый итеративный цикл. Для БОЛЬШИХ фич: сначала обсудить сценарий → он
  отвечает на развилки (через AskUserQuestion) → потом кодить. Мелочи — делать сразу.
- Хочет минимализм, ч/б, меньше эмодзи. Любит видеть результат (проверка в браузере,
  скриншоты). Ценит обратимость («скрыть, не удалять» → флаги/комменты). Ценит честные
  заметки про трейд-оффы и грабли. В конце сбрасывать превью в чистый старт.

---

## 11. Что дальше / открыто
- **БЭКЕНД (Supabase) — Фазы 1–3 ГОТОВЫ и проверены (см. §13):** аккаунты, синк СВОДКИ, семья
  (взаимно, по ID). Открыто на будущее: полный синк ВСЕГО стейта между устройствами (сейчас в
  облако уходит только сводка `stats`, сам трекер живёт локально); имя профиля берётся из email
  (можно дать редактировать); real-time обновление семьи; удаление/выход из семьи.
- **Шрифт `Tokushupikuseru-Regular.otf`** (в корне) — юзер хочет применить, но НЕ тот, что был
  на демке. Пока НЕ подключаем (ждём финальный шрифт). Есть готовый субсет-путь: pyftsubset →
  woff2 (вышло 6 КБ) — так и грузить в прод, не сырой .otf на 345 КБ.
- **Питомец:** ждём остальные `pics/wolf {1-4}_{0-3}.png` (есть 1_3, 2_3). Когда придут или
  юзер скажет «верни питомца» — расскрыть (см. §7). Заметки: PNG лучше прозрачные (сейчас
  светлый фон, заметен в psycho-инверсии); пока есть только настроение 3 → при любом
  настроении показывается «довольный»; нужны стадии 3–4.
- Возможно: idle-анимация питомца, празднование смены стадии/уровня, доп. настроения игр.
- Тонкая настройка онбординга: насыщенность затемнения (сейчас ~0.62), тексты, разрешить ли
  тыкать подсвеченный элемент во время тура (сейчас тур — чистый рассказ, клики блокируются).

---

## 12. Чек-лист перед завершением правки
1. `node --check habbittracker.js` → OK.
2. Баланс тегов в `index.html` (div/section/button).
3. Браузер: засеять стейт → скриншот изменённого вида → `preview_console_logs` (error) пусто.
4. `localStorage.removeItem('habbittracker_progress')` (чистый старт).

---

## 13. Бэкенд / аккаунты (Supabase) — Фаза 1 ГОТОВА
- **Архитектура:** статика (GitHub Pages) + Supabase напрямую с клиента, без билда/сервера.
  Клиент грузится с CDN (`cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm`, НЕ esm.sh — см. «Грабли»
  ниже) в `auth.js` (ES-модуль), выставлен на `window.sb`.
- **Файлы:** [`auth.js`](auth.js) (клиент + UI входа + семья), [`db/phase1_profiles.sql`](db/phase1_profiles.sql) (схема — выполнена в Supabase).
  Подключение: `index.html` → `<script type="module" src="auth.js">`.
- **Проект:** URL `https://sgsqgpthfufbbyukifbn.supabase.co`, ключ `sb_publishable_…` (в `auth.js` —
  ПУБЛИЧНЫЙ по дизайну, безопасно в репо; данные защищает RLS). НЕ путать с `sb_secret_…`.
- **Вход ОБЯЗАТЕЛЕН после тапа по заставке** (было опционально — юзер попросил сменить). Поток:
  тап по интро → `waitForAuthGate()` (habbittracker.js, ждёт `window.requireAuth`, таймаут 10с с
  понятной ошибкой в hint-text) → `window.requireAuth(cb)` (auth.js) → модалка `#auth-modal.mandatory`
  (крестик скрыт CSS `.mandatory .auth-close{display:none}`, бэкдроп-клик/Esc игнорируются в
  `closeModal()` при `mandatory=true`) → успешный вход/регистрация в `submit()` снимает `mandatory`,
  закрывает модалку, зовёт `cb()` → `createDefaultState()` + `showDashboard()`. Дефолт формы —
  регистрация (`setMode('register')`), переключение на вход доступно. ВОЗВРАЩАЮЩИЕСЯ юзеры (уже есть
  `habbittracker_progress` в localStorage) по-прежнему скипают интро и идут сразу в «День» БЕЗ
  повторной проверки входа — это осознанное сужение скоупа («после тапа по заставке» буквально),
  не путать с «вход обязателен всегда».
  Кнопка профиля в шапке (`#profile-btn`) → та же модалка (не mandatory) — регистрация/вход email+пароль /
  профиль с `invite_id` + копировать + выйти. Логика — `auth.js` (`setMode/submit/refresh`).

### ⚠️ ГРАБЛИ: зависание Supabase-клиента при восстановлении сессии (важно, перечитать перед правками auth.js)
Баг, на который убито много времени в сессии 01.07.2026. Симптом: после `signUp`/`signInWithPassword`
+ ЛЮБАЯ последующая перезагрузка страницы → `sb.auth.getSession()` и `sb.from(...)`/`sb.rpc(...)`
зависают НАВСЕГДА (без ошибки, без сетевого запроса — видно в Network, без `navigator.locks`
held/pending — проверяли `navigator.locks.query()`). Воспроизведено стабильно на 2 CDN-сборках
(esm.sh И jsdelivr), с `autoRefreshToken` true/false — ни то, ни другое не первопричина сами по себе.
Похоже на баг конкретно окружения превью/CDP-автоматизации (клиент, созданный ОТДЕЛЬНЫМ вызовом
через devtools/eval ПОСЛЕ загрузки страницы, всегда работал мгновенно; тот же клиент, созданный как
часть обычного выполнения скрипта страницы — включая отложенный через `window.load`+`setTimeout` —
зависал). Не удалось однозначно подтвердить, воспроизводится ли это в реальном браузере юзера.
**Защита (сделана, не убирать без переосмысления):**
1. `boot()` в конце `auth.js` — создание клиента отложено до `window.load` + `setTimeout(…,0)`
   (не при исполнении модуля). Дешёвая мера, не факт что решает первопричину, но не вредит.
2. `withTimeout(promise, ms)` — обёртка-гонка с `TIMED_OUT`-сигналом, 4с. Обёрнуты: `getSession()`
   в `refresh()` (фолбэк — `readStoredSession()`, читает токен НАПРЯМУЮ из `localStorage['habit_auth']`
   и валидирует `expires_at`), плюс все `.from()`-запросы в `loadFamily()` и профильный `.from('profiles')`.
   Без этой защиты — ровно симптом, о котором сообщил юзер: «после обновления страницы просит войти
   заново» (потому что `refresh()` зависал и никогда не показывал `#auth-profile`).
   **Если апстрим (`@supabase/supabase-js`) починят баг — можно попробовать убрать `boot()`-задержку
   и/или таймауты, но СНАЧАЛА повторить тест: signUp → `location.reload()` (отдельным вызовом,
   не в одном eval — см. §2 «Грабли») → `sb.auth.getSession()` не должен висеть >1с.**
3. **`#auth-checking`** — третье (нейтральное) состояние модалки, ПОКАЗАНО ПО УМОЛЧАНИЮ в HTML
   (`auth-form-wrap` и `auth-profile` — оба `style="display:none"` изначально). Без этого юзер,
   успевший кликнуть «Профиль» ДО завершения первого `refresh()` (гонка: `boot()` идёт после
   `window.load`+setTimeout, а `openModal()` просто ставит `.active` — не ждёт auth-статус), видел
   форму входа, которая через секунду подменялась профилем — выглядело как «предлагает войти заново».
   `refresh()` теперь СРАЗУ (синхронно, до await) показывает `#auth-checking` и прячет оба других
   блока; в конце — переключает на форму/профиль по факту. НЕ убирать это состояние.
- **БД:** `profiles(id=auth uid, email, invite_id 8 симв., created_at)` + RLS (свой read/update) +
  триггер `handle_new_user` → `gen_invite_id()` выдаёт уникальный ID при регистрации.
- **Сессия:** `persistSession + autoRefreshToken` (storageKey `habit_auth`) → залогинен между визитами;
  жёсткий лимит (напр. 30 дней) — в дашборде Authentication → Sessions (time-box / inactivity).
- **Настройки Supabase (в дашборде):** Email provider ВКЛ, «Confirm email» ВЫКЛ (autoconfirm) — для
  тестов без писем. Проект отклоняет адреса `@example.com` (тест-домен) — для тестов бери `@gmail.com` и т.п.
- **Тест-юзеры** от проверок: `habitdemo.*`, `a*@gmail.com`, `b*@gmail.com` (можно удалить в Authentication → Users).
- **Проверка коннекта без браузера:** `curl -s $URL/auth/v1/settings -H "apikey: $KEY"` → JSON настроек.

### Фаза 2 (синк сводки) + Фаза 3 (семья) — SQL: [`db/phase3_family.sql`](db/phase3_family.sql)
- **`stats`** — СВОДКА, которую видит семья: `id, name, level, streak, week_pct, mood, updated_at`.
  Пишет только владелец; друзья читают. Синк: `window.getSummary()` (в habbittracker.js) → `auth.js`
  `syncMyStats()` (апсерт), дёргается из `saveProgress` через `window.syncStats` (дебаунс 1.5с).
  Имя = префикс email. Сводка = уровень / лучшая серия / % привычек за 7 дней / последнее утр. настроение.
- **`invites`** — `from_id, to_id, from_code, status(pending/accepted/declined)`. RLS: видят from/to;
  статус меняет только получатель. Принятое приглашение = дружба ВЗАИМНО (`are_friends()` — обе стороны).
- **`send_invite(target_code)`** — SECURITY DEFINER RPC: резолвит `invite_id`→user, вставляет invite;
  встречное pending авто-принимает. Профили остаются приватными (поиска по чужим профилям нет).
- **UI:** блок «Семья» в модалке профиля — поле «пригласить по ID», входящие (принять/отклонить),
  список семьи со сводкой. Логика — `auth.js` (`loadFamily/sendInvite/respondInvite/renderFamily`).
- **Дашборд-настройки Supabase, которые пришлось выставить:** Email provider ВКЛ + «Confirm email» ВЫКЛ.
