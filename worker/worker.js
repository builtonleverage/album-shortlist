// Album Picker API: a Cloudflare Worker in front of a D1 database.
// Bindings needed: DB (D1 database), KEY (secret text: the family password).

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT NOT NULL, on_disk INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, dropped_by TEXT, ts INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS photos_ts ON photos(ts)',
  'CREATE INDEX IF NOT EXISTS photos_event ON photos(event_id)',
  'CREATE TABLE IF NOT EXISTS thumbs(photo_id TEXT PRIMARY KEY, data BLOB NOT NULL)',
  'CREATE TABLE IF NOT EXISTS votes(photo_id TEXT NOT NULL, voter TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL, PRIMARY KEY(photo_id, voter))',
  'CREATE INDEX IF NOT EXISTS votes_ts ON votes(ts)',
  'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }
});
const photoRow = r => [r.id, r.event_id, r.name, r.on_disk, r.dropped, r.dropped_by];
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

async function handle(req, env, url) {
  const db = env.DB, p = url.pathname, q = url.searchParams, now = Date.now();
  const body = async () => { try { return await req.json(); } catch (e) { return {}; } };

  if (p === '/api/state') {
    const [ev, ph, vo, se] = await db.batch([
      db.prepare('SELECT id,name FROM events ORDER BY created'),
      db.prepare('SELECT id,event_id,name,on_disk,dropped,dropped_by FROM photos'),
      db.prepare('SELECT photo_id,voter FROM votes WHERE active=1'),
      db.prepare('SELECT key,value FROM settings')
    ]);
    return json({ now, events: ev.results, photos: ph.results.map(photoRow),
      votes: vo.results.map(r => [r.photo_id, r.voter]), settings: se.results });
  }

  if (p === '/api/changes') {
    const since = Number(q.get('since')) || 0;
    const [ev, ph, vo, se] = await db.batch([
      db.prepare('SELECT id,name FROM events ORDER BY created'),
      db.prepare('SELECT id,event_id,name,on_disk,dropped,dropped_by FROM photos WHERE ts>=?').bind(since),
      db.prepare('SELECT photo_id,voter,active FROM votes WHERE ts>=?').bind(since),
      db.prepare('SELECT key,value FROM settings')
    ]);
    return json({ now, events: ev.results, photos: ph.results.map(photoRow),
      votes: vo.results.map(r => [r.photo_id, r.voter, r.active]), settings: se.results });
  }

  if (p === '/api/thumb') {
    const row = await db.prepare('SELECT data FROM thumbs WHERE photo_id=?').bind(q.get('id') || '').first();
    if (!row) return new Response('not found', { status: 404, headers: CORS });
    const bytes = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data);
    return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', ...CORS } });
  }

  if (req.method !== 'POST') return json({ error: 'not found' }, 404);

  if (p === '/api/events') {
    const name = text((await body()).name, 60);
    if (!name) return json({ error: 'event name missing' }, 400);
    const id = 'e' + now.toString(36);
    await db.prepare('INSERT INTO events(id,name,created) VALUES(?,?,?)').bind(id, name, now).run();
    return json({ id, name });
  }

  if (p === '/api/events/delete') {
    const id = text((await body()).id, 40);
    await db.batch([
      db.prepare('DELETE FROM votes WHERE photo_id IN (SELECT id FROM photos WHERE event_id=?)').bind(id),
      db.prepare('DELETE FROM thumbs WHERE photo_id IN (SELECT id FROM photos WHERE event_id=?)').bind(id),
      db.prepare('DELETE FROM photos WHERE event_id=?').bind(id),
      db.prepare('DELETE FROM events WHERE id=?').bind(id)
    ]);
    return json({ ok: true });
  }

  if (p === '/api/photo') {
    const event = text(q.get('event'), 40), name = text(q.get('name'), 200);
    const buf = await req.arrayBuffer();
    if (!event || !name) return json({ error: 'event or name missing' }, 400);
    if (!buf.byteLength || buf.byteLength > 400000) return json({ error: 'thumbnail too large' }, 413);
    const ev = await db.prepare('SELECT id FROM events WHERE id=?').bind(event).first();
    if (!ev) return json({ error: 'event not found' }, 404);
    const id = event + '|' + name.toLowerCase();
    await db.batch([
      db.prepare('INSERT INTO photos(id,event_id,name,ts) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts').bind(id, event, name, now),
      db.prepare('INSERT INTO thumbs(photo_id,data) VALUES(?,?) ON CONFLICT(photo_id) DO UPDATE SET data=excluded.data').bind(id, buf)
    ]);
    return json({ id });
  }

  if (p === '/api/vote') {
    const b = await body(), id = text(b.id, 260), voter = text(b.voter, 40);
    if (!id || !voter) return json({ error: 'photo or name missing' }, 400);
    await db.prepare('INSERT INTO votes(photo_id,voter,active,ts) VALUES(?,?,?,?) ON CONFLICT(photo_id,voter) DO UPDATE SET active=excluded.active, ts=excluded.ts')
      .bind(id, voter, b.on ? 1 : 0, now).run();
    return json({ ok: true });
  }

  if (p === '/api/drop') {
    const b = await body();
    await db.prepare('UPDATE photos SET dropped=?, dropped_by=?, ts=? WHERE id=?')
      .bind(b.on ? 1 : 0, b.on ? text(b.by, 40) : null, now, text(b.id, 260)).run();
    return json({ ok: true });
  }

  if (p === '/api/mark') {
    const ids = ((await body()).ids || []).slice(0, 80).map(x => text(x, 260));
    if (ids.length) {
      await db.prepare('UPDATE photos SET on_disk=1, ts=? WHERE id IN (' + ids.map(() => '?').join(',') + ')').bind(now, ...ids).run();
    }
    return json({ ok: true, count: ids.length });
  }

  if (p === '/api/settings') {
    const n = parseInt((await body()).albumTarget, 10);
    if (!(n > 0)) return json({ error: 'album total missing' }, 400);
    await db.prepare("INSERT INTO settings(key,value) VALUES('albumTarget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(n)).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/api/ping') return json({ ok: true, service: 'album-picker' });
    if (!url.pathname.startsWith('/api/')) {
      // Everything outside /api/ is the app itself (static files), when deployed with them.
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Album Picker API is running.', { headers: CORS });
    }
    if (!env.DB) return json({ error: 'database binding DB is missing' }, 500);
    if (!env.KEY || url.searchParams.get('k') !== env.KEY) return json({ error: 'wrong password' }, 401);
    try {
      return await handle(req, env, url);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/no such table/i.test(msg)) {
        await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
        if (req.method === 'GET') return await handle(req, env, url);
        return json({ error: 'database was just set up, try again' }, 503);
      }
      return json({ error: msg }, 500);
    }
  }
};
