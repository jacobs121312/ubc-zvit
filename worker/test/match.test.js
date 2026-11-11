import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seed } from './helpers.js';
import { withGoogle } from './fakeGoogle.js';
import { proposeMatches, applyMatches } from '../src/match.js';

beforeEach(seed);
afterEach(() => vi.restoreAllMocks());
const F = 'application/vnd.google-apps.folder';

describe('прив\'язка чеків з папок', () => {
  it('однозначні — за сумою з копійками/датою; голе число й дублікати — на ручний розбір', async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM op_receipts WHERE op_id = 'o1'"),
      env.DB.prepare(`INSERT INTO ops (id, ministry_id, type, date, amount, category, description, has_receipt, created_at)
        VALUES ('p1','m1','expense','2026-11-02',1234,'3401 Події/заходи','папір',1,0), ('p2','m1','expense','2026-11-03',50,'3401 Події/заходи','чай',1,0),
               ('p3','m1','expense','2026-11-04',50,'3401 Події/заходи','кава',1,0)`),
    ]);
    await withGoogle({ files: {
      c: { id: 'c', name: 'Чеки', mimeType: F, parents: ['m1'] },
      a: { id: 'a', name: '30.10.26 - 924,87.JPG', mimeType: 'image/jpeg', parents: ['c'] },     // o1 — сума+дата
      b: { id: 'b', name: 'IMG_1234.jpg', mimeType: 'image/jpeg', parents: ['c'] },              // p1 — лише голе число
      d: { id: 'd', name: '50,00 грн.jpg', mimeType: 'image/jpeg', parents: ['c'] },             // p2/p3 — дві витрати по 50
      used: { id: 'fileB', name: '1635 грн.jpg', mimeType: 'image/jpeg', parents: ['c'] },       // уже прив'язаний до o3
    } });
    const p = await proposeMatches(env, 'm1');
    expect(p.matched.map(m => [m.op.id, m.file.id])).toEqual([['o1', 'a']]);
    expect(p.ambiguous.map(a => a.op.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(await applyMatches(env, 'm1', p.matched)).toBe(1);
    expect((await env.DB.prepare("SELECT file_id FROM op_receipts WHERE op_id = 'o1'").first()).file_id).toBe('a');
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM outbox WHERE kind = 'upsert_op'").first()).n).toBe(1);
  });
});
