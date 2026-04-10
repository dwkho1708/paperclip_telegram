// Paperclip API 클라이언트

/** HTTP 상태코드를 포함하는 API 에러 */
export class PaperclipHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PaperclipHttpError';
  }
}

export interface PaperclipIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  updatedAt: string;
}

export interface PaperclipActivity {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface PaperclipAgent {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface PaperclipComment {
  id: string;
  body: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt: string;
}

/** Paperclip API 클라이언트 */
export class PaperclipClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly companyId: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}/api${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PaperclipHttpError(res.status, `Paperclip API ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as T & { error?: string };
    if ((data as { error?: string }).error) {
      throw new Error(`Paperclip API 오류: ${(data as { error: string }).error}`);
    }
    return data;
  }

  /** 이슈 목록 조회 */
  async listIssues(status?: string): Promise<PaperclipIssue[]> {
    const query = status ? `?status=${status}` : '';
    const data = await this.request<{ issues?: PaperclipIssue[] } | PaperclipIssue[]>(
      'GET',
      `/companies/${this.companyId}/issues${query}`,
    );
    if (Array.isArray(data)) return data;
    return (data as { issues?: PaperclipIssue[] }).issues ?? [];
  }

  /** 이슈 생성 (assigneeAgentId 설정 시 해당 에이전트에 할당) */
  async createIssue(title: string, description?: string, assigneeAgentId?: string): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>('POST', `/companies/${this.companyId}/issues`, {
      title,
      description: description ?? '',
      status: 'todo',
      priority: 'high',
      projectId: process.env.PAPERCLIP_PROJECT_ID,
      ...(assigneeAgentId ? { assigneeAgentId } : {}),
    });
  }

  /** 이슈 코멘트 추가 */
  async addComment(issueId: string, body: string): Promise<void> {
    await this.request('POST', `/issues/${issueId}/comments`, { body });
  }

  /** 이슈 코멘트 추가 (identifier로) */
  async findIssueByIdentifier(identifier: string): Promise<PaperclipIssue | null> {
    const issues = await this.listIssues();
    return issues.find(i => i.identifier === identifier) ?? null;
  }

  /** CEO 하트비트 트리거 (webhook 방식) — 텔레그램 명령 수신 후 즉시 호출 */
  async fireHeartbeatWebhook(): Promise<void> {
    const publicId = process.env.HEARTBEAT_WEBHOOK_PUBLIC_ID;
    const secret = process.env.HEARTBEAT_WEBHOOK_SECRET;
    if (!publicId || !secret) {
      console.warn('[paperclip] HEARTBEAT_WEBHOOK_PUBLIC_ID 또는 HEARTBEAT_WEBHOOK_SECRET 미설정, 하트비트 트리거 건너뜀');
      return;
    }
    try {
      const res = await fetch(`${this.apiUrl}/api/routine-triggers/public/${publicId}/fire`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(`[paperclip] 하트비트 webhook 실패: HTTP ${res.status} ${text.slice(0, 200)}`);
        return;
      }
      console.log('[paperclip] CEO 하트비트 트리거 완료');
    } catch (err) {
      console.warn('[paperclip] 하트비트 webhook 오류:', err instanceof Error ? err.message : err);
    }
  }

  /** 에이전트 목록 조회 */
  async listAgents(): Promise<PaperclipAgent[]> {
    const data = await this.request<PaperclipAgent[] | { agents?: PaperclipAgent[] }>(
      'GET',
      `/companies/${this.companyId}/agents`,
    );
    if (Array.isArray(data)) return data;
    return (data as { agents?: PaperclipAgent[] }).agents ?? [];
  }

  /** 이슈의 최근 코멘트 조회 (가장 마지막 코멘트 반환) */
  async getLatestComment(issueId: string): Promise<PaperclipComment | null> {
    try {
      const data = await this.request<PaperclipComment[] | { items?: PaperclipComment[] }>(
        'GET',
        `/issues/${issueId}/comments`,
      );
      const comments = Array.isArray(data) ? data : (data as { items?: PaperclipComment[] }).items ?? [];
      if (comments.length === 0) return null;
      // 최신순 정렬 (API가 최신순이 아닐 수 있으므로)
      comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return comments[0];
    } catch {
      return null;
    }
  }

  /** 이슈 단건 조회 (제목/상세 정보 확인용) */
  async getIssue(issueId: string): Promise<PaperclipIssue | null> {
    try {
      return await this.request<PaperclipIssue>('GET', `/issues/${issueId}`);
    } catch {
      return null;
    }
  }

  /** 최근 활동 조회 (lastSeenAt 이후) — 엔드포인트 미지원(404) 시 [] 반환으로 무중단 */
  async listActivity(since?: string): Promise<PaperclipActivity[]> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    try {
      const data = await this.request<PaperclipActivity[] | { activities?: PaperclipActivity[] }>(
        'GET',
        `/companies/${this.companyId}/activity${query}`,
      );
      if (Array.isArray(data)) return data;
      return (data as { activities?: PaperclipActivity[] }).activities ?? [];
    } catch (err: unknown) {
      // 404만 삼킴: 엔드포인트 미지원 시 활동 보고를 건너뛰고 무중단 유지
      if (err instanceof PaperclipHttpError && err.status === 404) {
        console.warn('[paperclip] listActivity: 엔드포인트 미지원 (404), 활동 보고 건너뜀');
        return [];
      }
      throw err; // 인증 오류(401/403), 서버 오류(500) 등은 그대로 전파
    }
  }
}
