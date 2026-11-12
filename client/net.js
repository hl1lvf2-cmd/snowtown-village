// 눈사람 마을 · 직접 운영용 연결 모듈
// 게임은 Claude 아티팩트의 claude.use('user'|'db'|'room'|'downloads')를 그대로 부르고,
// 이 파일이 그 자리를 우리 서버(WebSocket /ws)로 대신 채워요. 게임 코드는 손대지 않아요.
(() => {
  const qs = new URLSearchParams(location.search);
  const LS = {
    get(k) { try { return localStorage.getItem('snowtown.net.' + k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem('snowtown.net.' + k); else localStorage.setItem('snowtown.net.' + k, v); } catch { /* 저장 불가 */ } },
  };
  // 이 기기의 열쇠: 처음 들어올 때 만들어 두고, 서버는 여기서 내 아이디를 뽑아요(열쇠를 모르면 남의 눈사람을 못 고쳐요)
  let secret = LS.get('secret');
  if (!secret || secret.length < 32) {
    const b = new Uint8Array(24); crypto.getRandomValues(b);
    secret = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); LS.set('secret', secret);
  }
  // 관리자: 주소 뒤에 ?admin=열쇠 를 한 번 붙여 들어오면 이 기기에 기억. ?admin=off 로 지움
  if (qs.has('admin')) LS.set('admin', qs.get('admin') === 'off' ? null : qs.get('admin'));
  const adminKey = LS.get('admin') || '';
  // 마을 번호: ?v=2 처럼 고르거나, 지난번 마을로 다시 감
  let village = Math.max(1, parseInt(qs.get('v') || LS.get('village') || '1', 10) || 1);

  const enc = o => JSON.stringify(o);
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  let ws = null, hello = null, connected = false, retry = 0, everConnected = false;
  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  setTimeout(() => readyResolve(null), 15000); // 서버에 못 닿으면 게임은 혼자 놀기로
  const pending = new Map(); let rid = 0;
  const connL = new Set();
  const fireConn = () => { for (const f of connL) { try { f(connected); } catch (e) { console.error(e); } } };

  // ---------- 실시간(room) ----------
  const peers = new Map(); // peer -> 보기용 객체
  const peerL = new Set();
  let myPres = {}, sentAt = 0, presTimer = 0, presDirty = false;
  const meObj = () => ({ peer: hello ? hello.peer : 'me', by: hello ? hello.uid : '', isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: myPres, updatedAt: Date.now() });
  const peerList = () => [meObj(), ...peers.values()];
  function firePeers(joined = [], left = [], updated = []) {
    const ch = { peers: peerList(), joined, left, updated };
    for (const f of peerL) { try { f(ch); } catch (e) { console.error(e); } }
  }
  function sendPres(force = false) {
    if (!connected) { presDirty = true; return; }
    const now = Date.now(), gap = 150; // 초당 6~7번이면 충분히 부드럽고, 서버 비용은 절반 가까이 줄어요
    if (!force && now - sentAt < gap) { if (!presTimer) presTimer = setTimeout(() => { presTimer = 0; sendPres(true); }, gap - (now - sentAt)); return; }
    sentAt = now; presDirty = false;
    ws.send(enc({ t: 'pres', p: myPres }));
  }
  const room = {
    presence(patch) {
      const next = { ...myPres };
      for (const k in patch) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
      myPres = clone(next); sendPres();
      return Promise.resolve();
    },
    onPeers(fn) { peerL.add(fn); setTimeout(() => { const p = peerList(); fn({ peers: p, joined: p, left: [], updated: [] }); }, 0); return () => peerL.delete(fn); },
    onConnection(fn) { connL.add(fn); setTimeout(() => fn(connected), 0); return () => connL.delete(fn); },
    peers: () => peerList(), connected: () => connected,
    emit: () => Promise.resolve(), on: () => () => {},
  };

  // ---------- 저장소(db) ----------
  const cols = new Map();   // col -> Map(id -> data)
  const colL = new Map();   // col -> Set(fn)
  const docs = new Map();   // path -> data|null
  const docL = new Map();   // path -> Set(fn)
  const docSnap = (path, d) => ({ id: path.split('/').pop(), exists: d != null, data: () => clone(d), metadata: { fromCache: false, hasPendingWrites: false } });
  function colSnap(col) {
    const m = cols.get(col) || new Map();
    const list = [...m.entries()].map(([id, d]) => docSnap(col + '/' + id, d));
    return { docs: list, size: list.length, empty: !list.length, forEach: f => list.forEach(f), docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  const fireCol = col => { const s = colL.get(col); if (s) { const snap = colSnap(col); for (const f of s) { try { f(snap); } catch (e) { console.error(e); } } } };
  const fireDoc = path => { const s = docL.get(path); if (s) { const snap = docSnap(path, docs.has(path) ? docs.get(path) : null); for (const f of s) { try { f(snap); } catch (e) { console.error(e); } } } };
  function call(msg) {
    return new Promise((res, rej) => {
      const go = () => {
        const id = ++rid; msg.id = id;
        const to = setTimeout(() => { pending.delete(id); rej({ code: 'unavailable', message: '서버가 대답하지 않아요' }); }, 10000);
        pending.set(id, { res: v => { clearTimeout(to); res(v); }, rej: e => { clearTimeout(to); rej(e); } });
        ws.send(enc(msg));
      };
      if (connected) return go();
      const t0 = Date.now(); // 잠깐 끊겼으면 다시 붙을 때까지 조금 기다렸다 보냄
      const wait = () => { if (connected) go(); else if (Date.now() - t0 > 8000) rej({ code: 'unavailable', message: '연결이 끊겼어요' }); else setTimeout(wait, 250); };
      wait();
    });
  }
  const db = {
    collection(col) {
      return {
        onSnapshot(next) {
          if (!colL.has(col)) colL.set(col, new Set());
          colL.get(col).add(next);
          if (connected) ws.send(enc({ t: 'sub', col }));
          if (cols.has(col)) setTimeout(() => next(colSnap(col)), 0);
          return () => colL.get(col).delete(next);
        },
      };
    },
    doc(path) {
      const self = {
        set: data => call({ t: 'set', path, d: clone(data) }).then(() => undefined),
        update: data => call({ t: 'update', path, d: clone(data) }).then(() => undefined),
        delete: () => call({ t: 'del', path }).then(() => undefined),
        get: () => call({ t: 'get', path }).then(r => docSnap(path, r.d)),
        acquire: ({ ttlMs } = {}) => call({ t: 'lock', path, ttl: ttlMs || 8000 }).then(r => ({ acquired: !!r.acquired })),
        onSnapshot(next) {
          if (!docL.has(path)) docL.set(path, new Set());
          docL.get(path).add(next);
          if (connected) ws.send(enc({ t: 'subdoc', path }));
          if (docs.has(path)) setTimeout(() => next(docSnap(path, docs.get(path))), 0);
          return () => docL.get(path).delete(next);
        },
      };
      return self;
    },
  };

  // ---------- 나(user) ----------
  const user = {
    me: async () => ({ id: hello.uid, name: '', isOwner: !!hello.admin, canEdit: !!hello.admin, avatarUrl: '', color: '#888', email: null }),
    id: async () => hello.uid,
    can: async () => !hello.banned,
    isOwner: async () => !!hello.admin,
    canEdit: async () => !!hello.admin,
    profiles: async ids => Object.fromEntries([].concat(ids).map(i => [i, { id: i, name: '', avatarUrl: '', color: '#888', email: null, isMe: hello && i === hello.uid, guest: false }])),
  };
  // ---------- 사진 저장 ----------
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data);
      const a = document.createElement('a'); a.href = url; a.download = filename || 'snowtown.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { status: 'saved' };
    },
  };

  // ---------- 연결 ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const u = `${proto}//${location.host}/ws?v=${village}&k=${encodeURIComponent(secret)}${adminKey ? '&a=' + encodeURIComponent(adminKey) : ''}`;
    try { ws = new WebSocket(u); } catch { return later(); }
    let full = false;
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'hello':
          hello = m; connected = true; retry = 0; everConnected = true; LS.set('village', String(village));
          window.SNOWTOWN_VILLAGE = village;
          for (const col of colL.keys()) ws.send(enc({ t: 'sub', col }));
          for (const path of docL.keys()) ws.send(enc({ t: 'subdoc', path }));
          if (Object.keys(myPres).length) sendPres(true);
          fireConn(); readyResolve(true);
          break;
        case 'full': full = true; village += 1; break; // 꽉 찼으면 다음 마을로
        case 'pres': {
          const had = peers.has(m.peer);
          const v = { peer: m.peer, by: m.by, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: m.p, updatedAt: Date.now() };
          peers.set(m.peer, v); firePeers(had ? [] : [v], [], had ? [v] : []);
          break;
        }
        case 'left': { const v = peers.get(m.peer); if (v) { peers.delete(m.peer); firePeers([], [v], []); } break; }
        case 'need': if (Object.keys(myPres).length) sendPres(true); break;
        case 'col': { const mm = new Map(); for (const d of m.docs) mm.set(d.id, d.d); cols.set(m.col, mm); fireCol(m.col); break; }
        case 'doc': {
          const [col, id] = m.path.split('/');
          if (cols.has(col)) { if (m.d == null) cols.get(col).delete(id); else cols.get(col).set(id, m.d); fireCol(col); }
          docs.set(m.path, m.d); fireDoc(m.path);
          break;
        }
        case 'res': {
          const p = pending.get(m.id); if (!p) break; pending.delete(m.id);
          if (m.ok) p.res(m); else p.rej({ code: m.code || 'unknown' });
          break;
        }
      }
    };
    ws.onclose = () => {
      const was = connected; connected = false; ws = null;
      if (peers.size) { const gone = [...peers.values()]; peers.clear(); firePeers([], gone, []); }
      if (was) fireConn();
      if (full) { connect(); return; }
      later();
    };
    ws.onerror = () => { /* onclose가 뒤따라 옴 */ };
  }
  function later() { retry++; setTimeout(connect, Math.min(10000, 600 * 2 ** Math.min(retry, 4))); }
  // 탭을 다시 열면 바로 다시 붙기
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !ws) connect(); });
  connect();

  // 다른 기기에서 이어하기: 게임 설정의 '열쇠' 메뉴가 씀
  window.SNOWTOWN_NET = {
    key: () => secret,
    setKey(k) {
      k = String(k || '').trim();
      if (!/^[0-9a-f]{32,128}$/i.test(k)) return false;
      LS.set('secret', k.toLowerCase()); return true;
    },
  };
  const NS = { user, db, room, downloads };
  window.claude = { use: async name => { const ok = await ready; if (!ok || !hello) return null; return NS[name] || null; } };
})();
