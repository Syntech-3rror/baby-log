// 반짝이: 인터넷이 끊겨도 앱 화면이 열리도록 기본 파일을 저장해 둡니다.
const CACHE = 'babylog-v1.11.0';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && !k.startsWith('babylog-photos')).map((k) => caches.delete(k))))   // 사진 보관함은 남김
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 구글 시트 연결, 글꼴은 건드리지 않음

  if (req.mode === 'navigate') {
    // 화면은 새 버전을 먼저 받고, 안 되면 저장해 둔 것을 씀
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});

/* ---------- 막수 알림(1.8.0), 일정 바뀜 알림(1.11.0) ---------- */
// 연결 코드가 내용 없는 푸시를 보내면, 여기서 pushInfo를 짧게 물어 문구를 만들어 띄움.
// 새 연결 코드(1.11.0)는 events(일정 바뀜 항목)와 feedDue(막수 차례인지), quiet(밤 시간인지)를 같이 줌
const FEED_TAG = 'babylog-feed';   // 같은 tag라 이전 알림을 덮어씀
const EVENT_TAG = 'babylog-event';
const WEEK_SW = ['일', '월', '화', '수', '목', '금', '토'];

// 연결 주소와 가족 코드(화면이 IndexedDB 'kv' > 'cfg'에 둠). ev: 이 폰이 일정 바뀜을 켰는지, name: 아기 이름
function swCfg() {
  return upqKv('cfg').then((c) => c || null, () => null);
}

const hoursText = (x) => `${Math.floor(x)}시간${x % 1 ? ' 30분' : ''}`;
function ampmText(t) {
  const [hh, mm] = String(t).split(':').map(Number);
  return `${hh < 12 ? '오전' : '오후'} ${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')}`;
}
const FEED_PLAIN = '마지막 수유 후 정한 시간이 지났어요. 앱에서 확인해 주세요.';
// 막수 문구(시험 알림 포함). d가 없으면 일반 문구
function feedText(d) {
  if (!d) return FEED_PLAIN;
  const f = d.feed;
  const when = f ? `${ampmText(f.time)}${f.amount !== '' && f.amount != null ? `, ${f.amount}${f.unit || ''}` : ''}` : '';
  if (d.test) return f ? `시험 알림이에요. 마지막 수유는 ${when}예요.` : '시험 알림이에요. 알림이 잘 와요.';
  if (!f) return FEED_PLAIN;
  return `마지막 수유 후 ${hoursText(d.hours)} 지났어요 (${when})`;
}
// 일정 한 줄: '11월 20일 (목) 오전 10:00 소아과, 아빠', 하루 종일, 여러 날('11월 20일 (목) ~ 22일 (토)'), 매년이면 끝에 ' (매년)'
function evDay(s, withMonth) {
  const [y, m, d] = String(s).split('-').map(Number);
  const w = WEEK_SW[new Date(y, m - 1, d).getDay()];
  return `${withMonth ? `${m}월 ` : ''}${d}일 (${w})`;
}
function evLine(e, babyName) {
  let when = evDay(e.date, true);
  if (e.end) when += ` ~ ${evDay(e.end, String(e.end).slice(0, 7) !== String(e.date).slice(0, 7))}`;
  when += e.time ? ` ${ampmText(e.time)}` : e.end ? '' : ' 하루 종일';
  const who = e.who === '아기' ? (babyName || '아기') : (e.who || '');
  return `${when} ${e.title}${who ? `, ${who}` : ''}${e.repeat === '매년' ? ' (매년)' : ''}`;
}
function eventText(list, babyName) {
  const last = list[list.length - 1];
  if (list.length > 1) return `일정 ${list.length}개가 바뀌었어요. 마지막은 ${evLine(last, babyName)}`;
  const head = last.kind === 'add' ? '새 일정이에요' : last.kind === 'del' ? '일정을 지웠어요' : '일정이 바뀌었어요';
  return `${head}: ${evLine(last, babyName)}`;
}

// pushInfo를 5초 안에 물음. 못 받으면 null
async function askInfo(c) {
  if (!c || !c.apiUrl || !c.code) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);   // 5초 안에 못 받으면 일반 문구
  try {
    const res = await fetch(c.apiUrl, { method:'POST', body:JSON.stringify({ action:'pushInfo', code:c.code, device:c.device || '' }), signal:ctrl.signal, redirect:'follow' });
    const d = await res.json();
    return d && d.ok ? d : null;
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

const show = (body, opt) => self.registration.showNotification('반짝이', Object.assign({
  body, tag:FEED_TAG, renotify:true, icon:'icon-192.png', badge:'badge-96.png',   // badge: 안드로이드 상단바 작은 아이콘(투명 배경에 흰 반짝이)
  data:{ url:self.registration.scope },
}, opt || {}));

async function onPush() {
  const c = await swCfg();
  const d = await askInfo(c);
  if (!d) {   // 못 받음: 이 폰이 일정 알림을 켰으면 어느 알림인지 모르니 두루 쓰는 문구
    return show(c && c.ev ? '반짝이에 새 소식이 있어요. 앱에서 확인해 주세요.' : FEED_PLAIN);
  }
  if (d.feedDue === undefined) return show(feedText(d));   // 예전 연결 코드: 지금처럼 막수 문구
  const jobs = [];
  const events = Array.isArray(d.events) ? d.events.filter((e) => e && e.date) : [];
  if (events.length) {
    const last = events[events.length - 1];
    jobs.push(show(eventText(events, c && c.name), { tag:EVENT_TAG, silent:!!d.quiet, data:{ url:self.registration.scope, events:true, date:last.date } }));
  }
  if (d.test || d.feedDue) jobs.push(show(feedText(d)));
  if (jobs.length) return Promise.all(jobs);
  // 보여 줄 게 없음(앞 푸시에서 같이 보여 줌): 떠 있는 반짝이 알림 중 가장 최근 것을 같은 tag로 조용히 다시
  let open = [];
  try { open = await self.registration.getNotifications(); } catch (e) { open = []; }
  const latest = open.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
  if (latest) return show(latest.body, { tag:latest.tag || FEED_TAG, data:latest.data || { url:self.registration.scope }, silent:true, renotify:false });
  return show('앱에서 확인해 주세요', { silent:true, renotify:false });
}

self.addEventListener('push', (event) => {
  event.waitUntil(onPush());
});

// 알림을 누르면 앱을 열고, 이미 열려 있으면 그 창으로. 사진 다 올림은 앨범, 일정 바뀜은 일정 화면(그 날짜)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  const data = event.notification.data || {};
  const album = !!data.album;
  const evDate = data.events && /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : '';
  event.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then((list) => {
    const win = list.find((w) => w.url.startsWith(scope));
    if (win) {
      if (album) win.postMessage({ type:'open-album' });
      else if (evDate) win.postMessage({ type:'open-events', date:evDate });
      return win.focus();
    }
    return self.clients.openWindow(album ? `${scope}#album` : evDate ? `${scope}#events=${evDate}` : scope);
  }));
});

/* ---------- 사진 올리기 큐 공통(1.9.0) ----------
   index.html과 sw.js에 똑같이 들어 있음(화면과 서비스워커가 같은 큐를 나눠 올림). 고치면 둘 다 고침. test/upq_same.js가 같은지 봄.
   큐: IndexedDB 'babylog' > 'upq'(사진 한 장에 한 줄, 원본 Blob 포함). 연결 정보: 'kv' > 'cfg'(1.8.0). 진행 수: 'kv' > 'upqStats'.
   한 장씩 맡아 감(claimedAt). 맡은 쪽은 20초마다 시각을 새로 적고, 60초 넘게 안 적으면 멈춘 것으로 보고 다른 쪽이 다시 맡음.
   화면과 서비스워커를 합쳐 한 번에 3장까지. */
const UPQ_DB = 'babylog', UPQ_VER = 2, UPQ_PAR = 3, UPQ_STALE = 60000, UPQ_BEAT = 20000, UPQ_TRIES = 5;
const UPQ_HARD = ['decode', 'too_big', 'bad_photo', 'bad_id', 'bad_date', 'bad_time', 'bad_code', 'unknown_action'];   // 다시 해도 안 되는 것
function upqOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(UPQ_DB, UPQ_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('upq')) db.createObjectStore('upq', { keyPath:'id' });
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); resolve(db); };
    r.onerror = () => reject(r.error || new Error('idb'));
    r.onblocked = () => reject(new Error('idb_blocked'));
  });
}
// 한 트랜잭션 안에서 fn(tx, set). fn 안에서는 요청 콜백으로만 이어 감(await 하면 트랜잭션이 끝남)
function upqTx(stores, mode, fn) {
  return upqOpen().then((db) => new Promise((resolve, reject) => {
    let out;
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('idb_tx')); };
    fn(tx, (v) => { out = v; });
  }));
}
const upqList = () => upqTx('upq', 'readonly', (tx, set) => { const r = tx.objectStore('upq').getAll(); r.onsuccess = () => set(r.result || []); });
const upqKv = (k) => upqTx('kv', 'readonly', (tx, set) => { const r = tx.objectStore('kv').get(k); r.onsuccess = () => set(r.result); });
const upqDel = (id) => upqTx('upq', 'readwrite', (tx) => { tx.objectStore('upq').delete(id); });
// 있는 줄만 고침(그사이 '빼기'로 지웠으면 되살리지 않음)
function upqPatch(id, patch, onlyOwner) {
  return upqTx('upq', 'readwrite', (tx, set) => {
    const st = tx.objectStore('upq');
    const r = st.get(id);
    r.onsuccess = () => {
      const it = r.result;
      if (!it || (onlyOwner && it.claimedBy !== onlyOwner)) { set(false); return; }
      st.put(Object.assign(it, typeof patch === 'function' ? patch(it) : patch));
      set(true);
    };
  });
}
// 진행 수 더하기(done, fail). 큐가 비었다가 새로 들어오면 upqCommit(화면)이 새로 셈
function upqCount(field, n) {
  return upqTx('kv', 'readwrite', (tx) => {
    const st = tx.objectStore('kv');
    const r = st.get('upqStats');
    r.onsuccess = () => { const s = r.result || { total:0, done:0, fail:0, notified:true }; s[field] = (s[field] || 0) + (n || 1); st.put(s, 'upqStats'); };
  });
}
// 하나 맡기: 살아 있는 맡음이 3개 미만일 때 기다리는 것 중 먼저 넣은 것. canSmall이 아니면 보기용이 이미 있는 것만
function upqClaim(owner, canSmall) {
  const now = Date.now();
  return upqTx('upq', 'readwrite', (tx, set) => {
    const st = tx.objectStore('upq');
    const r = st.getAll();
    r.onsuccess = () => {
      const all = r.result || [];
      const held = (x) => x.claimedAt && now - x.claimedAt < UPQ_STALE;
      const wait = all.filter((x) => x.state === 'wait');
      if (wait.filter(held).length >= UPQ_PAR) { set(null); return; }
      const it = wait.filter((x) => !held(x) && (canSmall || (x.view && x.thumb)) && !(x.nextAt > now))
        .sort((a, b) => (a.addedAt - b.addedAt) || (a.seq - b.seq))[0];
      if (!it) { set(null); return; }
      it.claimedAt = now; it.claimedBy = owner;
      st.put(it);
      set(it);
    };
  });
}
function upqB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error || new Error('read'));
    r.readAsDataURL(blob);
  });
}
const upqErr = (code) => Object.assign(new Error(code), { code });
// 한 장 보내기. 보기용과 썸네일이 없으면 만들어 큐에 적어 둠(다시 할 때 또 안 만들게)
async function upqSend(it, cfg, env) {
  if (!it.view || !it.thumb) {
    const s = await env.small(it.file);
    if (!s || !s.view || !s.thumb) throw upqErr('decode');
    Object.assign(it, s);
    await upqPatch(it.id, { view:s.view, thumb:s.thumb, w:s.w, h:s.h });
  }
  const photo = {
    id:it.id, date:it.date, time:it.time, memo:it.memo || '', name:it.name, mime:it.mime, w:it.w, h:it.h, size:it.size, createdAt:it.createdAt,
    original:await upqB64(it.file), view:await upqB64(it.view), thumb:await upqB64(it.thumb),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  let res;
  try {
    res = await fetch(cfg.apiUrl, { method:'POST', body:JSON.stringify({ action:'photoAdd', code:cfg.code, v:env.v, photo }), signal:ctrl.signal, redirect:'follow' });
  } catch (e) { throw upqErr('network'); } finally { clearTimeout(timer); }
  let data;
  try { data = await res.json(); } catch (e) { throw upqErr('network'); }
  if (!data || !data.ok) throw upqErr((data && data.error) || 'error');
  if (!data.photo) throw upqErr('error');
  return data;
}
const upqSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 큐 올리기. env: { owner, v, small(blob)→{view, thumb, w, h}|null 또는 없음, deadline(그 뒤로는 새로 안 맡음, 0이면 없음),
   keepGoing()→false면 새로 안 맡음, onDone(data, it), onChange(), visible()→Promise<bool>, notify(title, body), finishedHere(stats, failed) }
   돌려줌: { left(아직 기다리는 장수), offline } */
async function upqRun(env) {
  const cfg = await upqKv('cfg');
  if (!cfg || !cfg.apiUrl || !cfg.code) return { left:(await upqList()).filter((x) => x.state === 'wait').length, offline:false };
  const canSmall = !!env.small;
  let offline = false;
  const worker = async () => {
    for (;;) {
      if (offline || (env.deadline && Date.now() > env.deadline) || (env.keepGoing && !env.keepGoing())) return;
      const it = await upqClaim(env.owner, canSmall);
      if (!it) {
        const now = Date.now();
        const mine = (await upqList()).filter((x) => x.state === 'wait' && (canSmall || (x.view && x.thumb)));
        if (!mine.length) return;
        await upqSleep(mine.every((x) => x.nextAt > now) ? Math.min(5000, Math.max(500, Math.min(...mine.map((x) => x.nextAt)) - now)) : 1500);   // 남이 맡고 있거나 3장이 찼으면 기다림
        continue;
      }
      if (env.onChange) env.onChange();
      const beat = setInterval(() => { upqPatch(it.id, { claimedAt:Date.now() }, env.owner).catch(() => {}); }, UPQ_BEAT);
      try {
        const data = await upqSend(it, cfg, env);
        await upqDel(it.id);
        await upqCount('done');
        if (env.onDone) await env.onDone(data, it);
      } catch (e) {
        const code = e.code || 'error';
        const net = code === 'network';
        if (net && typeof navigator !== 'undefined' && navigator.onLine === false) offline = true;   // 끊김: 횟수에 안 셈, 이번엔 그만
        const tries = (it.tries || 0) + (offline ? 0 : 1);
        const hard = UPQ_HARD.includes(code) || tries >= (net ? UPQ_TRIES * 2 : UPQ_TRIES);   // 연결 문제는 조금 더 기다려 봄
        await upqPatch(it.id, { state:hard ? 'fail' : 'wait', err:code, tries, claimedAt:0, claimedBy:'', nextAt:hard || offline ? 0 : Date.now() + Math.min(60000, 3000 * tries) });
        if (hard) await upqCount('fail');
      } finally {
        clearInterval(beat);
        if (env.onChange) env.onChange();
      }
    }
  };
  await Promise.all(Array.from({ length:UPQ_PAR }, worker));
  const all = await upqList();
  const left = all.filter((x) => x.state === 'wait').length;
  if (!left) await upqFinish(env, all.filter((x) => x.state === 'fail').length);
  return { left, offline };
}
// 다 끝났을 때 한 번(어느 쪽이 끝내든 한 번만): 앱이 화면에 없고 알림 권한이 있으면 알림(권한은 묻지 않음). 화면에 있으면 finishedHere
async function upqFinish(env, failed) {
  const s = await upqTx('kv', 'readwrite', (tx, set) => {
    const st = tx.objectStore('kv');
    const r = st.get('upqStats');
    r.onsuccess = () => { const o = r.result; if (!o || o.notified) { set(null); return; } o.notified = true; st.put(o, 'upqStats'); set(o); };
  });
  if (!s || (!s.done && !failed)) return;
  try {
    if (await env.visible()) { if (env.finishedHere) env.finishedHere(s, failed); return; }
    await env.notify('반짝이', failed ? `사진 ${s.done}장 올렸어요. ${failed}장은 못 올렸어요.` : `사진 ${s.done}장 다 올렸어요`);
  } catch (e) { /* 알림을 못 띄워도 그만 */ }
}
/* ---------- 사진 올리기 큐 공통 끝 ---------- */

/* ---------- 사진 올리기(서비스워커 쪽, 1.9.0) ----------
   Background Sync('photo-upload')로 앱을 나가거나 화면이 꺼져도 큐를 올림. 크롬은 sync 한 번을 3분에서 끊어서
   (content/public/browser/background_sync_parameters.cc: kMaxSyncEventDuration 3분, 실패하면 5분, 15분 뒤 다시, 3번까지)
   2분이 지나면 새 사진은 안 맡고, 남은 게 있으면 실패로 끝내 다시 시도하게 함. 앱을 다시 열면 화면이 바로 이어서 올림 */
const PHOTO_CACHE = 'babylog-photos-v1';
const SW_UPQ_BUDGET = 120000;
const swCanSmall = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
// 보기용(긴 쪽 1600px)과 썸네일(480px). 안 되면 null(화면이 만듦)
async function swSmall(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation:'from-image' }); } catch (e) { return null; }
  try {
    const one = async (max, q) => {
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, w, h);
      return c.convertToBlob({ type:'image/jpeg', quality:q });
    };
    return { view:await one(1600, 0.82), thumb:await one(480, 0.74), w:bmp.width, h:bmp.height };
  } catch (e) { return null; } finally { if (bmp.close) bmp.close(); }
}
const swWindows = () => self.clients.matchAll({ type:'window', includeUncontrolled:true });
async function swPhotoDone(data, it) {
  try {   // 화면이 다시 받지 않게 썸네일과 보기용을 사진 보관함에
    const c = await caches.open(PHOTO_CACHE), base = `${self.registration.scope}__photo/`;
    if (it.thumb) await c.put(`${base}t/${data.photo.id}`, new Response(it.thumb, { headers:{ 'Content-Type':'image/jpeg' } }));
    if (it.view) await c.put(`${base}v/${data.photo.id}`, new Response(it.view, { headers:{ 'Content-Type':'image/jpeg' } }));
  } catch (e) { /* 그만 */ }
  (await swWindows()).forEach((w) => w.postMessage({ type:'upq-done', photo:data.photo }));
}
async function swPhotos() {
  const budget = Number(await upqKv('upqBudget').catch(() => 0)) || SW_UPQ_BUDGET;   // 시험에서만 kv로 줄임
  const r = await upqRun({
    owner:`sw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, v:CACHE.replace('babylog-v', ''),
    small:swCanSmall ? swSmall : null, deadline:Date.now() + budget, onDone:swPhotoDone,
    visible:async () => (await swWindows()).some((w) => w.visibilityState === 'visible'),
    notify:(title, body) => (self.Notification && Notification.permission === 'granted'
      ? self.registration.showNotification(title, { body, tag:'babylog-photos', icon:'icon-192.png', badge:'badge-96.png', data:{ url:self.registration.scope, album:true } }) : null),
    finishedHere:async (st, failed) => (await swWindows()).forEach((w) => w.postMessage({ type:'upq-finish', done:st.done, failed })),
  });
  if (r.left) throw new Error('photos_left');   // 남은 게 있으면 실패로 끝내 다시 시도하게
}
self.addEventListener('sync', (event) => {
  if (event.tag === 'photo-upload') event.waitUntil(swPhotos());
});
