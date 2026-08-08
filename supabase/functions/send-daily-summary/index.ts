// Edge Function: send-daily-summary
// Дёргается ОТДЕЛЬНЫМ pg_cron (каждые 15 минут, как и send-daily-reminders — см. db/phase12_…sql)
// в конце локального дня юзера (22:45–22:59, см. get_and_mark_due_summaries) и присылает в бота
// сводку «что сегодня трогал»: привычки, метрики Pro mode, чек-ап, питание, событие дня. Источник
// данных — синхронизированный app_state (db/phase11_app_state_sync.sql); без этой синхронизации
// сервер вообще не видел бы прогресс юзера (раньше он жил только в localStorage браузера).
//
// Секреты: TELEGRAM_BOT_TOKEN (тот же, что у остальных функций), TELEGRAM_SUMMARY_CRON_SECRET
// (свой, отдельный от TELEGRAM_REMINDER_CRON_SECRET — на случай, если понадобится включать/выключать
// сводку независимо от обычных напоминаний). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — платформа
// подставляет сама. Деплоить с --no-verify-jwt (вызывает не юзер, а сама база).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { logError } from '../_shared/logError.ts';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const CRON_SECRET = Deno.env.get('TELEGRAM_SUMMARY_CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MINI_APP_URL = 'https://iamgintonyc.github.io/habit-tracker/';

interface DueRow {
  user_id: string;
  telegram_id: number;
  timezone: string;
}

// deno-lint-ignore no-explicit-any
type AnyState = Record<string, any>;

// Сегодняшний ключ ('YYYY-MM-DD') в ЛОКАЛЬНОМ дне юзера — тот же формат, что и todayKey()/fdt() в
// habbittracker.js, иначе не совпадёт с ключами внутри самого app_state.data.
function localDateKey(timeZone: string): string {
  // en-CA форматирует даты как YYYY-MM-DD "из коробки" — не нужно вручную собирать строку.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

// «3 августа, понедельник» — тот же формат/те же массивы, что у formatFullDate в habbittracker.js
// (см. FULL_MONTH_NAMES/FULL_WD_NAMES там), юзер попросил указывать день и дату в самой сводке.
// Парсим todayKey руками (new Date('YYYY-MM-DD') читается как UTC-полночь — с датой в других
// таймзонах может съехать на день, тут просто split по частям, без учёта TZ вообще).
const FULL_MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const FULL_WD_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
function formatFullDate(dateKey: string): string {
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

// Собирает читаемый текст сводки из СЕГОДНЯШНЕГО среза dashState. Возвращает null, если сегодня
// вообще ничего не трогал — пустой отчёт слать не имеет смысла (см. вызов ниже). Заголовки блоков
// — жирным (HTML <b>, см. parse_mode в sendMessage ниже) + эмодзи, юзер попросил визуально
// разделить секции. Сами заголовки — статичные строки без пользовательского ввода, escHtml им не
// нужен; экранируем только то, что реально пришло из dashState.
function buildSummaryText(state: AnyState, todayKey: string): string | null {
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

  // Чек-ап дня (dashState.checkinHistory[date].morning) — юзер попросил разбить построчно
  // (раньше шло одной строкой через запятую).
  const morning = ((state.checkinHistory || {})[todayKey] || {}).morning;
  if (morning) {
    const parts: string[] = [];
    if (morning.sleepTime) parts.push(`лёг в ${escHtml(morning.sleepTime)}`);
    if (morning.wakeTime) parts.push(`встал в ${escHtml(morning.wakeTime)}`);
    if (morning.extraSleepHours) parts.push(`+${escHtml(morning.extraSleepHours)} ч сна урывками`);
    if (morning.mood) parts.push(`настроение ${escHtml(morning.mood)}/10`);
    if (morning.sleepQuality) parts.push(`сон ${escHtml(morning.sleepQuality)}/10`);
    if (morning.energy) parts.push(`энергия ${escHtml(morning.energy)}/10`);
    if (morning.health) parts.push(`здоровье ${escHtml(morning.health)}/10`);
    if (parts.length) sections.push('<b>🌙 Чек-ап:</b>\n' + parts.join('\n'));
  }

  // Питание (dashState.foodLog[date].{breakfast,lunch,dinner})
  const foodToday = (state.foodLog || {})[todayKey] || {};
  const mealNames: Record<string, string> = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин' };
  const foodLines = Object.keys(mealNames)
    .map((id) => {
      const rec = foodToday[id];
      if (!rec || (!rec.time && !rec.text)) return null;
      return `${mealNames[id]}${rec.time ? ` (${escHtml(rec.time)})` : ''}${rec.text ? `: ${escHtml(rec.text)}` : ''}`;
    })
    .filter(Boolean);
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

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('X-Cron-Secret') !== CRON_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: 'no_bot_token' }), { status: 500 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    const { data, error } = await admin.rpc('get_and_mark_due_summaries');
    if (error) {
      await logError('send-daily-summary', 'get_and_mark_due_summaries_failed', { detail: error.message });
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    const due: DueRow[] = data || [];
    let sent = 0;
    for (const row of due) {
      try {
        const { data: stateRow } = await admin.from('app_state').select('data').eq('user_id', row.user_id).maybeSingle();
        if (!stateRow || !stateRow.data) continue; // ещё ни разу не синкал прогресс — нечего показывать

        const todayKey = localDateKey(row.timezone);
        const text = buildSummaryText(stateRow.data, todayKey);
        if (!text) continue; // сегодня ничего не трогал — пустой отчёт не шлём

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: row.telegram_id,
            text,
            parse_mode: 'HTML', // заголовки блоков жирным + эмодзи (см. buildSummaryText/escHtml)
            reply_markup: {
              inline_keyboard: [[{ text: 'Открыть Live Life', web_app: { url: MINI_APP_URL } }]],
            },
          }),
        });
        const tgData = await res.json();
        if (tgData.ok) sent++;
        else console.warn('sendMessage failed for', row.user_id, tgData.description); // рутина (юзер заблокировал бота и т.п.) — не в error_log
      } catch (e) {
        console.error('summary failed for', row.user_id, e);
      }
    }
    return new Response(JSON.stringify({ due: due.length, sent }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    await logError('send-daily-summary', 'unexpected', { detail: e });
    return new Response(JSON.stringify({ error: 'unexpected', detail: String(e) }), { status: 500 });
  }
});
