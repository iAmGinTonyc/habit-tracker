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
- Машинные часы превью: `new Date()` = **24 июня 2026, среда** (`todayKey()` = `2026-06-24`). Сидируй даты под это.
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
- `DAY_TOUR` (7 шагов онбординга), `VIEW_HINTS` (month/morning/evening).
- Хелперы: `fdt`, `todayKey`, `newUid`, `isDone`, `setHistory`, `currentStreak`,
  `getLevelStats`, `awardXP`, `streakChip`/`FLAME` (моно-SVG огонёк), `DOTS`/`LOCK` (SVG).
- На `window` выставлены: `dashState`, `saveProgress`, `updateProgressUI`, `getLevelStats`,
  `awardXP`, `petState`.

---

## 5. Что построено (фичи и где)
**Поток:** интро (волк+фраза) → тап → «День». Экранов идентичности/эволюции НЕТ (удалены).
Новый юзер: `createDefaultState()` (3 привычки, `unlockedGames:[]`, `metrics`=7 дефолтных, `onboardingDone:false`).
Вернувшийся: `init()` → `showDashboard()` сразу.

**Таб-бар (5 видимых):** День, Месяц, Игры, Утро, Вечер. (6-я «Питомец» — СКРЫТА, см. §7.)
`switchView(view)` — синхронно ставит `.active` (без setTimeout — иначе гонка двух активных
видов), вызывает рендер вида + `maybeShowViewHint(view)`.

- **День** (`view-habits` → `#day-normal`): `renderDayView()`/`renderDashboardHabits()`.
  Строка = чекбокс + текст + (серия, моно-огонёк) + «⋯». `toggleHabit()` — XP без фарма
  (флаг `habit.xpDate` = дата начисления), пишет в `history`, обновляет колесо. Добавление
  `+ добавить привычку` (до 10). Настройки: `openHabitSettings`/`saveSettings` — модалка с
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
  затемнения). 7 шагов: приветствие, чекбокс, «⋯», список/добавление, колесо (с автоскроллом),
  psycho-тумблер, таб-бар. Кнопки «Пропустить»/«Далее»(/«Готово»). Оверлей блокирует клики.
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
- **СКРЫТО так:** CSS `.view-btn[data-view="pet"]{display:none}` + `.view-switcher` вернули на
  `repeat(5,1fr)`/`max-width:520px`; роумер — флаг `ROAMER_ENABLED=false` в JS.
- **Вернуть:** убрать правило скрытия пет-вкладки, вернуть `repeat(6,1fr)`/`max-width:600px`,
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
- **СЛЕДУЮЩАЯ БОЛЬШАЯ ФИЧА — статистика между друзьями.** Требует БЭКЕНДА: сейчас всё в
  `localStorage` (один браузер, без аккаунтов). Нужны: аккаунты/авторизация, общая БД, связи
  «друзья», синк локального стейта в облако. Рекомендованный путь без переписывания фронта —
  BaaS (например, Supabase: Postgres + auth + realtime), статика остаётся на GitHub Pages,
  фронт ходит в API. Это БОЛЬШАЯ фича → сначала обсудить сценарий через AskUserQuestion (§10):
  что именно шарим (привычки? серии? уровни? psycho-метрики?), приватность, как добавляют друзей.
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
