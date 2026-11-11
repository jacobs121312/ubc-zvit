// Google Диск і Таблиці від імені службового акаунта (ключ — секрет GOOGLE_SA_KEY, у репозиторії його немає).
// Worker сам підписує JWT (RS256 через WebCrypto) і отримує access token; токен кешується ~55 хв.
import { MONTHS, UserError } from './util.js';

const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3';
let cached = { token: '', exp: 0 };

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = s => b64url(new TextEncoder().encode(s));

async function signingKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// Токен кешується в пам'яті екземпляра й у кеші Cloudflare (між екземплярами) — без підпису JWT на кожен холодний старт.
const TOKEN_CACHE_KEY = 'https://zvit-api.internal/google-sa-token';

export async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  try {
    const hit = await caches.default.match(TOKEN_CACHE_KEY);
    if (hit) { const j = await hit.json(); if (j.exp > Date.now()) { cached = j; return j.token; } }
  } catch (e) { /* кеш недоступний — просто отримаємо новий токен */ }
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SA_KEY || ''); } catch (e) { throw new Error('GOOGLE_SA_KEY не задано або пошкоджено'); }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64urlStr(JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(sa.private_key), new TextEncoder().encode(unsigned));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64url(sig),
  });
  if (!res.ok) throw new Error('Google token ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 300) * 1000 };
  try {
    await caches.default.put(TOKEN_CACHE_KEY, new Response(JSON.stringify(cached), {
      headers: { 'Cache-Control': `max-age=${Math.max(60, Math.floor((cached.exp - Date.now()) / 1000))}` } }));
  } catch (e) {}
  return cached.token;
}

/** Запит до Google API з токеном службового акаунта; помилка — виняток з кодом. */
export async function gapi(env, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + await accessToken(env), ...(opts.headers || {}) } });
  if (opts.raw) return res;
  if (!res.ok) {
    const e = new Error(`Google ${res.status}: ${(await res.text()).slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

const q = s => encodeURIComponent(s);
const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const FOLDER = 'application/vnd.google-apps.folder';

/** Метадані файлу (null, якщо немає доступу / не існує). */
export async function fileMeta(env, id, fields = 'id,name,mimeType,size,trashed,parents,appProperties') {
  try { return await gapi(env, `${DRIVE}/files/${q(id)}?supportsAllDrives=true&fields=${q(fields)}`); }
  catch (e) { if (e.status === 404 || e.status === 403) return null; throw e; }
}

export function patchFile(env, id, body, query = '') {
  return gapi(env, `${DRIVE}/files/${q(id)}?supportsAllDrives=true&fields=id${query}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function findChild(env, parent, name, mime) {
  const query = `'${parent}' in parents and trashed = false and name = '${name.replace(/'/g, "\\'")}'` + (mime ? ` and mimeType = '${mime}'` : '');
  const r = await gapi(env, `${DRIVE}/files?${ALL}&corpora=allDrives&pageSize=10&fields=files(id,name)&q=${q(query)}`);
  return (r.files || [])[0] || null;
}

export async function listChildren(env, parent, extra = '') {
  const out = [];
  let pageToken = '';
  do {
    const query = `'${parent}' in parents and trashed = false${extra}`;
    const r = await gapi(env, `${DRIVE}/files?${ALL}&corpora=allDrives&pageSize=1000&fields=nextPageToken,files(id,name,mimeType)&q=${q(query)}` + (pageToken ? `&pageToken=${q(pageToken)}` : ''));
    out.push(...(r.files || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function createFolder(env, parent, name) {
  return gapi(env, `${DRIVE}/files?supportsAllDrives=true&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
}

/** ID папки з кешу D1, інакше знайти або створити. */
async function cachedFolder(env, key, parent, name) {
  const hit = await env.DB.prepare('SELECT id FROM folders WHERE key = ?').bind(key).first();
  if (hit) return hit.id;
  const f = (await findChild(env, parent, name, FOLDER)) || (await createFolder(env, parent, name));
  await env.DB.prepare('INSERT OR REPLACE INTO folders (key, id) VALUES (?, ?)').bind(key, f.id).run();
  return f.id;
}

/** Папка чеків служіння: наявна «Чеки…» або нова «Чеки на витрати» (запам'ятовується в ministries). */
export async function receiptsFolderId(env, ministry) {
  if (ministry.receipts_folder_id) return ministry.receipts_folder_id;
  const kids = await listChildren(env, ministry.id, ` and mimeType = '${FOLDER}'`);
  const f = kids.find(k => /^Чеки/i.test(k.name)) || (await createFolder(env, ministry.id, 'Чеки на витрати'));
  await env.DB.prepare('UPDATE ministries SET receipts_folder_id = ? WHERE id = ?').bind(f.id, ministry.id).run();
  ministry.receipts_folder_id = f.id;
  return f.id;
}

/** «Чеки…/Листопад 26» — створюється при першому чеку місяця. */
export async function monthFolderId(env, ministry, iso) {
  const name = `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;
  return cachedFolder(env, `mf:${ministry.id}:${name}`, await receiptsFolderId(env, ministry), name);
}

/** «Чеки…/_Завантаження» — фото, додані на сторінці, але ще не надіслані. */
export async function preUploadFolderId(env, ministry) {
  return cachedFolder(env, `pre:${ministry.id}`, await receiptsFolderId(env, ministry), '_Завантаження');
}

/**
 * Одноразові сесії завантаження в Диск: браузер надсилає фото напряму, не через Worker.
 * specs: [{f:{mimeType,size}, parent, name, description, props}] → [url].
 */
export async function openUploadSessions(env, specs, origin) {
  const token = await accessToken(env);
  return Promise.all(specs.map(async sp => {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': sp.f.mimeType, 'X-Upload-Content-Length': String(Number(sp.f.size)), Origin: origin,
      },
      body: JSON.stringify({ name: sp.name, parents: [sp.parent], description: sp.description, appProperties: sp.props }),
    });
    const loc = res.headers.get('Location');
    if (!res.ok || !loc) throw new UserError('Не вдалося підготувати завантаження фото. Спробуйте ще раз.');
    return loc;
  }));
}

/** Фото, що прийшло в самому запиті (запасний шлях, коли пряме завантаження не вдалося). */
export async function uploadInline(env, { parent, name, mimeType, description, props, bytes }) {
  const boundary = 'zvit' + crypto.randomUUID();
  const meta = JSON.stringify({ name, parents: [parent], description, appProperties: props, mimeType });
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  return gapi(env, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
}

// ---------------- Таблиці ----------------
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
export const sheetsGet = (env, id, params) => gapi(env, `${SHEETS}/${q(id)}?${params}`);
export const sheetsValues = (env, id, ranges, opts = 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER') =>
  gapi(env, `${SHEETS}/${q(id)}/values:batchGet?${opts}&` + ranges.map(r => 'ranges=' + q(r)).join('&'));
export const sheetsBatchUpdate = (env, id, requests) => gapi(env, `${SHEETS}/${q(id)}:batchUpdate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }),
});

/** Копія «Звіт.xlsx» → Google-таблиця «Звіт 26-27» у папці служіння. */
export async function copyAsSheet(env, fileId, parent, name) {
  return gapi(env, `${DRIVE}/files/${q(fileId)}/copy?supportsAllDrives=true&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [parent] }),
  });
}
