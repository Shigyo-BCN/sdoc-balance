// 阿秋的数据小站 —— 投票后端（Cloudflare Pages Functions 版）
// 挂在 sdoc-balance-web.pages.dev 自己的域名下，路径 /api/votes 与 /api/vote，
// 不经过 workers.dev（大陆常打不开），也不跨域。
//
// Pages 项目需要配置两项：
//   DB        —— D1 数据库绑定（数据库 sdbal-votes）
//   VOTE_SALT —— 环境变量/Secret，随便一串随机字符（用来把 IP 哈希成匿名 voter id）
//
// 行为：一台机体一人一票；改方向覆盖旧票；dir=null 取消；每人每分钟最多 20 次写。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

async function voterId(req, salt) {
  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('x-forwarded-for') || '0.0.0.0';
  const ua = (req.headers.get('User-Agent') || '').slice(0, 120);
  const data = new TextEncoder().encode(ip + '|' + ua + '|' + salt);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function counts(db, ids) {
  const out = {};
  for (const id of ids) out[id] = { up: 0, dn: 0 };
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT unit, dir, COUNT(*) AS n FROM votes WHERE unit IN (${ph}) GROUP BY unit, dir`
  ).bind(...ids).all();
  for (const r of results || []) {
    if (out[r.unit] && (r.dir === 'up' || r.dir === 'dn')) out[r.unit][r.dir] = r.n;
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

    if (req.method === 'GET' && url.pathname === '/api/votes') {
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
      return json(await counts(db, ids));
    }

    if (req.method === 'POST' && url.pathname === '/api/vote') {
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      const unit = String(body.unit || '').trim().slice(0, 40);
      const dir = body.dir === 'up' || body.dir === 'dn' ? body.dir : null;
      if (!unit) return json({ ok: false, error: 'unit required' }, 400);

      const voter = await voterId(req, salt);
      const now = Date.now();
      const rl = await db.prepare(`SELECT COUNT(*) AS n FROM rate WHERE voter = ? AND ts > ?`).bind(voter, now - 60000).first();
      if (rl && rl.n >= 20) return json({ ok: false, error: '慢一点，稍后再试' }, 429);
      await db.prepare(`INSERT INTO rate (voter, ts) VALUES (?, ?)`).bind(voter, now).run();
      await db.prepare(`DELETE FROM rate WHERE ts < ?`).bind(now - 600000).run();

      if (dir === null) {
        await db.prepare(`DELETE FROM votes WHERE unit = ? AND voter = ?`).bind(unit, voter).run();
      } else {
        await db.prepare(
          `INSERT INTO votes (unit, voter, dir, ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(unit, voter) DO UPDATE SET dir = excluded.dir, ts = excluded.ts`
        ).bind(unit, voter, dir, now).run();
      }

      const c = await counts(db, [unit]);
      return json({ ok: true, ...c[unit], mine: dir, votedAt: now });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
