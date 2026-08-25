// Общий сборщик текста «Итоги дня» — используется И ночной рассылкой (send-daily-summary), И
// сводкой по запросу (send-summary-now). Вынесен из send-daily-summary/index.ts в Фазе 20: раньше
// он жил вперемешку с cron-обвязкой, и второй потребитель («Прислать сводку сейчас») мог появиться
// только копипастой — а формат сводки правится часто (см. историю правок в HANDOFF.md), две копии
// гарантированно разъехались бы. Импортируется относительным путём '../_shared/summaryText.ts' —
// тот же стиль, что и у logError.ts; `supabase functions deploy` подтягивает _shared сам.
//
// localDateKey() СЮДА НЕ ПЕРЕЕХАЛА и не должна: с Фазы 20 дату отчёта всегда отдаёт SQL
// (report_date у get_and_mark_due_summaries / claim_summary_ondemand), локально её больше никто
// не выводит — у «совы» с summary_time 04:00 локальная «сегодня» была бы пустым новым днём.

// deno-lint-ignore no-explicit-any
type AnyState = Record<string, any>;

// «3 августа, понедельник» — тот же формат/те же массивы, что у formatFullDate в habbittracker.js
// (см. FULL_MONTH_NAMES/FULL_WD_NAMES там), юзер попросил указывать день и дату в самой сводке.
// Парсим todayKey руками (new Date('YYYY-MM-DD') читается как UTC-полночь — с датой в других
// таймзонах может съехать на день, тут просто split по частям, без учёта TZ вообще).
const FULL_MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const FULL_WD_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export function formatFullDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${d} ${FULL_MONTH_NAMES[dt.getMonth()]}, ${FULL_WD_NAMES[dt.getDay()]}`;
}

// Экранирование для Telegram parse_mode:'HTML' — только &/</> обязательны (см. доки Bot API),
// без этого свободный текст юзера (название привычки/еды, событие дня и т.п.) с символами
// < > & сломал бы разметку письма или вообще уронил бы отправку целиком.
function escHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// «4:00-11:30 (+2 часа) Общее: 9:30 ч» — юзер попросил одной строкой вместо трёх (лёг/встал/
// урывками). Часы/минуты — те же вычисления, что у drawSleepHoursChart в habbittracker.js (учёт
// сна через полночь: wakeH<=sleepH → сон длился до 24:00 следующего дня).
function parseHM(s?: string): number | null {
  if (!s) return null;
  const [hh, mm] = s.split(':').map(Number);
  return isNaN(hh) ? null : hh + (mm || 0) / 60;
}
const stripLeadingZero = (t: string) => t.replace(/^0(\d:)/, '$1'); // "04:00" → "4:00"
function fmtDurationHM(hoursFloat: number): string {
  const totalMin = Math.round(hoursFloat * 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}
function pluralHours(n: number): string {
  if (!Number.isInteger(n)) return 'часа'; // дробные (1.5, 2.5…) — общепринято родительный ед.ч.
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'часов';
  if (mod10 === 1) return 'час';
  if (mod10 >= 2 && mod10 <= 4) return 'часа';
  return 'часов';
}

// Собирает читаемый текст сводки из среза dashState за ОДИН день. Возвращает null, если в этот
// день вообще ничего не трогал — пустой отчёт слать не имеет смысла (ночная рассылка его просто
// не шлёт, а сводка по кнопке подставляет свою заглушку). Заголовки блоков — жирным (HTML <b>,
// см. parse_mode в sendMessage у вызывающих) + эмодзи, юзер попросил визуально разделить секции.
// Сами заголовки — статичные строки без пользовательского ввода, escHtml им не нужен; экранируем
// только то, что реально пришло из dashState.
// Параметр todayKey — это ДАТА ОТЧЁТА, не обязательно сегодня: у «совы» с summary_time 04:00 сюда
// прилетает вчерашняя дата, см. summary_report_date в db/phase20_summary_time.sql.
export function buildSummaryText(state: AnyState, todayKey: string): string | null {
  const sections: string[] = [];

  // Задачи, отмеченные сегодня (dashState.history[date][uid] = true)
  const historyToday = (state.history || {})[todayKey] || {};
  const habitLines = (state.habits || [])
    .filter((h: AnyState) => historyToday[h.uid])
    .map((h: AnyState) => `✅ ${escHtml(h.text)}`);
  if (habitLines.length) sections.push('<b>📋 Задачи:</b>\n' + habitLines.join('\n'));

  // Разовые задачи на сегодня (dashState.habits с type:'oneTime' и date===todayKey, см.
  // renderTaskDayView/openNewHabitModal в habbittracker.js) — юзер попросил слать их отдельным
  // списком, ОБА исхода: выполненные (✅) и невыполненные (тег #невыполнено — тем же тегом
  // помечены и невыполненные «Задачи дня» ниже). У обычных регулярных задач (раздел «Задачи»
  // выше) нет понятия «дедлайн на сегодня», поэтому «невыполнено» для них не считаем — только
  // для разовых, у которых date жёстко привязан к конкретному дню.
  const oneTimeToday = (state.habits || []).filter((h: AnyState) => h.type === 'oneTime' && h.date === todayKey);
  if (oneTimeToday.length) {
    const oneTimeLines = oneTimeToday.map((h: AnyState) => (historyToday[h.uid] ? `✅ ${escHtml(h.text)}` : `#невыполнено ${escHtml(h.text)}`));
    sections.push('<b>📌 Разовые задачи:</b>\n' + oneTimeLines.join('\n'));
  }

  // Числовые метрики Pro mode (dashState.metricLog[date][metricId] = число)
  const metricLogToday = (state.metricLog || {})[todayKey] || {};
  const metricLines = (state.metrics || [])
    .map((m: AnyState) => {
      const v = metricLogToday[m.id];
      if (v === undefined || v === null || v === '' || v === 0) return null;
      return `${escHtml(m.name)}: ${escHtml(v)}${m.unit ? ' ' + escHtml(m.unit) : ''}`;
    })
    .filter(Boolean);
  if (metricLines.length) sections.push('<b>📊 Показатели:</b>\n' + metricLines.join('\n'));

  // Чек-ап дня (dashState.checkinHistory[date].morning) — построчно, сон (лёг/встал/урывками)
  // юзер попросил свести в одну строку вида «4:00-11:30 (+2 часа) Общее: 9:30 ч».
  const morning = ((state.checkinHistory || {})[todayKey] || {}).morning;
  if (morning) {
    const parts: string[] = [];
    const sleepH = parseHM(morning.sleepTime);
    const wakeH = parseHM(morning.wakeTime);
    const extra = parseFloat(morning.extraSleepHours) || 0;
    if (sleepH != null && wakeH != null) {
      const mainDur = wakeH <= sleepH ? (24 - sleepH) + wakeH : wakeH - sleepH; // сон через полночь
      let line = `${stripLeadingZero(morning.sleepTime)}-${stripLeadingZero(morning.wakeTime)}`;
      if (extra > 0) line += ` (+${escHtml(morning.extraSleepHours)} ${pluralHours(extra)})`;
      line += ` Общее: ${fmtDurationHM(mainDur + extra)} ч`;
      parts.push(line);
    } else {
      // Половина данных (только «лёг» или только «встал», без пары) — единую строку с диапазоном
      // не собрать, показываем что есть по отдельности, как раньше.
      if (morning.sleepTime) parts.push(`лёг в ${escHtml(morning.sleepTime)}`);
      if (morning.wakeTime) parts.push(`встал в ${escHtml(morning.wakeTime)}`);
      if (morning.extraSleepHours) parts.push(`+${escHtml(morning.extraSleepHours)} ч сна урывками`);
    }
    if (morning.mood) parts.push(`настроение ${escHtml(morning.mood)}/10`);
    if (morning.sleepQuality) parts.push(`сон ${escHtml(morning.sleepQuality)}/10`);
    if (morning.energy) parts.push(`энергия ${escHtml(morning.energy)}/10`);
    if (morning.health) parts.push(`здоровье ${escHtml(morning.health)}/10`);
    if (parts.length) sections.push('<b>🌙 Чек-ап:</b>\n' + parts.join('\n'));
  }

  // Питание (dashState.foodLog[date] = { blockId: {time, text}, ... }) — блоков теперь
  // произвольное число и без фиксированных id/названий (юзер убрал «Завтрак/Обед/Ужин» и добавил
  // кнопку «+ добавить приём пищи» в habbittracker.js, см. getMealSlots/addMealSlot), поэтому
  // берём все заполненные записи дня по порядку времени, а не жёстко закреплённые 3 id.
  const foodToday = (state.foodLog || {})[todayKey] || {};
  const foodLines = Object.values(foodToday as Record<string, { time?: string; text?: string }>)
    .filter((rec) => rec && (rec.time || rec.text))
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'))
    .map((rec) => `${rec.time ? `${escHtml(rec.time)}` : 'без времени'}${rec.text ? `: ${escHtml(rec.text)}` : ''}`);
  if (foodLines.length) sections.push('<b>🍽 Питание:</b>\n' + foodLines.join('\n'));

  // Событие дня (dashState.dayEvents[date])
  const dayEvent = (state.dayEvents || {})[todayKey];
  if (dayEvent) sections.push(`<b>🎉 Событие дня:</b>\n${escHtml(dayEvent)}`);

  // Задачи дня (dashState.dayTasks[date] = [{text, done}], см. getDayTasks в habbittracker.js —
  // старый формат единичного объекта без массива сюда почти не долетит, но на всякий случай тоже
  // разворачиваем). Тот же тег #невыполнено, что и у разовых задач выше — юзер попросил
  // унифицировать оба списка.
  const rawDayTasks = (state.dayTasks || {})[todayKey];
  const dayTasksToday: AnyState[] = Array.isArray(rawDayTasks) ? rawDayTasks : (rawDayTasks && rawDayTasks.text ? [rawDayTasks] : []);
  if (dayTasksToday.length) {
    const taskLines = dayTasksToday.map((t) => (t.done ? `✅ ${escHtml(t.text)}` : `#невыполнено ${escHtml(t.text)}`));
    sections.push('<b>🎯 Задачи дня:</b>\n' + taskLines.join('\n'));
  }

  if (!sections.length) return null;
  return `<b>Итоги дня, ${formatFullDate(todayKey)}:</b>\n\n` + sections.join('\n\n');
}
