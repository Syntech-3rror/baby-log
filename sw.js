// 반짝이: 인터넷이 끊겨도 앱 화면이 열리도록 기본 파일을 저장해 둡니다.
const CACHE = 'babylog-v1.8.0';
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

/* ---------- 막수 알림(1.8.0) ---------- */
// 연결 코드가 내용 없는 푸시를 보내면, 여기서 마지막 수유를 짧게 물어 문구를 만들어 띄움
const FEED_TAG = 'babylog-feed';   // 같은 tag라 이전 알림을 덮어씀

function swCfg() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('babylog', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        const g = db.transaction('kv').objectStore('kv').get('cfg');
        g.onsuccess = () => { db.close(); resolve(g.result || null); };
        g.onerror = () => { db.close(); resolve(null); };
      };
    } catch (e) { resolve(null); }
  });
}

const hoursText = (x) => `${Math.floor(x)}시간${x % 1 ? ' 30분' : ''}`;
function ampmText(t) {
  const [hh, mm] = String(t).split(':').map(Number);
  return `${hh < 12 ? '오전' : '오후'} ${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')}`;
}

async function feedMessage() {
  const plain = '마지막 수유 후 정한 시간이 지났어요. 앱에서 확인해 주세요.';
  const c = await swCfg();
  if (!c || !c.apiUrl || !c.code) return plain;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);   // 5초 안에 못 받으면 일반 문구
  try {
    const res = await fetch(c.apiUrl, { method:'POST', body:JSON.stringify({ action:'pushInfo', code:c.code, device:c.device || '' }), signal:ctrl.signal, redirect:'follow' });
    const d = await res.json();
    if (!d || !d.ok) return plain;
    const f = d.feed;
    const when = f ? `${ampmText(f.time)}${f.amount !== '' && f.amount != null ? `, ${f.amount}${f.unit || ''}` : ''}` : '';
    if (d.test) return f ? `시험 알림이에요. 마지막 수유는 ${when}예요.` : '시험 알림이에요. 알림이 잘 와요.';
    if (!f) return plain;
    return `마지막 수유 후 ${hoursText(d.hours)} 지났어요 (${when})`;
  } catch (e) {
    return plain;
  } finally { clearTimeout(timer); }
}

self.addEventListener('push', (event) => {
  event.waitUntil(feedMessage().then((body) => self.registration.showNotification('반짝이', {
    body, tag:FEED_TAG, renotify:true, icon:'icon-192.png', badge:'badge-96.png',   // badge: 안드로이드 상단바 작은 아이콘(투명 배경에 흰 반짝이)
    data:{ url:self.registration.scope },
  })));
});

// 알림을 누르면 앱을 열고, 이미 열려 있으면 그 창으로
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then((list) => {
    const win = list.find((w) => w.url.startsWith(scope));
    if (win) return win.focus();
    return self.clients.openWindow(scope);
  }));
});
