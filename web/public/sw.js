// 카디널 서비스 워커: 설치(PWA) 조건용 + 앱 껍데기(해시 붙은 /assets/*, 아이콘)만 캐시.
// API·웹소켓·스테이지 리소스·페이지(HTML)는 항상 네트워크로 (서버 상태·토큰이 낡은 채로 보이면 안 됨).
const CACHE = 'cardinal-shell-v1';
const SHELL = ['/icon-192.png', '/icon-512.png', '/stage.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // 해시가 파일 이름에 붙는 빌드 결과는 바뀌지 않으니 캐시 우선, 그 외(HTML·API·스테이지 리소스)는 건드리지 않음
  if (!url.pathname.startsWith('/assets/') && !SHELL.includes(url.pathname)) return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
