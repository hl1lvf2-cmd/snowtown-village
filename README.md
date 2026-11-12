# 눈사람 마을 · 직접 운영용

Claude 아티팩트와 똑같은 게임을 내 사이트에서 누구나(로그인 없이) 즐길 수 있게 만든 꾸러미예요.
Cloudflare 무료 플랜으로 돌아가요.

## 들어 있는 것

| 폴더·파일 | 하는 일 |
|---|---|
| `game/` | 게임 원본(Claude 아티팩트와 같은 `index.html`, 모델, 텍스처) |
| `client/net.js` | 게임이 쓰던 Claude 기능(저장소·실시간 접속)을 우리 서버로 바꿔 주는 연결 모듈 |
| `src/worker.js` | 서버. 마을마다 Durable Object 하나가 접속·저장·권한을 맡아요 |
| `vendor/three/` | three.js 0.170 (MIT 라이선스, 외부 CDN 없이 직접 제공) |
| `build.mjs` | `game/` + `net.js` + `vendor/` → `public/` (배포용) |
| `wrangler.jsonc` | Cloudflare 배포 설정 |

## 올리는 방법 A: GitHub로 자동 배포 (추천, 터미널 필요 없음)

1. 이 폴더를 GitHub 저장소에 올려요(비공개여도 괜찮아요).
2. https://dash.cloudflare.com 에 가입·로그인 → **Workers & Pages** → **Create application** → **Import a repository** 옆 **Get started**.
3. GitHub 계정을 연결하고 이 저장소를 고른 뒤 설정에서
   - 프로젝트 이름: `snowtown` (그대로)
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy` (기본값 그대로)
4. **Save and Deploy**(또는 **Deploy**). 1~2분 뒤 `https://snowtown.<내계정>.workers.dev` 주소가 생겨요.
5. 만들어진 Worker → **Settings** → **Variables and Secrets** → **Add** → 종류 **Secret**, 이름 `ADMIN_KEY`, 값은 나만 아는 긴 문장.
6. 이제부터 저장소에 새 버전을 올리면(push) Cloudflare가 알아서 다시 배포해요.

## 올리는 방법 B: 내 컴퓨터 터미널에서

1. Cloudflare 계정 만들기: https://dash.cloudflare.com/sign-up (무료, 카드 등록 없음)
2. Node.js 22 이상 설치: https://nodejs.org (LTS)
3. 이 폴더에서 터미널을 열고:

```bash
npm install
npx wrangler login              # 브라우저가 열리면 Cloudflare로 허용
npx wrangler secret put ADMIN_KEY   # 관리자 열쇠(아무도 모를 긴 문장)를 입력
npm run deploy
```

끝나면 `https://snowtown.<내계정>.workers.dev` 주소가 나와요. 이 주소를 공유하면 돼요.

## 관리자로 들어가기

주소 뒤에 `?admin=관리자열쇠` 를 붙여서 한 번 들어오면 그 기기가 관리자로 기억돼요.
설정 메뉴에 "마을 관리"가 생기고, 금칙어·참여 제한·이번 주 주제를 바꿀 수 있어요.
다른 사람 눈사람과 방명록도 지울 수 있어요. 지우려면 `?admin=off`.

## 운영 도구

- **욕설 가리기:** 기본 금칙어와 관리자가 넣은 금칙어를 서버에서 한 번 더 가려요. 화면 필터를 우회해도 다른 사람에겐 가려진 채로 가요.
- **신고:** 눈사람 카드의 '신고', 채팅 줄을 눌러 '신고'. 관리자 화면의 신고함에서 보러 가기·참여 제한·처리 완료를 할 수 있어요. 신고 내용은 관리자와 신고한 사람만 볼 수 있어요.
- **참여 제한:** 제한된 사람은 눈사람·방명록·좋아요를 쓸 수 없고, 채팅도 서버에서 걸러져요.
- **채팅 숨기기·끄기:** 각자 설정에서 채팅을 끄거나, 특정 사람의 채팅만 숨길 수 있어요.

## 다른 기기에서 이어하기

로그인 대신 기기마다 '열쇠'로 사람을 알아봐요. 설정 → '다른 기기에서 이어하기'에서 열쇠를 복사해 다른 기기에 붙여 넣으면, 같은 사람으로 이어서 놀 수 있어요.

## 휴대폰에서 전체화면

- 안드로이드·아이패드·PC: 위쪽의 '전체화면' 버튼(처음 들어올 때 한 번 권해요).
- 아이폰: 사파리가 웹페이지 전체화면을 지원하지 않아서, 공유 → '홈 화면에 추가'로 아이콘을 만들어 열면 주소창 없이 꽉 찬 화면으로 열려요.
  이를 위해 `static/manifest.webmanifest`와 `static/icons/`(아이콘)가 들어 있어요. 아이콘을 바꾸려면 같은 이름으로 덮어쓰면 돼요.

## 친구 초대

위쪽 **초대** 버튼을 누르면 '지금 내 마을 + 나' 링크가 만들어져요(휴대폰은 공유 창, 컴퓨터는 복사).
친구가 그 링크로 들어오면 같은 마을의 **내 바로 옆**에서 시작해요.

## 마을(채널)

- 한 마을에 동시에 40명까지 들어와요(`wrangler.jsonc`의 `VILLAGE_CAP`). 넘치면 2번, 3번 마을로 자동 안내해요.
- 마을마다 눈사람·랭킹이 따로 저장돼요. `주소/?v=2` 처럼 마을을 골라 들어갈 수도 있어요.

## 고쳐서 다시 올리기

Claude 아티팩트에서 게임을 고친 뒤 새 `index.html`(과 바뀐 `assets/`)을 `game/`에 덮어쓰고 `npm run deploy` 하면 돼요.
게임 코드는 손대지 않아도 `net.js`가 알아서 연결해요.

## 내 컴퓨터에서 미리 보기

```bash
echo "ADMIN_KEY=test-admin" > .dev.vars
npm run dev        # http://localhost:8787
```

## 비용 감각 (2026년 11월 기준, Cloudflare 공식 요금표)

- 게임 파일 내려받기: 무료·무제한
- 실시간 접속: 무료 플랜 하루 Durable Objects 요청 10만 건. 받은 WebSocket 메시지는 20개가 1건으로 계산돼요.
  이 게임은 친구와 함께 움직이는 동안 한 사람이 초당 약 6~7번 위치를 보내고, 가만히 있을 땐 거의 안 보내요. 마을에 혼자일 땐 1초에 한 번만 보내요. 그래서 하루 80~140 플레이어·시간(예: 200명이 30분씩) 정도가 무료 범위예요.
  넘으면 그날(한국 시간 오전 9시 초기화까지) 접속이 막혀요.
- 유료(Workers Paid) 월 5달러: 한도 걱정 없이 쓰고, 초과분은 100만 요청당 0.15달러.
- 대역폭(트래픽) 요금 없음.
