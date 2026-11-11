import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { api, seed } from './helpers.js';
import { recordStat } from '../src/stats.js';

beforeEach(seed);

describe('статистика', () => {
  it('лічильники, помилки, унікальні люди — у формі дешборду', async () => {
    await recordStat(env, 'getInitData', 'luba@ubchurch.lviv.ua', null, { ok: true }, 120);
    await recordStat(env, 'submitExpenses', 'luba@ubchurch.lviv.ua', null, { ok: true }, 900);
    await recordStat(env, 'submitExpenses', 'helper@ubchurch.lviv.ua', new Error('x'), { ok: false, error: 'Сталася помилка' }, 300);
    await recordStat(env, '', '', Object.assign(new Error('bad'), { auth: true }), { ok: false }, 20);
    await env.DB.prepare("INSERT INTO sessions (hash, email, exp) VALUES ('h1', 'luba@ubchurch.lviv.ua', ?)").bind(Date.now() + 1e6).run();
    const st = (await api('admin@ubchurch.lviv.ua', 'adminStats')).result;
    const td = st.days[st.days.length - 1];
    expect(td).toMatchObject({ n: 4, e: 1, a: 1, x: 900, users: 1, avg: Math.round(1340 / 4) });
    expect(st.days).toHaveLength(60);
    expect(st.errors[0]).toMatchObject({ fn: 'submitExpenses', m: 'Сталася помилка' });
    expect(st.fnWeek).toMatchObject({ getInitData: 1, submitExpenses: 2, '—': 1 });
    const luba = st.people.find(p => p.email === 'luba@ubchurch.lviv.ua');
    expect(luba).toMatchObject({ devices: 1, church: true });
    expect(luba.ministries.sort()).toEqual(['Дитячий клуб', 'Діти з інвалідністю'].sort());
    expect(st.people.some(p => p.email === 'admin@ubchurch.lviv.ua')).toBe(true);
    const hashes = await env.DB.prepare('SELECT hash FROM stat_users').all();
    expect(JSON.stringify(hashes.results)).not.toContain('@'); // пошти не зберігаються
  });
});
