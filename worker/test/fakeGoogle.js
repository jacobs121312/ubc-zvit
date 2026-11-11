// Фейковий Google (OAuth, Диск, Таблиці) у пам'яті — підміняє fetch у тестах.
import { vi } from 'vitest';
import { env } from 'cloudflare:test';

export async function testSaKey() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ client_email: 'zvit@test.iam.gserviceaccount.com', private_key: pem });
}

/** Звіт служіння: аркуші місяців (рядки з 8-го, «Total Expenses» на 20-му), БЮДЖЕТ і початковий залишок. */
export function makeSheet() {
  const months = ['Жовтень', 'Листопад', 'Грудень', 'Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень'];
  const sheets = {};
  months.forEach((m, i) => { sheets[m] = { gid: 100 + i, cells: {} }; sheets[m].cells['20:0'] = { v: 'Total Expenses/Усі витрати' }; });
  sheets['БЮДЖЕТ 26-27'] = { gid: 1, cells: { '3:0': { v: '3401 Події/заходи' }, '3:1': { v: 5000 }, '4:0': { v: '3402 Зустрічі' }, '4:1': { v: 2000 }, '5:0': { v: 'ВСЬОГО:' } } };
  sheets['Жовтень'].cells['5:0'] = { v: 'Advance beginning/Початковий залишок ' }; sheets['Жовтень'].cells['5:2'] = { v: 1000 };
  return { sheets, updates: [] };
}

export function installFakeGoogle({ files = {}, spreadsheets = {} } = {}) {
  const drive = { files, nextId: 1, trashed: [] };
  const book = id => spreadsheets[id];
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body && typeof init.body === 'string' ? init.body : null;
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'test-token', expires_in: 3600 });
    if (url.hostname === 'bank.gov.ua') return json([{ rate: 41.5 }]);
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/upload/drive/v3/files')) {
      if (url.searchParams.get('uploadType') === 'resumable') {
        const meta = JSON.parse(body);
        const id = 'up' + drive.nextId++ + 'x'.repeat(20);
        drive.files[id] = { id, name: meta.name, parents: meta.parents, appProperties: meta.appProperties, mimeType: init.headers['X-Upload-Content-Type'], size: init.headers['X-Upload-Content-Length'] };
        return new Response(null, { status: 200, headers: { Location: `https://upload.test/session/${id}` } });
      }
      const id = 'inl' + drive.nextId++ + 'x'.repeat(20);
      drive.files[id] = { id };
      return json({ id });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/files')) {
      const parts = url.pathname.split('/');
      const id = decodeURIComponent(parts[4] || '');
      if (!id && method === 'GET') { // list
        const q = url.searchParams.get('q') || '';
        const parent = (q.match(/'([^']+)' in parents/) || [])[1];
        const name = (q.match(/name = '([^']+)'/) || [])[1];
        const list = Object.values(drive.files).filter(f => (f.parents || []).includes(parent) && !f.trashed && (!name || f.name === name)
          && (!/mimeType = 'application\/vnd.google-apps.folder'/.test(q) || f.mimeType === 'application/vnd.google-apps.folder'));
        return json({ files: list.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType })) });
      }
      if (!id && method === 'POST') { const m = JSON.parse(body); const nid = 'f' + drive.nextId++ + 'x'.repeat(20); drive.files[nid] = { id: nid, ...m }; return json({ id: nid }); }
      if (parts[5] === 'copy') { const m = JSON.parse(body); const nid = 'sheetNew' + drive.nextId++; drive.files[nid] = { id: nid, ...m }; spreadsheets[nid] = makeSheet(); return json({ id: nid }); }
      const f = drive.files[id];
      if (!f) return json({ error: 'not found' }, 404);
      if (method === 'PATCH') {
        const m = JSON.parse(body);
        if (m.trashed) { f.trashed = true; drive.trashed.push(id); }
        if (m.appProperties) f.appProperties = Object.fromEntries(Object.entries({ ...f.appProperties, ...m.appProperties }).filter(([, v]) => v != null));
        if (m.name) f.name = m.name;
        const add = url.searchParams.get('addParents'); if (add) f.parents = [add];
        return json({ id });
      }
      return json(f);
    }
    if (url.hostname === 'sheets.googleapis.com') {
      const [, , , sid0, rest] = url.pathname.split('/');
      const [sid, op] = decodeURIComponent(sid0).split(':');
      const b = book(sid);
      if (!b) return json({ error: 'no sheet' }, 404);
      if (op === 'batchUpdate') {
        const { requests } = JSON.parse(body);
        b.updates.push(requests);
        for (const r of requests) {
          if (r.updateCells) {
            const sh = Object.values(b.sheets).find(s => s.gid === r.updateCells.start.sheetId);
            r.updateCells.rows[0].values.forEach((c, k) => {
              const key = `${r.updateCells.start.rowIndex + 1}:${r.updateCells.start.columnIndex + k}`;
              const v = c.userEnteredValue ? (c.userEnteredValue.stringValue ?? c.userEnteredValue.numberValue) : undefined;
              sh.cells[key] = { v, note: c.note, link: c.textFormatRuns && c.textFormatRuns[0].format.link.uri };
            });
          }
        }
        return json({});
      }
      if (rest === 'values:batchGet' || (url.pathname.endsWith('values:batchGet'))) {
        const ranges = url.searchParams.getAll('ranges');
        return json({ valueRanges: ranges.map(rg => {
          const m = rg.match(/^(?:'([^']+)'!)?([A-Z])(\d+):([A-Z])(\d+)$/);
          const sh = b.sheets[m[1] || Object.keys(b.sheets)[0]];
          const c0 = m[2].charCodeAt(0) - 65, r0 = +m[3], c1 = m[4].charCodeAt(0) - 65, r1 = Math.min(+m[5], 60);
          const values = [];
          for (let r = r0; r <= r1; r++) { const row = []; for (let c = c0; c <= c1; c++) { const x = sh && sh.cells[`${r}:${c}`]; row.push(x && x.v != null ? x.v : ''); } values.push(row); }
          while (values.length && values[values.length - 1].every(v => v === '')) values.pop();
          return { range: rg, values };
        }) });
      }
      // spreadsheets.get: метадані + (для A і G) примітки й посилання
      const ranges = url.searchParams.getAll('ranges');
      const sheets = Object.entries(b.sheets).map(([title, sh]) => ({ properties: { title, sheetId: sh.gid },
        data: ranges.filter(rg => rg.startsWith(`'${title}'!`)).map(rg => {
          const col = rg.match(/!([A-Z])/)[1].charCodeAt(0) - 65;
          const rowData = [];
          for (let r = 8; r <= 60; r++) { const x = sh.cells[`${r}:${col}`]; rowData.push({ values: [x ? { note: x.note, hyperlink: x.link } : {}] }); }
          return { startColumn: col, rowData };
        }) }));
      return json({ sheets });
    }
    if (url.hostname === 'mailer.test') { return json({ ok: true, remainingQuota: 90 }); }
    return real(input, init);
  });
  return { drive, spreadsheets, spy };
}

export async function withGoogle(opts) {
  env.GOOGLE_SA_KEY = await testSaKey();
  return installFakeGoogle(opts);
}
