/**
 * 텔레그램 ↔ Paperclip 브릿지 서비스 (JUS-34)
 *
 * 환경변수:
 *   TELEGRAM_BOT_TOKEN   — 텔레그램 Bot Token (필수)
 *   TELEGRAM_CHAT_ID     — 보드 채팅 ID (첫 메시지 수신 후 자동 감지)
 *   PAPERCLIP_API_URL    — Paperclip API URL (기본: http://127.0.0.1:3100)
 *   PAPERCLIP_API_KEY    — Paperclip API Key (필수)
 *   PAPERCLIP_COMPANY_ID — Paperclip 회사 ID (필수)
 *   PAPERCLIP_PROJECT_ID — 이슈 생성 시 사용할 프로젝트 ID (선택)
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, readlinkSync } from 'node:fs';
import { TelegramClient } from './telegram.js';
import { PaperclipClient } from './paperclip.js';
import { parseCommand, handleCommand, formatActivity, formatRunReport } from './bot.js';

// ─── 단일 인스턴스 보장 (PID 락 파일) ──────────────────────────────────────
const PID_FILE = '/tmp/telegram-bridge.pid';

function acquireLock(): void {
  // 기존 프로세스가 있으면 종료
  if (existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        // 프로세스 정체성 검증: /proc/{pid}/cmdline이 telegram-bridge인지 확인
        let isOurProcess = false;
        try {
          const cmdline = readFileSync(`/proc/${oldPid}/cmdline`, 'utf-8');
          isOurProcess = cmdline.includes('telegram-bridge') || cmdline.includes('telegram');
        } catch { /* /proc 접근 불가 (비Linux) — 보수적으로 kill하지 않음 */ }
        if (isOurProcess) {
          try { process.kill(oldPid, 'SIGTERM'); } catch { /* 이미 종료됨 */ }
          console.log(`[telegram-bridge] 기존 프로세스 ${oldPid} 종료`);
        } else {
          console.warn(`[telegram-bridge] PID ${oldPid}는 telegram-bridge가 아님 — kill 스킵`);
        }
      }
    } catch { /* PID 파일 읽기 실패 무시 */ }
  }
  writeFileSync(PID_FILE, String(process.pid));
  // 프로세스 종료 시 PID 파일 정리
  const cleanup = () => { try { unlinkSync(PID_FILE); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
}

// ─── 환경변수 검증 ───────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL ?? 'http://127.0.0.1:3100';
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN 환경변수 필요');
if (!PAPERCLIP_API_KEY) throw new Error('PAPERCLIP_API_KEY 환경변수 필요');
if (!PAPERCLIP_COMPANY_ID) throw new Error('PAPERCLIP_COMPANY_ID 환경변수 필요');

// ─── 클라이언트 초기화 ───────────────────────────────────────────────────────

const telegram = new TelegramClient(BOT_TOKEN);
const paperclip = new PaperclipClient(PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID);

// ─── 에이전트 이름 캐시 (활동 보고 시 사용) ──────────────────────────────────
const agentNameMap = new Map<string, string>();
const CEO_AGENT_ID = process.env.CEO_AGENT_ID;

async function loadAgentNames(): Promise<void> {
  try {
    const agents = await paperclip.listAgents();
    for (const agent of agents) {
      agentNameMap.set(agent.id, agent.name);
    }
    console.log(`[telegram-bridge] 에이전트 ${agentNameMap.size}명 로드 완료`);
  } catch (err) {
    console.warn('[telegram-bridge] 에이전트 목록 로드 실패:', err instanceof Error ? err.message : err);
  }
}

// 허용된 보드 채팅 ID — 환경변수로 고정 (보안 필수: 검증 없이 첫 메시지 발신자를 허용하면 공격 가능)
// TELEGRAM_CHAT_ID 미설정 시 첫 메시지 발신자를 임시 허용하되 콘솔 경고 출력
let chatId: number | null = process.env.TELEGRAM_CHAT_ID
  ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
  : null;

if (!chatId) {
  console.warn('[telegram-bridge] 경고: TELEGRAM_CHAT_ID 미설정. 첫 수신 메시지의 chat_id를 허용합니다.');
  console.warn('  보안을 위해 첫 실행 후 콘솔 출력된 chat_id를 TELEGRAM_CHAT_ID 환경변수에 설정하세요.');
}

// ─── Telegram → Paperclip 폴링 루프 ─────────────────────────────────────────

let nextOffset: number | undefined;

async function pollTelegram(): Promise<void> {
  try {
    const updates = await telegram.getUpdates(nextOffset);

    for (const update of updates) {
      nextOffset = update.update_id + 1;

      const msg = update.message;
      if (!msg?.text) continue;

      // 채팅 ID 자동 감지 (첫 메시지에서)
      if (!chatId) {
        chatId = msg.chat.id;
        console.log(`[telegram-bridge] 채팅 ID 감지: ${chatId}`);
      }

      const sender = msg.from?.username ?? msg.from?.first_name ?? 'unknown';
      console.log(`[telegram-bridge] 수신: @${sender}: ${msg.text}`);

      // 명령어 파싱 + 실행
      const parsed = parseCommand(msg.text);
      try {
        const reply = await handleCommand(parsed, paperclip);
        await telegram.sendMessage(chatId, reply);
      } catch (err) {
        // 내부 오류 세부 정보는 로그에만 기록, 텔레그램에는 일반 오류만 노출
        console.error('[telegram-bridge] 명령 실행 오류:', err instanceof Error ? err.message : err);
        await telegram.sendMessage(chatId, '❌ 명령 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return; // timeout (정상)
    console.error('[telegram-bridge] 폴링 오류:', err);
  }
}

// ─── Paperclip → Telegram 활동 보고 ─────────────────────────────────────────

let lastActivityAt: string = new Date().toISOString();
const ACTIVITY_INTERVAL_MS = 15_000; // 15초 간격 (near real-time)
const MAX_ACTIVITIES_PER_BATCH = 3; // 한 번에 최대 3건
const SEND_DELAY_MS = 1_500; // 메시지 간 1.5초 대기 (rate limit 방지)

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reportActivity(): Promise<void> {
  if (!chatId) return;

  try {
    const allActivities = await paperclip.listActivity(lastActivityAt);
    if (allActivities.length === 0) return;

    // API가 since를 무시하므로 클라이언트에서 필터링 (새 활동만 처리)
    const activities = allActivities.filter(a => a.createdAt > lastActivityAt);
    if (activities.length === 0) return;

    // 가장 최근 활동 시각 갱신 (전송 전 갱신 → 중복 방지)
    const latest = activities.reduce((acc, a) =>
      a.createdAt > acc ? a.createdAt : acc, lastActivityAt);
    lastActivityAt = latest;

    // done/blocked 이벤트 → 상세 보고서 (이슈 제목 + 최신 코멘트 포함)
    // 기타 이벤트 → 간단한 알림
    let sent = 0;
    for (const activity of activities) {
      if (sent >= MAX_ACTIVITIES_PER_BATCH) break;

      const details = activity.details;
      const status = details.status as string | undefined;
      const isDoneOrBlocked =
        activity.action === 'issue.updated' &&
        (status === 'done' || status === 'blocked');

      if (isDoneOrBlocked) {
        const identifier = (details.identifier as string) ?? '';

        // 활동 API에 title이 없으므로 이슈 조회로 보충
        let title = (details.title as string) ?? undefined;
        if (!title) {
          try {
            const issue = await paperclip.getIssue(activity.entityId);
            if (issue) title = issue.title;
          } catch { /* 이슈 조회 실패 시 제목 없이 진행 */ }
        }

        // 에이전트 이름 확인 (에이전트 행위자만, 사용자 행위자는 'Board')
        const agentName = activity.actorType === 'agent'
          ? (agentNameMap.get(activity.actorId ?? '') ?? activity.actorId ?? 'unknown')
          : 'Board';

        // 최신 코멘트 조회 (에이전트/사용자 구분 없이 상세 보고)
        let commentBody: string | null = null;
        try {
          const comment = await paperclip.getLatestComment(activity.entityId);
          if (comment) {
            commentBody = comment.body;
          }
        } catch { /* 코멘트 로드 실패 시 본문 없이 보고 */ }

        const message = formatRunReport(identifier, agentName, status!, commentBody, title);
        try {
          await telegram.sendMessage(chatId!, message);
          sent++;
          await sleep(SEND_DELAY_MS);
        } catch (sendErr) {
          console.warn('[telegram-bridge] 보고서 전송 실패:', sendErr instanceof Error ? sendErr.message : sendErr);
        }
        continue;
      }

      // 일반 활동 포맷
      const agentName = activity.actorId ? agentNameMap.get(activity.actorId) : undefined;
      const message = formatActivity(activity.action, activity.details, agentName);
      if (!message) continue;
      try {
        await telegram.sendMessage(chatId!, message);
        sent++;
        await sleep(SEND_DELAY_MS);
      } catch (sendErr) {
        console.warn('[telegram-bridge] 활동 메시지 전송 실패:', sendErr instanceof Error ? sendErr.message : sendErr);
      }
    }
    if (sent > 0) {
      console.log(`[telegram-bridge] 신규 활동 ${activities.length}건 중 ${sent}건 전송`);
    }
  } catch (err) {
    console.error('[telegram-bridge] 활동 보고 오류:', err instanceof Error ? err.message : err);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  acquireLock();
  console.log('[telegram-bridge] 시작 (PID: ' + process.pid + ')');
  console.log(`  Paperclip: ${PAPERCLIP_API_URL}`);
  console.log(`  채팅 ID: ${chatId ?? '첫 메시지 수신 후 자동 감지'}`);
  console.log(`  활동 보고 간격: ${ACTIVITY_INTERVAL_MS / 1000}초`);

  // 에이전트 이름 로드
  await loadAgentNames();

  // 텔레그램 폴링 상태 초기화 (409 방지)
  await telegram.clearPollingState();

  // 15초마다 활동 보고 (near real-time)
  setInterval(() => { void reportActivity(); }, ACTIVITY_INTERVAL_MS);

  // 텔레그램 long-polling 루프
  while (true) {
    await pollTelegram();
  }
}

main().catch(err => {
  console.error('[telegram-bridge] 치명적 오류:', err);
  process.exit(1);
});
