// 눈사람 마을 서버 (Cloudflare Workers + Durable Objects)
// - 게임 파일(public/)은 정적 파일로 무료 제공
// - 마을 주소는 /01, /02 … (화면은 같고, 접속할 때 /ws?v=마을번호 로 붙음)
// - /ws?v=마을번호 로 들어오면 그 마을의 Durable Object 하나가 접속·저장을 모두 맡음
//   · 실시간 위치(presence) 중계: 받은 걸 다른 사람에게 바로 뿌림(보내는 메시지는 무료)
//   · 저장소: 마을마다 SQLite 표 하나(docs)에 문서를 JSON으로 보관
//   · 쓰기 규칙: 내 문서(snowmen/내아이디 등)만 쓸 수 있음. 관리자 열쇠가 있으면 전부
// - WebSocket Hibernation API를 써서 조용할 땐 비용이 거의 안 나감
import { DurableObject } from 'cloudflare:workers';

const MAX_DOC_BYTES = 48 * 1024;      // 문서 하나 크기 상한
const MAX_PRES_BYTES = 4 * 1024;      // 실시간 상태 한 번 크기 상한
const WRITE_BURST = 12, WRITE_REFILL_MS = 1000; // 쓰기: 순간 12번, 1초에 1번씩 회복
const PRES_MIN_MS = 90;               // 실시간 상태: 한 사람당 초당 약 11번까지
const OWN = new Set(['snowmen', 'likes', 'notes', 'refill', 'giant', 'reports']); // 각자 자기 문서만
const PRIVATE = new Set(['reports']); // 관리자와 본인만 읽기
const SHARED = new Set(['hall', 'arena']);                             // 누구나(접속자) 쓰기
const ADMIN_ONLY = new Set(['config']);                                // 관리자만

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      const v = String(Math.max(1, Math.min(999, parseInt(url.searchParams.get('v') || '1', 10) || 1)));
      const stub = env.VILLAGE.get(env.VILLAGE.idFromName('village-' + v));
      return stub.fetch(req);
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true });
    // 마을 주소: /01, /02 … (게임 채널처럼). 같은 게임 화면을 주고, 몇 번 마을인지는 net.js 가 주소에서 읽어요
    const vm = url.pathname.match(/^\/(\d{1,3})(\/?)$/);
    if (vm) {
      if (vm[2]) return Response.redirect(new URL('/' + vm[1] + url.search, url).toString(), 301); // /01/ → /01
      return env.ASSETS.fetch(new Request(new URL('/' + url.search, url), req));
    }
    return env.ASSETS.fetch(req);
  },
};

async function uidFromSecret(secret) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('snowtown:' + secret));
  const b = btoa(String.fromCharCode(...new Uint8Array(d))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
  return 'u_' + b.slice(0, 20);
}
const enc = o => JSON.stringify(o);
// 서버에서도 욕설을 가림(게임 화면 필터를 우회해도 다른 사람에겐 가려진 채로 전달)
const BAD_WORDS = ['씨발', '시발', '씨팔', '시팔', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '개새끼', '좆', '존나', 'ㅈㄴ', '지랄', '미친놈', '미친년', 'fuck', 'shit', 'bitch'];
const escRe = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function makeMask(extra) {
  const all = [...BAD_WORDS, ...(Array.isArray(extra) ? extra : [])].map(w => String(w).trim()).filter(w => w && w.length < 30).slice(0, 200);
  const re = new RegExp(all.map(escRe).join('|'), 'gi');
  return t => (typeof t === 'string' && t ? t.replace(re, m => '♡'.repeat(Math.min(3, [...m].length))) : t);
}

export class Village extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, col TEXT NOT NULL, data TEXT NOT NULL, t INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS docs_col ON docs(col)');
    this.pres = new Map();   // peer -> 마지막 실시간 상태(메모리, 잠들면 사라지고 'need'로 다시 받음)
    this.locks = new Map();  // path -> { holder, until }
    this.rate = new Map();   // peer -> { tokens, at, presAt }
    this.mod = null;         // config/mod 캐시
  }

  getMod() {
    if (!this.mod) {
      const r = this.sql.exec("SELECT data FROM docs WHERE path = 'config/mod'").toArray()[0];
      let m = {}; try { m = r ? JSON.parse(r.data) : {}; } catch { m = {}; }
      this.mod = { banned: Array.isArray(m.banned) ? m.banned : [], mask: makeMask(m.words) };
    }
    return this.mod;
  }
  cleanDoc(path, d) {
    const col = path.split('/')[0], mask = this.getMod().mask;
    if (col === 'snowmen') {
      if (typeof d.nk === 'string') d.nk = mask(d.nk);
      if (Array.isArray(d.items)) for (const it of d.items) if (it && typeof it === 'object') { if (typeof it.nm === 'string') it.nm = mask(it.nm); if (typeof it.ms === 'string') it.ms = mask(it.ms); }
      if (Array.isArray(d.pc)) for (const c of d.pc) if (c && typeof c.tx === 'string') c.tx = mask(c.tx); // 엽서 글
      if (Array.isArray(d.orn)) for (const o of d.orn) if (Array.isArray(o) && typeof o[3] === 'string') o[3] = mask(o[3]); // 트리 장식 소원
    } else if (col === 'notes' && Array.isArray(d.items)) {
      for (const n of d.items) if (n && typeof n.tx === 'string') n.tx = mask(n.tx);
    }
    return d;
  }

  cap() { return Math.max(2, parseInt(this.env.VILLAGE_CAP || '40', 10) || 40); }

  async fetch(req) {
    const url = new URL(req.url);
    const secret = (url.searchParams.get('k') || '').slice(0, 128);
    if (secret.length < 16) return new Response('bad key', { status: 400 });
    const uid = await uidFromSecret(secret);
    const adminKey = this.env.ADMIN_KEY || '';
    const admin = !!adminKey && url.searchParams.get('a') === adminKey;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const live = this.ctx.getWebSockets();
    // 같은 사람의 이전 탭은 그대로 두되, 마을 정원은 사람 수로 셈
    const people = new Set(live.map(w => (w.deserializeAttachment() || {}).uid).filter(Boolean));
    if (!people.has(uid) && people.size >= this.cap() && !admin) {
      this.ctx.acceptWebSocket(server, ['full']);
      server.send(enc({ t: 'full', cap: this.cap() }));
      server.close(4001, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const peer = 'p_' + crypto.randomUUID().slice(0, 12);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid, admin, peer, subs: [], docs: [] });
    const banned = this.isBanned(uid);
    server.send(enc({ t: 'hello', uid, admin, peer, banned, cap: this.cap(), people: people.size + (people.has(uid) ? 0 : 1) }));
    // 지금 있는 사람들의 상태: 메모리에 있으면 바로 주고, 없으면 다들 한 번 다시 보내 달라고 부탁
    let missing = false;
    for (const w of live) {
      const a = w.deserializeAttachment(); if (!a || !a.peer) continue;
      const p = this.pres.get(a.peer);
      if (p) server.send(enc({ t: 'pres', peer: a.peer, by: a.uid, p }));
      else missing = true;
    }
    if (missing) this.broadcast({ t: 'need' }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  isBanned(uid) { return this.getMod().banned.includes(uid); }
  canRead(a, path) {
    const [col, id] = path.split('/');
    if (!PRIVATE.has(col)) return true;
    return a.admin || (id && id === a.uid);
  }

  broadcast(msg, except = null) {
    const s = typeof msg === 'string' ? msg : enc(msg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      const a = w.deserializeAttachment(); if (!a || !a.peer) continue;
      try { w.send(s); } catch { /* 끊긴 연결 */ }
    }
  }

  allowWrite(a) {
    const now = Date.now();
    const r = this.rate.get(a.peer) || { tokens: WRITE_BURST, at: now, presAt: 0 };
    r.tokens = Math.min(WRITE_BURST, r.tokens + (now - r.at) / WRITE_REFILL_MS); r.at = now;
    this.rate.set(a.peer, r);
    if (r.tokens < 1) return false;
    r.tokens -= 1; return true;
  }

  canWrite(a, path) {
    const seg = path.split('/');
    if (seg.length !== 2 || !seg[0] || !seg[1] || seg[1].length > 80) return false;
    if (a.admin) return true;
    if (this.isBanned(a.uid)) return false;
    if (OWN.has(seg[0])) return seg[1] === a.uid;
    if (SHARED.has(seg[0])) return true;
    if (ADMIN_ONLY.has(seg[0])) return false;
    return false;
  }

  colSnapshot(col) {
    return this.sql.exec('SELECT path, data FROM docs WHERE col = ?', col).toArray()
      .map(r => ({ id: r.path.slice(col.length + 1), d: JSON.parse(r.data) }));
  }
  docSnapshot(path) {
    const r = this.sql.exec('SELECT data FROM docs WHERE path = ?', path).toArray()[0];
    return r ? JSON.parse(r.data) : null;
  }
  notify(path, data) {
    const col = path.split('/')[0];
    const s = enc({ t: 'doc', path, d: data });
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment(); if (!a || !a.peer) continue;
      if (!this.canRead(a, path)) continue;
      if (a.subs.includes(col) || a.docs.includes(path)) { try { w.send(s); } catch { /* 무시 */ } }
    }
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment(); if (!a || !a.peer) return;
    if (typeof raw !== 'string' || raw.length > MAX_DOC_BYTES + 512) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const reply = (o) => { try { ws.send(enc(o)); } catch { /* 무시 */ } };
    switch (m.t) {
      case 'pres': {
        if (!m.p || typeof m.p !== 'object') return;
        if (raw.length > MAX_PRES_BYTES + 64) return;
        const now = Date.now(), r = this.rate.get(a.peer) || { tokens: WRITE_BURST, at: now, presAt: 0 };
        const mask = this.getMod().mask;
        if (typeof m.p.nk === 'string') m.p.nk = mask(m.p.nk);
        if (m.p.ch && typeof m.p.ch === 'object') { if (this.isBanned(a.uid)) delete m.p.ch; else if (typeof m.p.ch.t === 'string') m.p.ch.t = mask(m.p.ch.t); }
        // 마지막 상태는 언제나 기억. 너무 잦게 오면(망에서 몰려 도착해도) 버리지 않고 잠깐 뒤에 마지막 것만 보냄
        this.pres.set(a.peer, m.p);
        if (now - r.presAt < PRES_MIN_MS) {
          if (!r.timer) r.timer = setTimeout(() => {
            r.timer = 0; r.presAt = Date.now(); const p = this.pres.get(a.peer);
            if (p) this.broadcast(enc({ t: 'pres', peer: a.peer, by: a.uid, p }), ws);
          }, PRES_MIN_MS - (now - r.presAt));
          this.rate.set(a.peer, r); return;
        }
        r.presAt = now; this.rate.set(a.peer, r);
        this.broadcast(enc({ t: 'pres', peer: a.peer, by: a.uid, p: m.p }), ws);
        return;
      }
      case 'sub': {
        const col = String(m.col || '').split('/')[0]; if (!col || col.length > 40) return;
        if (PRIVATE.has(col) && !a.admin) return reply({ t: 'col', col, docs: [] });
        if (!a.subs.includes(col)) { a.subs.push(col); ws.serializeAttachment(a); }
        reply({ t: 'col', col, docs: this.colSnapshot(col) });
        return;
      }
      case 'subdoc': {
        const path = String(m.path || ''); if (path.split('/').length !== 2 || !this.canRead(a, path)) return;
        if (!a.docs.includes(path)) { a.docs.push(path); ws.serializeAttachment(a); }
        reply({ t: 'doc', path, d: this.docSnapshot(path) });
        return;
      }
      case 'get': {
        const path = String(m.path || '');
        reply({ t: 'res', id: m.id, ok: true, d: path.split('/').length === 2 && this.canRead(a, path) ? this.docSnapshot(path) : null });
        return;
      }
      case 'set': case 'update': case 'del': {
        const path = String(m.path || '');
        if (!this.canWrite(a, path)) return reply({ t: 'res', id: m.id, ok: false, code: 'invalid_argument' });
        if (!this.allowWrite(a)) return reply({ t: 'res', id: m.id, ok: false, code: 'resource_exhausted' });
        let data = null;
        if (m.t !== 'del') {
          if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d)) return reply({ t: 'res', id: m.id, ok: false, code: 'invalid_argument' });
          data = m.d;
          if (m.t === 'update') {
            const cur = this.docSnapshot(path);
            if (!cur) return reply({ t: 'res', id: m.id, ok: false, code: 'not_found' });
            data = { ...cur, ...m.d };
          }
          data = this.cleanDoc(path, data);
          const s = enc(data);
          if (s.length > MAX_DOC_BYTES) return reply({ t: 'res', id: m.id, ok: false, code: 'invalid_argument' });
          this.sql.exec('INSERT INTO docs (path, col, data, t) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, t = excluded.t',
            path, path.split('/')[0], s, Date.now());
        } else {
          this.sql.exec('DELETE FROM docs WHERE path = ?', path);
        }
        if (path === 'config/mod') this.mod = null;
        reply({ t: 'res', id: m.id, ok: true });
        this.notify(path, data);
        return;
      }
      case 'lock': {
        const path = String(m.path || ''), now = Date.now(), ttl = Math.max(1000, Math.min(30000, +m.ttl || 8000));
        const cur = this.locks.get(path);
        const ok = !cur || cur.until < now || cur.holder === a.uid;
        if (ok) this.locks.set(path, { holder: a.uid, until: now + ttl });
        reply({ t: 'res', id: m.id, ok: true, acquired: ok });
        return;
      }
      case 'ping': reply({ t: 'pong' }); return;
    }
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const a = ws.deserializeAttachment(); if (!a || !a.peer) return;
    this.pres.delete(a.peer); this.rate.delete(a.peer);
    this.broadcast({ t: 'left', peer: a.peer }, ws);
    try { ws.close(1000, 'bye'); } catch { /* 이미 닫힘 */ }
  }
}
