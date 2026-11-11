import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { api, seed } from './helpers.js';
import { withGoogle, makeSheet } from './fakeGoogle.js';
import { processMinistry } from '../src/mirror.js';
import { importMinistry, syncSettings } from '../src/import.js';

const L = 'luba@ubchurch.lviv.ua';
const card = (o = {}) => Object.assign({ type: 'expense', date: '2026-11-05', amount: '100,50', category: '3401 Події/заходи',
  description: 'папір', vendor: 'Епіцентр', hasReceipt: false, noReceiptReason: 'загубився' }, o);
const ops = async id => (await env.DB.prepare('SELECT * FROM ops WHERE ministry_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(id).all()).results;

beforeEach(async () => { await seed(); delete env.GOOGLE_SA_KEY; });

/** Дочекатися, поки черга дзеркала спорожніє (частину завдань виконує фонова обробка після відповіді). */
async function drain(id) {
  for (let i = 0; i < 100; i++) {
    if (!(await env.DB.prepare('SELECT COUNT(*) n FROM outbox WHERE ministry_id = ?').bind(id).first()).n) return;
    await processMinistry(env, id);
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('черга дзеркала не спорожніла');
}
afterEach(() => vi.restoreAllMocks());

describe('submitExpenses', () => {
  it('витрата без чека й аванс записуються; черга дзеркала поповнюється', async () => {
    const r = await api(L, 'submitExpenses', 'm1', [card({ opId: 'card-0001' }), { type: 'advance', date: '2026-11-06', amount: 500, description: 'на захід', opId: 'card-0002' }]);
    expect(r.ok).toBe(true);
    expect(r.result.results[0]).toMatchObject({ month: 'Листопад', receiptUrls: [] });
    expect(r.result.results[1]).toMatchObject({ advance: true });
    const list = await ops('m1');
    const exp = list.find(o => o.id === r.result.results[0].id);
    expect(exp).toMatchObject({ amount: 100.5, has_receipt: 0, receipt_text: 'Ні', no_receipt_reason: 'загубився', by_email: L });
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first()).n).toBe(2);
    const cats = (await api(L, 'getCategories', 'm1')).result.categories;
    expect(cats[0].spent).toBeCloseTo(2559.87 + 100.5, 2);
  });

  it('повтор того самого opId не створює дубль', async () => {
    const a = await api(L, 'submitExpenses', 'm1', [card({ opId: 'card-dup-1' })]);
    const b = await api(L, 'submitExpenses', 'm1', [card({ opId: 'card-dup-1' })]);
    expect(b.result.results[0].id).toBe(a.result.results[0].id);
    expect((await ops('m1')).filter(o => o.description === 'папір')).toHaveLength(1);
  });

  it('перевищення бюджету — лише з поясненням', async () => {
    const no = await api(L, 'submitExpenses', 'm1', [card({ amount: 4000 })]);
    expect(no.result.results[0].error).toMatch(/перевищує залишок бюджету «Події\/заходи»/);
    const yes = await api(L, 'submitExpenses', 'm1', [card({ amount: 4000, overReason: 'великий захід' })]);
    expect(yes.result.results[0].id).toBeTruthy();
    expect((await ops('m1')).find(o => o.amount === 4000)).toMatchObject({ over: 1, over_reason: 'великий захід' });
  });

  it('розбитий чек — по рядку на категорію', async () => {
    const r = await api(L, 'submitExpenses', 'm1', [card({ amount: 300, splits: [{ category: '3401 Події/заходи', amount: 200 }, { category: '3402 Зустрічі', amount: 100 }] })]);
    const id = r.result.results[0].id;
    const parts = (await ops('m1')).filter(o => o.part_of === id);
    expect(parts.map(p => [p.id, p.category, p.amount])).toEqual([[`${id}-1`, '3401 Події/заходи', 200], [`${id}-2`, '3402 Зустрічі', 100]]);
  });

  it('категорія не зі списку, чужа дата, чуже служіння — відмова', async () => {
    expect((await api(L, 'submitExpenses', 'm1', [card({ category: '9999 Вигадана' })])).result.results[0].error).toBe('Оберіть категорію зі списку.');
    expect((await api(L, 'submitExpenses', 'm1', [card({ date: '2025-05-01' })])).result.results[0].error).toMatch(/фінансового року/);
    expect(await api(L, 'submitExpenses', 'm3', [card()])).toMatchObject({ ok: false, error: 'Оберіть своє служіння.' });
  });

  it('валюта перераховується за курсом НБУ', async () => {
    await withGoogle();
    const r = await api(L, 'submitExpenses', 'm1', [card({ amount: 10, currency: 'USD' })]);
    const o = (await ops('m1')).find(x => x.id === r.result.results[0].id);
    expect(o.amount).toBe(415);
    expect(JSON.parse(o.orig)).toEqual({ amount: 10, currency: 'USD', rate: 41.5 });
  });
});

describe('фото чеків', () => {
  const fileId = 'ownfile' + 'x'.repeat(20);
  it('своє завантажене фото приймається один раз; чуже — ні', async () => {
    const g = await withGoogle({ files: {
      [fileId]: { id: fileId, name: 'чек.jpg', mimeType: 'image/jpeg', size: '1000', parents: ['pre1'], appProperties: { zm: 'm1', zb: L, pre: '1' } },
      ['alien' + 'x'.repeat(20)]: { id: 'alien' + 'x'.repeat(20), name: 'a.jpg', mimeType: 'image/jpeg', size: '1000', appProperties: { zm: 'm3', zb: 'media@ubchurch.lviv.ua' } },
      rec1: { id: 'rec1', name: 'Чеки', mimeType: 'application/vnd.google-apps.folder', parents: ['m1'] },
    } });
    const url = `https://drive.google.com/file/d/${fileId}/view`;
    const ok = await api(L, 'submitExpenses', 'm1', [card({ hasReceipt: true, noReceiptReason: '', receiptUrls: [url] })]);
    expect(ok.result.results[0].receiptUrls).toEqual([url]);
    // перенесення з «_Завантаження» — фоном: чекаємо, поки черга його виконає
    for (let i = 0; i < 100 && g.drive.files[fileId].appProperties.pre; i++) { await processMinistry(env, 'm1'); await new Promise(r => setTimeout(r, 20)); }
    expect(g.drive.files[fileId].appProperties.pre).toBeUndefined();
    expect(g.drive.files[fileId].name).toMatch(/^2026-11-05_3401_100.5грн_Епіцентр/);
    const again = await api(L, 'submitExpenses', 'm1', [card({ hasReceipt: true, noReceiptReason: '', receiptUrls: [url] })]);
    expect(again.result.results[0].error).toBe('Це фото чека вже використано в іншій витраті.');
    const alien = await api(L, 'submitExpenses', 'm1', [card({ hasReceipt: true, noReceiptReason: '', receiptUrls: [`https://drive.google.com/file/d/alien${'x'.repeat(20)}/view`] })]);
    expect(alien.result.results[0].error).toMatch(/не знайдено серед завантажених/);
    const op = (await api(L, 'getCategories', 'm1')).result.ops.find(o => o.description === 'папір');
    expect(op.receipt).toBe(url);
  });

  it('фото до витрати без чека: needsReceipt, attachReceipts знімає позначку', async () => {
    const fid = 'later' + 'x'.repeat(20);
    await withGoogle({ files: {
      [fid]: { id: fid, name: 'чек.jpg', mimeType: 'image/jpeg', size: '1000', parents: ['pre1'], appProperties: { zm: 'm1', zb: L, pre: '1' } },
      rec1: { id: 'rec1', name: 'Чеки', mimeType: 'application/vnd.google-apps.folder', parents: ['m1'] },
    } });
    await env.DB.prepare(`INSERT INTO ops (id, ministry_id, type, date, amount, category, description, vendor, has_receipt, receipt_text, by_email, created_at, source, note)
      VALUES ('imp1', 'm1', 'expense', '2026-10-10', 250, '3401 Події/заходи', 'стара', '', 1, 'так', '', 1, 'import', 'Подав(ла): x\nПотрібно звірити чек')`).run();
    let op = (await api(L, 'getCategories', 'm1')).result.ops.find(o => o.id === 'imp1');
    expect(op.needsReceipt).toBe(true);
    const url = `https://drive.google.com/file/d/${fid}/view`;
    const r = await api(L, 'attachReceipts', 'm1', 'imp1', [url]);
    expect(r.ok).toBe(true);
    op = (await api(L, 'getCategories', 'm1')).result.ops.find(o => o.id === 'imp1');
    expect(op).toMatchObject({ needsReceipt: false, receipt: url });
    expect((await env.DB.prepare("SELECT note FROM ops WHERE id = 'imp1'").first()).note).toBe('Подав(ла): x');
    const again = await api(L, 'attachReceipts', 'm1', 'imp1', [url]);
    expect(again.error).toMatch(/вже є фото/);
    const alien = await api('media@ubchurch.lviv.ua', 'attachReceipts', 'm1', 'imp1', [url]);
    expect(alien.ok).toBe(false);
  });

  it('сесії прямого завантаження і ліміт', async () => {
    await withGoogle({ files: { rec1: { id: 'rec1', name: 'Чеки', mimeType: 'application/vnd.google-apps.folder', parents: ['m1'] } } });
    const r = await api(L, 'startUploads', 'm1', [Object.assign(card(), { files: [{ name: 'a.jpg', mimeType: 'image/jpeg', size: 1000 }] })]);
    expect(r.result[0].uploads[0].url).toMatch(/^https:\/\/upload\.test\/session\//);
    const pre = await api(L, 'startPreUploads', 'm1', [{ name: 'b.heic', mimeType: 'image/heic', size: 2000 }]);
    expect(pre.result[0].url).toMatch(/^https:\/\/upload\.test/);
    expect((await api(L, 'startPreUploads', 'm1', [{ name: 'x.exe', mimeType: 'application/octet-stream', size: 10 }])).error).toMatch(/лише фото/);
    await env.DB.prepare('UPDATE upload_quota SET n = 149').run();
    expect((await api(L, 'startPreUploads', 'm1', [{ name: 'c.jpg', mimeType: 'image/jpeg', size: 10 }, { name: 'd.jpg', mimeType: 'image/jpeg', size: 10 }])).error).toMatch(/Забагато фото/);
  });
});

describe('редагування, видалення, позначки', () => {
  it('лідер змінює свій запис у межах місяця; чужий — ні', async () => {
    expect((await api(L, 'editOperation', 'm1', 'o3', { amount: 1700, description: 'Свічки і стрічки' })).ok).toBe(true);
    const o = await env.DB.prepare("SELECT * FROM ops WHERE id='o3'").first();
    expect(o).toMatchObject({ amount: 1700, description: 'Свічки і стрічки' });
    expect(o.note).toMatch(/^Змінено: luba@ubchurch.lviv.ua, .*Було: 07\.11\.2026 · 1635 грн/);
    expect((await api(L, 'editOperation', 'm1', 'o3', { date: '2026-12-01' })).error).toMatch(/в межах того самого місяця/);
    expect((await api(L, 'editOperation', 'm1', 'o1', { amount: 1 })).error).toBe('Змінювати можна лише власні записи.');
    expect((await api('helper@ubchurch.lviv.ua', 'editOperation', 'm1', 'o3', { amount: 1 })).error).toBe('Оберіть своє служіння.');
  });

  it('після 24 год змінити не можна, видалити — можна', async () => {
    await env.DB.prepare("UPDATE ops SET created_at = ? WHERE id='o3'").bind(Date.now() - 25 * 3600e3).run();
    expect((await api(L, 'editOperation', 'm1', 'o3', { amount: 1 })).error).toMatch(/протягом 24 годин/);
    expect((await api(L, 'cancelOperation', 'm1', 'o3')).ok).toBe(true);
    expect((await api(L, 'getCategories', 'm1')).result.ops.map(o => o.id)).not.toContain('o3');
    expect((await env.DB.prepare("SELECT kind FROM outbox ORDER BY id DESC").first()).kind).toBe('delete_op');
  });

  it('видалення відправляє в кошик лише фото, які завантажив сервер для цього служіння', async () => {
    const g = await withGoogle({ files: { fileB: { id: 'fileB' }, own: { id: 'own' } } });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO op_receipts (op_id, file_id, pos) VALUES ('o3','own',1)"),
      env.DB.prepare("INSERT INTO receipts (file_id, ministry_id, by_email, status, created_at) VALUES ('own','m1',?, 'used', 0)").bind(L),
    ]);
    await api(L, 'cancelOperation', 'm1', 'o3');
    expect(g.drive.trashed).toEqual(['own']); // fileB — не з нашого завантаження, лишається
  });

  it('позначки адміна блокують редагування лідером', async () => {
    const r = await api('admin@ubchurch.lviv.ua', 'adminSetStatus', 'm1', 'o3', 'checked', true);
    expect(r.result.checked).toMatch(/^✓ admin@ubchurch.lviv.ua, /);
    expect((await api(L, 'editOperation', 'm1', 'o3', { amount: 1 })).error).toMatch(/уже перевірено/);
    expect((await api(L, 'cancelOperation', 'm1', 'o3')).error).toMatch(/уже перевірено/);
    expect((await api(L, 'adminSetStatus', 'm1', 'o3', 'checked', false)).error).toBe('Немає доступу адміністратора.');
    expect((await api('admin@ubchurch.lviv.ua', 'adminDeleteOperation', 'm1', 'o3')).ok).toBe(true);
  });
});

describe('дзеркало в таблиці', () => {
  it('рядок пишеться у вільний рядок місяця з ID, посиланням і приміткою; повтор оновлює той самий рядок', async () => {
    const g = await withGoogle({ spreadsheets: { sheet1: makeSheet() } });
    await env.DB.prepare("INSERT INTO outbox (ministry_id, kind, payload, next_at) VALUES ('m1','upsert_op','{\"id\":\"o3\"}',0)").run();
    await drain('m1');
    const nov = g.spreadsheets.sheet1.sheets['Листопад'].cells;
    expect(nov['8:10'].v).toBe('o3');
    expect(nov['8:2'].v).toBe(1635);
    expect(nov['8:6']).toMatchObject({ v: 'Так', link: 'https://drive.google.com/file/d/fileB/view' });
    expect(nov['8:0'].note).toMatch(/^Подав\(ла\): luba@ubchurch.lviv.ua\n/);
    expect((await env.DB.prepare("SELECT sheet_row FROM ops WHERE id='o3'").first()).sheet_row).toBe(8);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first()).n).toBe(0);
    // зміна → той самий рядок, а новий запис — наступний вільний
    await api(L, 'editOperation', 'm1', 'o3', { amount: 1700 });
    await api(L, 'submitExpenses', 'm1', [card()]);
    await drain('m1');
    expect(nov['8:2'].v).toBe(1700);
    expect(nov['9:4'].v).toBe('папір');
    // видалення очищає рядок
    await api(L, 'cancelOperation', 'm1', 'o3');
    await drain('m1');
    expect(nov['8:10'].v).toBeUndefined();
  });

  it('без таблиці звіту завдання відкладається, а не губиться', async () => {
    await withGoogle();
    await env.DB.prepare("UPDATE ministries SET report_sheet_id = NULL WHERE id='m1'").run();
    await env.DB.prepare("INSERT INTO outbox (ministry_id, kind, payload, next_at) VALUES ('m1','upsert_op','{\"id\":\"o3\"}',0)").run();
    await processMinistry(env, 'm1');
    const j = await env.DB.prepare('SELECT * FROM outbox').first();
    expect(j.error).toBe('немає таблиці звіту');
    expect(j.next_at).toBeGreaterThan(Date.now());
  });
});

describe('перенесення зі старих таблиць', () => {
  it('категорії, залишок і рядки з посиланнями; рядкам без ID дописується ID; повтор безпечний', async () => {
    const sheet = makeSheet();
    const c = sheet.sheets['Жовтень'].cells;
    Object.assign(c, { '8:0': { v: 46325, note: '' }, '8:2': { v: 924.87 }, '8:3': { v: '3401 Події/заходи' }, '8:4': { v: 'їжа' }, '8:6': { v: 'так', link: 'https://drive.google.com/file/d/manualfile' + 'x'.repeat(12) + '/view' },
      '9:0': { v: 46326, note: 'Подав(ла): luba@ubchurch.lviv.ua\n31.10.2026 18:00' }, '9:2': { v: 50 }, '9:3': { v: '3402 Зустрічі' }, '9:4': { v: 'чай' }, '9:6': { v: 'Ні' }, '9:7': { v: 'загубився' },
      '9:8': { v: '✓ admin@ubchurch.lviv.ua, 01.11.2026' }, '9:10': { v: 'keep-id-0001' },
      '10:0': { v: 46327 }, '10:1': { v: 2000 }, '10:4': { v: 'Аванс: на табір' } });
    const g = await withGoogle({ spreadsheets: { sheetM: sheet } });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ministries (id, name, emails, report_sheet_id, sort) VALUES ('mx', 'Тест', 'luba@ubchurch.lviv.ua', 'sheetM', 9)"),
      env.DB.prepare("INSERT INTO ministry_emails (ministry_id, email) VALUES ('mx', 'luba@ubchurch.lviv.ua')"),
    ]);
    const r = await importMinistry(env, 'mx');
    expect(r).toMatchObject({ status: 'ok', categories: 2, opening: 1000, sheet: { expense: 974.87, income: 2000, count: 3 }, db: { expense: 974.87, income: 2000, count: 3 }, idsWritten: 2 });
    const list = await ops('mx');
    const kept = list.find(o => o.id === 'keep-id-0001');
    expect(kept).toMatchObject({ by_email: 'luba@ubchurch.lviv.ua', checked_by: 'admin@ubchurch.lviv.ua', no_receipt_reason: 'загубився', source: 'import' });
    const adv = list.find(o => o.type === 'advance');
    expect(adv).toMatchObject({ amount: 2000, description: 'на табір', date: '2026-11-01' });
    const food = list.find(o => o.description === 'їжа');
    expect((await env.DB.prepare('SELECT file_id FROM op_receipts WHERE op_id = ?').bind(food.id).first()).file_id).toBe('manualfile' + 'x'.repeat(12));
    expect(c['8:10'].v).toBe(food.id); // ID дописано в K
    // повтор: нічого не дублюється, ID ті самі
    const r2 = await importMinistry(env, 'mx');
    expect(r2.db.count).toBe(3);
    expect(r2.idsWritten).toBe(0);
    // показ у формі лідера
    const snap = (await api(L, 'getCategories', 'mx')).result;
    expect(snap.balance.amount).toBeCloseTo(1000 + 2000 - 974.87, 2);
    expect(snap.ops.find(o => o.description === 'їжа').receipt).toMatch(/manualfile/);
    void g;
  });

  it('синхронізація таблиці служінь: пошти, порядок, вимкнення зниклих', async () => {
    const book = { sheets: { 'Аркуш1': { gid: 0, cells: {
      '1:0': { v: 'Назва' }, '1:1': { v: 'Відповідальний' }, '1:2': { v: 'Посилання на папку' }, '1:3': { v: 'Пошти (лідер, помічник — через кому)' },
      '2:0': { v: 'Медіа' }, '2:2': { v: 'https://drive.google.com/drive/folders/m3' + 'x'.repeat(18) }, '2:3': { v: 'new@ubchurch.lviv.ua' },
    } } }, updates: [] };
    await withGoogle({ spreadsheets: { settings: book } });
    env.SETTINGS_SPREADSHEET_ID = 'settings';
    const r = await syncSettings(env);
    expect(r.count).toBe(1);
    const mid = 'm3' + 'x'.repeat(18);
    expect((await env.DB.prepare('SELECT email FROM ministry_emails WHERE ministry_id = ?').bind(mid).first()).email).toBe('new@ubchurch.lviv.ua');
    expect((await env.DB.prepare("SELECT active FROM ministries WHERE id='m1'").first()).active).toBe(0); // немає в таблиці
    expect((await api(L, 'getInitData')).auth).toBe(true); // Люби більше немає в жодному служінні
  });
});

describe('запрошення', () => {
  it('без налаштованого поштаря — зрозуміла помилка; з ним — надсилає й запам\'ятовує', async () => {
    expect((await api('admin@ubchurch.lviv.ua', 'adminSendInvites', ['luba@ubchurch.lviv.ua'])).error).toBe('Розсилку ще не налаштовано.');
    await withGoogle();
    env.MAILER_URL = 'https://mailer.test/exec'; env.MAILER_KEY = 'k';
    const r = (await api('admin@ubchurch.lviv.ua', 'adminSendInvites', ['luba@ubchurch.lviv.ua', 'stranger@ubchurch.lviv.ua'])).result;
    expect(r).toMatchObject({ sent: 1, skipped: 0, remainingQuota: 90 });
    expect((await env.DB.prepare("SELECT at FROM invites WHERE email = 'luba@ubchurch.lviv.ua'").first()).at).toBeGreaterThan(0);
    delete env.MAILER_URL; delete env.MAILER_KEY;
  });
});
