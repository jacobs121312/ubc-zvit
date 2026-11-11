import { env, SELF } from 'cloudflare:test';

/** Виклик API так, як його робить сторінка. who — пошта (тестовий вхід) або {session}. */
export async function api(who, fn, ...args) {
  const body = typeof who === 'string' ? { fn, args, token: 'dev:' + who } : { fn, args, ...who };
  const res = await SELF.fetch('https://api.test/', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain', Origin: 'https://budget.ubchurch.lviv.ua' } });
  return res.json();
}

/** Два служіння, лідер у кожному, Люба — у двох; категорії й кілька операцій. */
export async function seed() {
  const now = Date.now();
  const tables = ['op_receipts', 'ministry_emails', 'categories', 'ops', 'ministries', 'receipts', 'op_keys', 'sessions', 'seen',
    'invites', 'upload_quota', 'changelog', 'outbox', 'stat_counts', 'stat_users', 'stat_errors'];
  await env.DB.batch(tables.map(t => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ministries (id, name, responsible, emails, report_sheet_id, receipts_folder_id, opening_balance, sort) VALUES
      ('m1', 'Дитячий клуб', 'Андрущак І', 'luba@ubchurch.lviv.ua', 'sheet1', 'rec1', 0, 2),
      ('m2', 'Діти з інвалідністю', 'Анна', 'luba@ubchurch.lviv.ua, helper@ubchurch.lviv.ua', 'sheet2', 'rec2', 1000, 1),
      ('m3', 'Медіа', 'Продан', 'media@ubchurch.lviv.ua', 'sheet3', 'rec3', 9202.5, 3)`),
    env.DB.prepare(`INSERT INTO ministry_emails (ministry_id, email) VALUES ('m1','luba@ubchurch.lviv.ua'), ('m2','luba@ubchurch.lviv.ua'),
      ('m2','helper@ubchurch.lviv.ua'), ('m3','media@ubchurch.lviv.ua')`),
    env.DB.prepare(`INSERT INTO categories (ministry_id, name, plan, sort) VALUES
      ('m1','3401 Події/заходи',5000,1), ('m1','3402 Зустрічі',2000,2), ('m2','3401 Події/заходи',8000,1), ('m3','3206 Ліцензії',35000,1)`),
    env.DB.prepare(`INSERT INTO ops (id, ministry_id, type, date, amount, category, description, vendor, has_receipt, receipt_text, by_email, created_at, source) VALUES
      ('o1','m1','expense','2026-10-30',924.87,'3401 Події/заходи','їжа','',1,'так','',?1,'import'),
      ('o2','m1','advance','2026-11-01',20000,'','Залишок з табору','',0,'','luba@ubchurch.lviv.ua',?1,'app'),
      ('o3','m1','expense','2026-11-07',1635,'3401 Події/заходи','Свічки','Юск',1,'Так','luba@ubchurch.lviv.ua',?1,'app'),
      ('o4','m3','expense','2026-10-17',12971.81,'3206 Ліцензії','галерея','',1,'так','',?1,'import')`).bind(now),
    env.DB.prepare(`INSERT INTO op_receipts (op_id, file_id, pos) VALUES ('o1','fileA',0), ('o3','fileB',0)`),
  ]);
}
