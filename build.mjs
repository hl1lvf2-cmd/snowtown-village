// game/ (Claude 아티팩트와 같은 게임 파일) → public/ (배포용)
// - 연결 모듈 net.js 를 게임보다 먼저 불러오게 끼워 넣고
// - three.js 를 외부 CDN 대신 우리 사이트에서 받게 바꿔요
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';

const OUT = 'public';
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

let html = readFileSync('game/index.html', 'utf8');
const map = '{ "imports": { "three": "/vendor/three/build/three.module.min.js", "three/addons/": "/vendor/three/examples/jsm/" } }';
const before = html;
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script src="/net.js"></script>\n<script type="importmap">\n${map}\n</script>`);
if (html === before) throw new Error('game/index.html 에서 importmap 을 찾지 못했어요');
html = html.replace('<title>', [
  '<meta name="description" content="친구들과 함께 눈사람을 굴려 세우고 꾸미는 겨울 마을">',
  // 홈 화면에 추가하면 주소창 없이 앱처럼 열리게(아이폰·안드로이드)
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<meta name="theme-color" content="#0f1a33">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="눈사람 마을">',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
  '<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">',
  '<meta property="og:title" content="눈사람 마을">',
  '<meta property="og:description" content="친구들과 함께 눈사람을 굴려 세우고 꾸미는 겨울 마을">',
  '<meta property="og:image" content="/icons/icon-512.png">',
  '<title>',
].join('\n'));
writeFileSync(`${OUT}/index.html`, html);
cpSync('client/net.js', `${OUT}/net.js`);
cpSync('game/assets', `${OUT}/assets`, { recursive: true });
cpSync('vendor', `${OUT}/vendor`, { recursive: true });
cpSync('static', OUT, { recursive: true }); // manifest·아이콘
writeFileSync(`${OUT}/_headers`, [
  '/assets/*', '  Cache-Control: public, max-age=86400',
  '/vendor/*', '  Cache-Control: public, max-age=604800, immutable',
  '/manifest.webmanifest', '  Content-Type: application/manifest+json', '',
].join('\n'));
console.log('public/ 준비 완료');
