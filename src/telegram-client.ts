/**
 * Telegram Bot API 클라이언트 (플러그인 SDK ctx.http.fetch 기반)
 *
 * standalone 버전의 telegram.ts에서 이식.
 * fetch를 외부에서 주입받아 ctx.http.fetch()를 사용할 수 있도록 설계.
 */

const TELEGRAM_API = "https://api.telegram.org/bot";
const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name: string };
    text?: string;
    date: number;
  };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** 긴 메시지를 Telegram 제한(4096자)에 맞게 분할 */
export function chunkMessage(
  text: string,
  limit: number = MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

/** HTML 특수문자 이스케이프 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Telegram Bot API 래퍼 (플러그인용, fetch 주입) */
export class TelegramClient {
  private baseUrl: string;

  constructor(
    token: string,
    private readonly fetchFn: FetchFn,
  ) {
    this.baseUrl = `${TELEGRAM_API}${token}`;
  }

  /** webhook/polling 상태 초기화 (409 방지) */
  async clearPollingState(): Promise<void> {
    try {
      await this.fetchFn(
        `${this.baseUrl}/deleteWebhook?drop_pending_updates=true`,
      );
    } catch {
      // 초기화 실패 무시
    }
  }

  /** getUpdates로 새 메시지 수신 (short polling, 5초 timeout — job 스케줄 내에서 사용) */
  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("timeout", "5");
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
    if (offset !== undefined) url.searchParams.set("offset", String(offset));

    const res = await this.fetchFn(url.toString());
    if (res.status === 409) {
      await this.clearPollingState();
      return [];
    }
    if (!res.ok) return [];
    const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
    return data.ok ? data.result : [];
  }

  /** 단일 메시지 전송 (429 시 retry_after 대기 후 1회 재시도) */
  private async sendSingle(chatId: number, text: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchFn(`${this.baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (res.ok) return;

      if (res.status === 429 && attempt === 0) {
        const body = await res.json().catch(() => ({})) as { parameters?: { retry_after?: number } };
        const wait = Math.min((body.parameters?.retry_after ?? 5) + 1, 30);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      return; // 실패 시 무시 (job이 재시도)
    }
  }

  /** 메시지 전송 (4096자 초과 시 자동 분할) */
  async sendMessage(chatId: number, text: string): Promise<void> {
    const chunks = chunkMessage(text);
    for (const chunk of chunks) {
      await this.sendSingle(chatId, chunk);
    }
  }
}
