// 텔레그램 메시지 파싱 및 Paperclip 연동 로직

import { TelegramClient, escapeHtml } from './telegram.js';
import { PaperclipClient } from './paperclip.js';

/** 명령어 파싱 결과 */
type ParsedCommand =
  | { type: 'create'; title: string; description?: string }
  | { type: 'comment'; identifier: string; text: string }
  | { type: 'status' }
  | { type: 'help' }
  | { type: 'unknown'; text: string };

/** 메시지 텍스트를 명령어로 파싱 */
export function parseCommand(text: string): ParsedCommand {
  const t = text.trim();

  // /status — 진행 중인 이슈 목록
  if (/^\/status$/i.test(t)) return { type: 'status' };

  // /help
  if (/^\/help$/i.test(t)) return { type: 'help' };

  // /comment JUS-XX [내용] 또는 comment JUS-XX [내용]
  const commentMatch = t.match(/^(?:\/comment\s+)?(JUS-\d+)\s+(.+)$/is);
  if (commentMatch) {
    return { type: 'comment', identifier: commentMatch[1].toUpperCase(), text: commentMatch[2].trim() };
  }

  // /create [제목] 또는 평문 (이슈 생성)
  const createMatch = t.match(/^(?:\/create\s+)?(.+)$/is);
  if (createMatch && createMatch[1].length > 0) {
    const content = createMatch[1].trim();
    // 첫 줄 = 제목, 나머지 = 설명
    const [firstLine, ...rest] = content.split('\n');
    return {
      type: 'create',
      title: firstLine.trim(),
      description: rest.join('\n').trim() || undefined,
    };
  }

  return { type: 'unknown', text: t };
}

/** 명령어 실행 → 응답 메시지 반환 */
export async function handleCommand(
  parsed: ParsedCommand,
  paperclip: PaperclipClient,
): Promise<string> {
  switch (parsed.type) {
    case 'help':
      return [
        '📋 <b>사용 가능한 명령어</b>',
        '',
        '/create [제목] — 새 이슈 생성',
        '  예: /create 로그인 버그 수정',
        '',
        'JUS-XX [내용] — 특정 이슈에 코멘트',
        '  예: JUS-35 서버 동기화 완료',
        '',
        '/status — 진행 중인 이슈 목록',
        '/help — 이 도움말',
      ].join('\n');

    case 'status': {
      const issues = await paperclip.listIssues('in_progress');
      if (issues.length === 0) return '✅ 현재 진행 중인 이슈 없음';
      const lines = issues.map(
        i => `• <b>${escapeHtml(i.identifier)}</b> [${escapeHtml(i.priority)}] ${escapeHtml(i.title)}`,
      );
      return `🔄 <b>진행 중인 이슈 ${issues.length}건</b>\n\n${lines.join('\n')}`;
    }

    case 'create': {
      const ceoAgentId = process.env.CEO_AGENT_ID;
      const issue = await paperclip.createIssue(parsed.title, parsed.description, ceoAgentId);
      return `✅ 이슈 생성: <b>${escapeHtml(issue.identifier)}</b> ${escapeHtml(issue.title)}`;
    }

    case 'comment': {
      const issue = await paperclip.findIssueByIdentifier(parsed.identifier);
      if (!issue) return `❌ 이슈 ${escapeHtml(parsed.identifier)}를 찾을 수 없음`;
      await paperclip.addComment(issue.id, parsed.text);
      return `✅ <b>${escapeHtml(issue.identifier)}</b>에 코멘트 추가 완료`;
    }

    case 'unknown':
      // 인식 불가 입력 → 이슈 생성 시도
      return handleCommand({ type: 'create', title: parsed.text }, paperclip);
  }
}

/** Paperclip 활동 → 텔레그램 메시지 포맷 (중요 이벤트만 전송) */
export function formatActivity(
  action: string,
  details: Record<string, unknown>,
  agentName?: string,
): string | null {
  switch (action) {
    case 'issue.updated': {
      // done, blocked만 보고 — 일상적 전환(todo→in_progress 등)은 노이즈
      const to = details.status as string | undefined;
      if (to !== 'done' && to !== 'blocked') return null;

      const prev = details._previous as Record<string, unknown> | undefined;
      const from = escapeHtml((prev?.status as string) ?? '');
      const id = escapeHtml((details.identifier as string) ?? '');
      const title = (details.title as string) ?? '';
      const toEsc = escapeHtml(to);
      const emoji = to === 'done' ? '✅' : '🚫';
      const who = agentName ? ` [${escapeHtml(agentName)}]` : '';
      let msg = `${emoji}${who} <b>${id}</b> ${from} → ${toEsc}`;
      if (title) msg += `\n📌 ${escapeHtml(title)}`;
      return msg;
    }
    case 'issue.created': {
      const id = escapeHtml((details.identifier as string) ?? '');
      const title = escapeHtml((details.title as string) ?? '');
      return `🆕 이슈 생성: <b>${id}</b> ${title}`;
    }
    default:
      return null;
  }
}

/** 에이전트 작업 완료 보고서 포맷 (done/blocked 시 최근 코멘트 포함) */
export function formatRunReport(
  identifier: string,
  agentName: string,
  status: string,
  commentBody: string | null,
  title?: string,
): string {
  const emoji = status === 'done' ? '✅' : '🚫';
  const statusLabel = status === 'done' ? '완료' : '블로킹';
  let msg = `${emoji} <b>${escapeHtml(agentName)}</b> 작업 ${statusLabel}: <b>${escapeHtml(identifier)}</b>`;
  if (title) {
    msg += `\n📌 ${escapeHtml(title)}`;
  }
  if (commentBody) {
    msg += `\n\n${escapeHtml(commentBody)}`;
  }
  return msg;
}
