# Paperclip Telegram Bridge

텔레그램 ↔ Paperclip 양방향 브릿지 서비스.  
텔레그램 채팅에서 이슈를 생성/코멘트하고, Paperclip 활동 알림을 텔레그램으로 실시간 수신합니다.

## 주요 기능

### 텔레그램 → Paperclip (수신 명령어)

| 명령어 | 설명 | 예시 |
|--------|------|------|
| `/create [제목]` | 새 이슈 생성 | `/create 로그인 버그 수정` |
| `/create [제목]\n[설명]` | 제목+설명으로 이슈 생성 | `/create 새 기능\n상세 설명` |
| `JUS-XX [내용]` | 특정 이슈에 코멘트 추가 | `JUS-35 서버 동기화 완료` |
| `/comment JUS-XX [내용]` | 특정 이슈에 코멘트 추가 | `/comment JUS-36 검토 완료` |
| `/status` | 진행 중인 이슈 목록 조회 | `/status` |
| `/help` | 사용 가능한 명령어 안내 | `/help` |
| 일반 텍스트 | 자동으로 이슈 생성 | `텔레그램 알림 오류 확인` |

### Paperclip → 텔레그램 (활동 알림)

- **이슈 완료 (done)**: 에이전트 이름, 이슈 식별자, 제목, 최신 코멘트 포함
- **이슈 블로킹 (blocked)**: 블로킹 사유 및 에이전트 정보 포함
- **이슈 생성**: 새로 생성된 이슈 알림
- 일상적 상태 전환(todo → in_progress 등)은 노이즈 방지를 위해 필터링

## 아키텍처

```
┌─────────────────┐     Long-Polling     ┌──────────────────┐
│   Telegram Bot  │ ◄──────────────────► │  telegram.ts     │
│   (Bot API)     │     sendMessage      │  Telegram Client │
└─────────────────┘                      └────────┬─────────┘
                                                  │
                                         ┌────────┴─────────┐
                                         │   index.ts        │
                                         │   메인 오케스트라 │
                                         │   - 폴링 루프     │
                                         │   - 활동 보고     │
                                         │   - PID 락        │
                                         └────────┬─────────┘
                                                  │
┌─────────────────┐     HTTP REST        ┌────────┴─────────┐
│  Paperclip API  │ ◄──────────────────► │  paperclip.ts    │
│  (127.0.0.1)    │                      │  API Client      │
└─────────────────┘                      └──────────────────┘
                                                  ▲
                                         ┌────────┴─────────┐
                                         │   bot.ts          │
                                         │   명령어 파싱     │
                                         │   응답 포맷팅     │
                                         └──────────────────┘
```

### 소스 파일 구조

```
src/
├── index.ts          # 메인 엔트리포인트 (폴링 루프, 활동 보고, PID 락)
├── telegram.ts       # Telegram Bot API 클라이언트 (long-polling, 메시지 전송)
├── bot.ts            # 명령어 파싱 (parseCommand) 및 실행 (handleCommand)
├── paperclip.ts      # Paperclip REST API 클라이언트
└── __tests__/
    └── bot.test.ts   # parseCommand, formatActivity, formatRunReport 단위 테스트
```

## 설치 및 실행

### 요구사항

- Node.js >= 18
- Telegram Bot Token ([BotFather](https://t.me/botfather)에서 생성)
- Paperclip API 접속 정보

### 설치

```bash
git clone https://github.com/dwkho1708/paperclip_telegram.git
cd paperclip_telegram
npm install
```

### 환경변수 설정

`.env.example`을 복사하여 `.env`를 생성하고 실제 값을 입력합니다.

```bash
cp .env.example .env
```

| 환경변수 | 필수 | 설명 |
|----------|------|------|
| `TELEGRAM_BOT_TOKEN` | O | Telegram Bot API 토큰 |
| `TELEGRAM_CHAT_ID` | - | 보드 채팅 ID (미설정 시 첫 메시지에서 자동 감지) |
| `PAPERCLIP_API_URL` | - | Paperclip API URL (기본: `http://127.0.0.1:3100`) |
| `PAPERCLIP_API_KEY` | O | Paperclip API 인증 키 |
| `PAPERCLIP_COMPANY_ID` | O | Paperclip 회사 ID |
| `CEO_AGENT_ID` | - | CEO 에이전트 ID (이슈 생성 시 자동 할당용) |
| `PAPERCLIP_PROJECT_ID` | - | 이슈 생성 시 사용할 프로젝트 ID |
| `HEARTBEAT_WEBHOOK_PUBLIC_ID` | - | CEO 하트비트 트리거용 webhook public ID |
| `HEARTBEAT_WEBHOOK_SECRET` | - | CEO 하트비트 트리거용 webhook secret |

### 빌드 및 실행

```bash
# TypeScript 빌드
npm run build

# 프로덕션 실행
npm start

# 개발 모드 (tsx, 빌드 없이 직접 실행)
npm run dev
```

### 테스트

```bash
# 단위 테스트 실행
npm test

# watch 모드
npm run test:watch
```

## systemd 서비스 등록

장기 실행을 위해 systemd 서비스로 등록할 수 있습니다.

```bash
# 서비스 파일 복사 (사용자 서비스)
cp telegram-bridge.service ~/.config/systemd/user/telegram-bridge.service

# 서비스 파일 내 WorkingDirectory, 환경변수, ExecStart 경로를 실제 환경에 맞게 수정
vi ~/.config/systemd/user/telegram-bridge.service

# 서비스 등록 및 시작
systemctl --user daemon-reload
systemctl --user enable telegram-bridge
systemctl --user start telegram-bridge

# 상태 확인
systemctl --user status telegram-bridge

# 로그 확인
journalctl --user -u telegram-bridge -f
```

## 동작 상세

### 메시지 수신 (Long-Polling)

- Telegram `getUpdates` API를 25초 timeout으로 long-polling
- 409 (Conflict) 발생 시 자동으로 webhook 상태 초기화 후 5초 대기
- 첫 메시지 수신 시 `TELEGRAM_CHAT_ID` 미설정이면 자동 감지 (콘솔 경고 출력)

### 메시지 전송

- Telegram 메시지 길이 제한(4096자) 초과 시 줄바꿈 기준으로 자동 분할
- HTML 파싱 모드 사용 (`parse_mode: HTML`)
- 429 (Rate Limit) 발생 시 `retry_after` 만큼 대기 후 1회 재시도

### 활동 보고

- 15초 간격으로 Paperclip 활동 API 폴링
- 한 번에 최대 3건 전송 (메시지 간 1.5초 간격으로 rate limit 방지)
- done/blocked 이벤트는 이슈 제목 + 최신 코멘트 포함 상세 보고서 생성
- 일상적 상태 전환(todo → in_progress 등)은 필터링

### 단일 인스턴스 보장

- `/tmp/telegram-bridge.pid` 파일로 PID 락 관리
- 기존 프로세스가 있으면 `/proc/{pid}/cmdline` 검증 후 SIGTERM 전송
- 프로세스 종료 시 PID 파일 자동 정리 (exit, SIGTERM, SIGINT 처리)

### 에이전트 이름 캐싱

- 서비스 시작 시 모든 에이전트 이름을 로드하여 메모리 캐시
- 활동 보고 시 에이전트 ID 대신 이름으로 표시

## 보안 참고사항

- `.env` 파일은 `.gitignore`에 포함되어 있으며, 절대로 커밋하지 않습니다.
- `TELEGRAM_CHAT_ID` 미설정 시 첫 메시지 발신자가 자동 허용됩니다. 보안을 위해 반드시 환경변수에 명시적으로 설정하세요.
- 내부 오류 상세 정보는 콘솔 로그에만 기록되며, 텔레그램에는 일반 오류 메시지만 노출됩니다.

## 라이선스

Private — 내부 사용 전용
