// Общий хелпер для журнала ошибок (см. db/phase10_error_log.sql) — используется всеми Edge
// Functions вместо/вместе с console.error, чтобы реальные сбои (не рутинные 400 от плохого ввода)
// были видны одним SQL-запросом, а не только через `supabase functions logs` (юзер решил обойтись
// без стороннего мониторинга вроде Sentry).
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export async function logError(
  functionName: string,
  message: string,
  opts: { userId?: string | null; detail?: unknown } = {},
): Promise<void> {
  console.error(`[${functionName}]`, message, opts.detail ?? '');
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    await admin.from('error_log').insert({
      function_name: functionName,
      user_id: opts.userId ?? null,
      message,
      detail: opts.detail !== undefined ? String(opts.detail) : null,
    });
  } catch (_e) {
    // Логирование само не должно ронять функцию — если БД недоступна, просто теряем запись
    // (сама первопричина всё равно уже ушла в console.error выше).
  }
}
