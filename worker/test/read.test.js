import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { api, seed } from './helpers.js';

beforeEach(seed);

describe('вхід і доступ', () => {
  it('без токена — помилка входу', async () => {
    const r = await (await SELF.fetch('https://api.test/', { method: 'POST', body: '{"fn":"getInitData"}' })).json();
    expect(r).toMatchObject({ ok: false, auth: true });
  });
  it('сміттєвий токен — помилка входу без звернення до сервісів', async () => {
    const r = await (await SELF.fetch('https://api.test/', { method: 'POST', body: JSON.stringify({ fn: 'getInitData', token: 'a.b.c' }) })).json();
    expect(r).toMatchObject({ ok: false, auth: true });
  });
  it('пошта не зі списку — відмова', async () => {
    expect(await api('stranger@ubchurch.lviv.ua', 'getInitData')).toMatchObject({ ok: false, auth: true });
  });
  it('невідома дія — помилка, не виняток', async () => {
    expect(await api('luba@ubchurch.lviv.ua', 'dropTables')).toMatchObject({ ok: false, error: 'Невідома дія.' });
  });
  it('CORS — лише для сайту', async () => {
    const ok = await SELF.fetch('https://api.test/', { method: 'POST', body: '{}', headers: { Origin: 'https://budget.ubchurch.lviv.ua' } });
    const bad = await SELF.fetch('https://api.test/', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://budget.ubchurch.lviv.ua');
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('getInitData', () => {
  it('Люба бачить обидва свої служіння, не адмін', async () => {
    const r = await api('luba@ubchurch.lviv.ua', 'getInitData');
    expect(r.ok).toBe(true);
    expect(r.result.isAdmin).toBe(false);
    expect(r.result.ministries.map(m => m.id)).toEqual(['m2', 'm1']); // порядок таблиці служінь
    expect(r.result).toMatchObject({ minDate: '2026-10-01', maxDate: '2027-09-30', editWindowH: 24, order: { telegram: 'test' } });
    expect((await env.DB.prepare("SELECT at FROM seen WHERE email='luba@ubchurch.lviv.ua'").first()).at).toBeGreaterThan(0);
  });
  it('адмін без служіння входить', async () => {
    const r = await api('admin@ubchurch.lviv.ua', 'getInitData');
    expect(r.result).toMatchObject({ isAdmin: true, ministries: [] });
  });
});

describe('getCategories', () => {
  it('категорії, витрачено, баланс, місяці й операції у формі старого API', async () => {
    const r = (await api('luba@ubchurch.lviv.ua', 'getCategories', 'm1')).result;
    expect(r.categories).toEqual([
      { name: '3401 Події/заходи', plan: 5000, spent: 2559.87, left: 2440.13 },
      { name: '3402 Зустрічі', plan: 2000, spent: 0, left: 2000 },
    ]);
    expect(r.months).toHaveLength(12);
    expect(r.months[0]).toEqual({ name: 'Жовтень', income: 0, expense: 924.87 });
    expect(r.months[1]).toEqual({ name: 'Листопад', income: 20000, expense: 1635 });
    expect(r.ops.map(o => o.id)).toEqual(['o3', 'o2', 'o1']); // новіші першими
    const o3 = r.ops[0];
    expect(o3).toMatchObject({ month: 'Листопад', expense: 1635, income: 0, receipt: 'https://drive.google.com/file/d/fileB/view',
      by: 'luba@ubchurch.lviv.ua', status: 'submitted', editable: true, deletable: true });
    expect(r.ops[1].description).toBe('Аванс: Залишок з табору');
    expect(r.ops[2]).toMatchObject({ by: '', editable: false, deletable: false }); // імпортований рядок без автора
  });
  it('чуже служіння — заборонено', async () => {
    expect(await api('luba@ubchurch.lviv.ua', 'getCategories', 'm3')).toMatchObject({ ok: false, error: 'Оберіть своє служіння.' });
  });
  it('баланс = початковий залишок + аванси − витрати', async () => {
    const r = (await api('media@ubchurch.lviv.ua', 'getCategories', 'm3')).result;
    expect(r.balance.amount).toBeCloseTo(9202.5 - 12971.81, 2);
  });
});

describe('адмінка', () => {
  it('лідер не має доступу до admin*', async () => {
    for (const fn of ['adminListMinistries', 'adminStats', 'adminMinistryDetail']) {
      expect(await api('luba@ubchurch.lviv.ua', fn, 'm1')).toMatchObject({ ok: false, error: 'Немає доступу адміністратора.' });
    }
  });
  it('список, підсумок і деталі', async () => {
    const list = (await api('admin@ubchurch.lviv.ua', 'adminListMinistries')).result;
    expect(list.map(m => m.id)).toEqual(['m2', 'm1', 'm3']); // у порядку таблиці служінь
    expect(list.find(m => m.id === 'm2').users.map(u => u.email)).toEqual(['luba@ubchurch.lviv.ua', 'helper@ubchurch.lviv.ua']);
    const sum = (await api('admin@ubchurch.lviv.ua', 'adminMinistrySummary', 'm1')).result;
    expect(sum).toMatchObject({ id: 'm1', status: 'ok', plan: 7000, spent: 2559.87, over: 0, count: 3, noReceipt: 0, unchecked: 3 });
    const det = (await api('admin@ubchurch.lviv.ua', 'adminMinistryDetail', 'm1')).result;
    expect(det).toMatchObject({ status: 'ok', reportUrl: 'https://docs.google.com/spreadsheets/d/sheet1/edit', count: 3 });
    expect(det.ops.every(o => o.editable === false)).toBe(true);
  });
});

describe('сесії', () => {
  it('сесія з Google-входу працює, з іншої сесії — ні, після виходу — недійсна', async () => {
    const s = (await api('luba@ubchurch.lviv.ua', 'startSession')).result;
    expect(s.session).toMatch(/^[0-9a-f]{64}$/);
    expect((await api({ session: s.session }, 'getInitData')).result.email).toBe('luba@ubchurch.lviv.ua');
    expect(await api({ session: s.session }, 'startSession')).toMatchObject({ ok: false, auth: true });
    const row = await env.DB.prepare('SELECT hash FROM sessions').first();
    expect(row.hash).not.toContain(s.session);
    await api({ session: s.session }, 'endSession');
    expect(await api({ session: s.session }, 'getInitData')).toMatchObject({ ok: false, auth: true });
  });
  it('не більше 5 пристроїв', async () => {
    for (let i = 0; i < 7; i++) await api('luba@ubchurch.lviv.ua', 'startSession');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM sessions').first()).n).toBe(5);
  });
});
