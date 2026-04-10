/**
 * 명령어 파싱 및 포맷팅 로직 (순수 함수)
 *
 * standalone 버전에서 그대로 이식.
 * parseCommand, formatActivity, formatRunReport는 변경 없음.
 */

import { escapeHtml } from "./telegram-client.js";

/** 명령어 파싱 결과 */
export type ParsedCommand =
  | { type: "create"; title: string; description?: string }
  | { type: "comment"; identifier: string; text: string }
  | { type: "status" }
  | { type: "help" }
  | { type: "unknown"; text: string };

/** 메시지 텍스트를 명령어로 파싱 */
export function parseCommand(text: string): ParsedCommand {
  const t = text.trim();

  if (/^\/status$/i.test(t)) return { type: "status" };
  if (/^\/help$/i.test(t)) return { type: "help" };

  // /comment JUS-XX [내용] 또는 JUS-XX [내용]
  const commentMatch = t.match(/^(?:\/comment\s+)?([A-Z]{2,5}-\d+)\s+(.+)$/is);
  if (commentMatch) {
    return {
      type: "comment",
      identifier: commentMatch[1].toUpperCase(),
      text: commentMatch[2].trim(),
    };
  }

  // /create [제목] 또는 평문 (이슈 생성)
  const createMatch = t.match(/^(?:\/create\s+)?(.+)$/is);
  if (createMatch && createMatch[1].length > 0) {
    const content = createMatch[1].trim();
    const [firstLine, ...rest] = content.split("\n");
    return {
      type: "create",
      title: firstLine.trim(),
      description: rest.join("\n").trim() || undefined,
    };
  }

  return { type: "unknown", text: t };
}

/** Paperclip 활동 → 텔레그램 메시지 포맷 (중요 이벤트만) */
export function formatActivity(
  action: string,
  details: Record<string, unknown>,
  agentName?: string,
): string | null {
  switch (action) {
    case "issue.updated": {
      const to = details.status as string | undefined;
      if (to !== "done" && to !== "blocked") return null;
      const prev = details._previous as Record<string, unknown> | undefined;
      const from = escapeHtml((prev?.status as string) ?? "");
      const id = escapeHtml((details.identifier as string) ?? "");
      const title = (details.title as string) ?? "";
      const toEsc = escapeHtml(to);
      const emoji = to === "done" ? "\u2705" : "\ud83d\udeab";
      const who = agentName ? ` [${escapeHtml(agentName)}]` : "";
      let msg = `${emoji}${who} <b>${id}</b> ${from} \u2192 ${toEsc}`;
      if (title) msg += `\n\ud83d\udccc ${escapeHtml(title)}`;
      return msg;
    }
    case "issue.created": {
      const id = escapeHtml((details.identifier as string) ?? "");
      const title = escapeHtml((details.title as string) ?? "");
      return `\ud83c\udd95 \uc774\uc288 \uc0dd\uc131: <b>${id}</b> ${title}`;
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
  const emoji = status === "done" ? "\u2705" : "\ud83d\udeab";
  const statusLabel = status === "done" ? "\uc644\ub8cc" : "\ube14\ub85c\ud0b9";
  let msg = `${emoji} <b>${escapeHtml(agentName)}</b> \uc791\uc5c5 ${statusLabel}: <b>${escapeHtml(identifier)}</b>`;
  if (title) {
    msg += `\n\ud83d\udccc ${escapeHtml(title)}`;
  }
  if (commentBody) {
    msg += `\n\n${escapeHtml(commentBody)}`;
  }
  return msg;
}
