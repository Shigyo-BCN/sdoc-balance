// 阿秋的数据小站 —— 投票后端（Cloudflare Pages Functions 版）
// 挂在 sdoc-balance-web.pages.dev 自己的域名下，路径 /api/votes 与 /api/vote，
// 不经过 workers.dev（大陆常打不开），也不跨域。
//
// Pages 项目需要配置两项：
//   DB        —— D1 数据库绑定（数据库 sdbal-votes）
//   VOTE_SALT —— 环境变量/Secret，随便一串随机字符（用来把 IP 哈希成匿名 voter id）
//
// 2026-11-19 改版：一人一天一票（按北京时间自然日翻篇）
//   · 当天投过的票，当天可以随便改方向、也可以取消（再点一次＝取消）
//   · 过了北京时间 0 点，那一天的行就锁死不再变；新的一天可以再投一票
//   · 卡片上的「夯爆了 / 拉完了」= 全表累计计数（会随天数增长）
//   · 每人每分钟最多 20 次写（rate 表限速，超限 429）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

// 北京时间自然日 YYYY-MM-DD（UTC+8，无夏令时）
const bjDay = (ms = Date.now()) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function voterId(req, salt) {
  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('x-forwarded-for') || '0.0.0.0';
  const ua = (req.headers.get('User-Agent') || '').slice(0, 120);
  const data = new TextEncoder().encode(ip + '|' + ua + '|' + salt);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 表结构 + 一次性迁移（把旧的「一人一票」表 votes 的存量搬进 vote_daily，记为 legacy 天）
let schemaReady = null;
async function ensureSchema(db) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS vote_daily (
      unit TEXT NOT NULL, voter TEXT NOT NULL, day TEXT NOT NULL,
      dir TEXT NOT NULL, ts INTEGER NOT NULL,
      PRIMARY KEY (unit, voter, day))`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_vote_daily_unit ON vote_daily (unit)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`).run();
    const done = await db.prepare(`SELECT v FROM meta WHERE k = 'mig_daily_1'`).first();
    if (!done) {
      try {
        await db.prepare(`INSERT OR IGNORE INTO vote_daily (unit, voter, day, dir, ts)
          SELECT unit, voter, 'legacy', dir, ts FROM votes`).run();
      } catch (e) { /* 老表不存在就跳过 */ }
      await db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('mig_daily_1', '1')`).run();
    }
    return true;
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

// 计数＝vote_daily 全表累计；同时把「今天」的票顺便查出来，供前端显示自己投过没
async function counts(db, ids, voter) {
  const out = {};
  for (const id of ids) out[id] = { up: 0, dn: 0, mine: null };
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT unit, dir, COUNT(*) AS n FROM vote_daily WHERE unit IN (${ph}) GROUP BY unit, dir`
  ).bind(...ids).all();
  for (const r of results || []) {
    if (out[r.unit] && (r.dir === 'up' || r.dir === 'dn')) out[r.unit][r.dir] = r.n;
  }
  if (voter) {
    const today = bjDay();
    const mine = await db.prepare(
      `SELECT unit, dir FROM vote_daily WHERE voter = ? AND day = ? AND unit IN (${ph})`
    ).bind(voter, today, ...ids).all();
    for (const r of mine.results || []) if (out[r.unit]) out[r.unit].mine = r.dir;
  }
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const isApi = url.pathname === '/api/votes' || url.pathname === '/api/vote';

    if (!isApi) {
      // 其余请求交给静态资源（index.html）
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response('Not found', { status: 404 });
    }

    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const db = env.DB;
    if (!db) return json({ ok: false, error: 'DB 未绑定' }, 500);
    const salt = env.VOTE_SALT || 'change-me';
    await ensureSchema(db);

    if (req.method === 'GET' && url.pathname === '/api/votes') {
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
      const voter = ids.length ? await voterId(req, salt) : null;
      const out = await counts(db, ids, voter);
      out.today = bjDay();
      return json(out);
    }

    if (req.method === 'POST' && url.pathname === '/api/vote') {
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      const unit = String(body.unit || '').trim().slice(0, 40);
      const dir = body.dir === 'up' || body.dir === 'dn' ? body.dir : null;
      if (!unit) return json({ ok: false, error: 'unit required' }, 400);

      const voter = await voterId(req, salt);
      const now = Date.now();
      const day = bjDay(now);
      const rl = await db.prepare(`SELECT COUNT(*) AS n FROM rate WHERE voter = ? AND ts > ?`).bind(voter, now - 60000).first();
      if (rl && rl.n >= 20) return json({ ok: false, error: '慢一点，稍后再试' }, 429);
      await db.prepare(`INSERT INTO rate (voter, ts) VALUES (?, ?)`).bind(voter, now).run();
      await db.prepare(`DELETE FROM rate WHERE ts < ?`).bind(now - 600000).run();

      if (dir === null) {
        // 取消：只删「今天」这一票，历史日的票保持不动
        await db.prepare(`DELETE FROM vote_daily WHERE unit = ? AND voter = ? AND day = ?`).bind(unit, voter, day).run();
      } else {
        // 只写今天这一行；历史日无法被覆盖，所以“过了 0 点就锁死”是天然的
        await db.prepare(
          `INSERT INTO vote_daily (unit, voter, day, dir, ts) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(unit, voter, day) DO UPDATE SET dir = excluded.dir, ts = excluded.ts`
        ).bind(unit, voter, day, dir, now).run();
      }

      const c = await counts(db, [unit], voter);
      return json({ ok: true, ...c[unit], day, votedAt: now });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
