// Telegram Bot API 클라이언트 (node-fetch 기반)

const TELEGRAM_API = 'https://api.telegram.org/bot';

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name: string };
  text?: string;
  date: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

const MAX_MESSAGE_LENGTH = 4096;

/** 긴 메시지를 Telegram 제한(4096자)에 맞게 분할 */
export function chunkMessage(text: string, limit: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // 줄바꿈 기준으로 분할 시도
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

/** Telegram Bot API 래퍼 */
export class TelegramClient {
  private baseUrl: string;

  constructor(private readonly token: string) {
    this.baseUrl = `${TELEGRAM_API}${token}`;
  }

  /** 시작 전 webhook/polling 상태 초기화 (409 방지) */
  async clearPollingState(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/deleteWebhook?drop_pending_updates=true`);
      if (res.ok) console.log('[telegram] 폴링 상태 초기화 완료');
    } catch (err) {
      console.warn('[telegram] 폴링 상태 초기화 실패:', err instanceof Error ? err.message : err);
    }
  }

  /** long-polling으로 새 메시지 수신 (timeout=25초, 409 시 재초기화 후 재시도) */
  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set('timeout', '25');
    url.searchParams.set('allowed_updates', JSON.stringify(['message']));
    if (offset !== undefined) url.searchParams.set('offset', String(offset));

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
    if (res.status === 409) {
      console.warn('[telegram] getUpdates 409 충돌 — 폴링 상태 재초기화 후 5초 대기');
      await this.clearPollingState();
      await new Promise(r => setTimeout(r, 5_000));
      return [];
    }
    if (!res.ok) throw new Error(`Telegram API 오류: ${res.status}`);
    const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
    if (!data.ok) throw new Error('Telegram getUpdates 실패');
    return data.result;
  }

  /** 단일 메시지 전송 (429 시 retry-after 대기 후 1회 재시도) */
  private async sendSingle(chatId: number, text: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (res.ok) return;

      const body = await res.text();
      if (res.status === 429 && attempt === 0) {
        const parsed = JSON.parse(body).parameters?.retry_after ?? 5;
        const wait = Math.min(parsed + 1, 30);
        console.warn(`[telegram] 429 rate limit — ${wait}초 대기 후 재시도`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      console.error(`[telegram] sendMessage 실패 상세: ${body}`);
      throw new Error(`메시지 전송 실패 (HTTP ${res.status})`);
    }
  }

  /** 텔레그램 메시지 전송 (4096자 초과 시 자동 분할) */
  async sendMessage(chatId: number, text: string): Promise<void> {
    const chunks = chunkMessage(text);
    for (const chunk of chunks) {
      await this.sendSingle(chatId, chunk);
    }
  }
}

/** HTML 특수문자 이스케이프 (parse_mode: HTML 사용 시 사용자 입력 필수 처리) */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
