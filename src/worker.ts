/**
 * 텔레그램 브릿지 플러그인 Worker
 *
 * standalone 서비스(index.ts)를 Paperclip 플러그인 SDK로 전환:
 * - while(true) 폴링 루프 → ctx.jobs.register("telegram-poll") 스케줄 Job
 * - setInterval 활동 보고 → ctx.events.on("issue.updated" | "issue.created") 이벤트 구독
 * - PaperclipClient (REST 직접) → ctx.issues.*, ctx.agents.* SDK 도메인 접근
 * - .env 수동 설정 → instanceConfigSchema UI 설정 화면
 * - systemd 프로세스 관리 → Paperclip 런타임 worker 수명주기 관리
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { TelegramClient, escapeHtml } from "./telegram-client.js";
import { parseCommand, formatRunReport, type ParsedCommand } from "./bot.js";

interface PluginConfig {
  telegramBotToken: string;
  telegramChatId?: string;
  companyId: string;
  ceoAgentId?: string;
  projectId?: string;
}

interface PollState {
  telegramOffset?: number;
  chatId?: number;
  lastPollAt?: string;
  messagesProcessed?: number;
  errorsCount?: number;
}

const STATE_KEY = { scopeKind: "instance" as const, stateKey: "telegram-poll" };

function getConfig(raw: Record<string, unknown>): PluginConfig {
  return raw as unknown as PluginConfig;
}

const plugin = definePlugin({
  async setup(ctx) {
    // ─── 에이전트 이름 캐시 ──────────────────────────────
    const agentNameMap = new Map<string, string>();

    async function loadAgentNames(companyId: string): Promise<void> {
      try {
        const agents = await ctx.agents.list({ companyId });
        for (const agent of agents) {
          agentNameMap.set(agent.id, agent.name);
        }
        ctx.logger.info(`에이전트 ${agentNameMap.size}명 로드 완료`);
      } catch (err) {
        ctx.logger.warn("에이전트 목록 로드 실패", { error: String(err) });
      }
    }

    // ─── 텔레그램 폴링 Job ──────────────────────────────
    ctx.jobs.register("telegram-poll", async () => {
      const config = getConfig(await ctx.config.get());
      if (!config.telegramBotToken) {
        ctx.logger.warn("텔레그램 Bot Token 미설정, 폴링 건너뜀");
        return;
      }
      if (!config.companyId) {
        ctx.logger.warn("Company ID 미설정, 폴링 건너뜀");
        return;
      }

      // 에이전트 이름 최초 로드
      if (agentNameMap.size === 0) {
        await loadAgentNames(config.companyId);
      }

      const telegram = new TelegramClient(
        config.telegramBotToken,
        ctx.http.fetch.bind(ctx.http),
      );

      const state = ((await ctx.state.get(STATE_KEY)) ?? {}) as PollState;
      let offset = state.telegramOffset;
      let chatId =
        state.chatId ??
        (config.telegramChatId ? parseInt(config.telegramChatId, 10) : undefined);
      let processed = state.messagesProcessed ?? 0;
      let errors = state.errorsCount ?? 0;

      try {
        const updates = await telegram.getUpdates(offset);

        for (const update of updates) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;

          // 채팅 ID 자동 감지
          if (!chatId) {
            chatId = msg.chat.id;
            ctx.logger.info(`채팅 ID 감지: ${chatId}`);
          }

          const parsed = parseCommand(msg.text);

          try {
            const reply = await handlePluginCommand(parsed, ctx, config);
            await telegram.sendMessage(chatId, reply);
            processed++;
          } catch (err) {
            ctx.logger.error("명령 실행 오류", { error: String(err) });
            await telegram.sendMessage(
              chatId,
              "\u274c 명령 처리 중 오류가 발생했습니다.",
            );
            errors++;
          }
        }
      } catch (err) {
        ctx.logger.error("폴링 오류", { error: String(err) });
        errors++;
      }

      await ctx.state.set(STATE_KEY, {
        telegramOffset: offset,
        chatId,
        lastPollAt: new Date().toISOString(),
        messagesProcessed: processed,
        errorsCount: errors,
      } satisfies PollState);
    });

    // ─── 이슈 이벤트 → 텔레그램 알림 (setInterval 대체) ──
    ctx.events.on("issue.updated", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const status = (payload?.status as string) ?? undefined;
      if (status !== "done" && status !== "blocked") return;

      const config = getConfig(await ctx.config.get());
      if (!config.telegramBotToken || !config.companyId) return;

      const state = ((await ctx.state.get(STATE_KEY)) ?? {}) as PollState;
      const chatId =
        state.chatId ??
        (config.telegramChatId ? parseInt(config.telegramChatId, 10) : undefined);
      if (!chatId) return;

      const telegram = new TelegramClient(
        config.telegramBotToken,
        ctx.http.fetch.bind(ctx.http),
      );

      const identifier = (payload?.identifier as string) ?? "";
      let title = (payload?.title as string) ?? undefined;

      // 이슈 제목이 없으면 조회
      if (!title && event.entityId) {
        try {
          const issue = await ctx.issues.get(event.entityId, config.companyId);
          title = issue?.title ?? "";
        } catch {
          /* 조회 실패 무시 */
        }
      }

      // 에이전트 이름 확인
      const actorId =
        (payload?.actorAgentId as string) ??
        (payload?.assigneeAgentId as string) ??
        "";
      const agentName = agentNameMap.get(actorId) || actorId || "System";

      // 최신 코멘트 조회
      let commentBody: string | null = null;
      if (event.entityId) {
        try {
          const comments = await ctx.issues.listComments(
            event.entityId,
            config.companyId,
          );
          if (comments.length > 0) {
            const sorted = [...comments].sort((a, b) => {
              const aTime = a.createdAt?.toISOString?.() ?? String(a.createdAt ?? "");
              const bTime = b.createdAt?.toISOString?.() ?? String(b.createdAt ?? "");
              return bTime.localeCompare(aTime);
            });
            commentBody = sorted[0].body ?? null;
          }
        } catch {
          /* 코멘트 로드 실패 무시 */
        }
      }

      const message = formatRunReport(
        identifier,
        agentName,
        status,
        commentBody,
        title,
      );
      try {
        await telegram.sendMessage(chatId, message);
      } catch (err) {
        ctx.logger.warn("알림 전송 실패", { error: String(err) });
      }
    });

    ctx.events.on("issue.created", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const config = getConfig(await ctx.config.get());
      if (!config.telegramBotToken) return;

      const state = ((await ctx.state.get(STATE_KEY)) ?? {}) as PollState;
      const chatId =
        state.chatId ??
        (config.telegramChatId ? parseInt(config.telegramChatId, 10) : undefined);
      if (!chatId) return;

      const telegram = new TelegramClient(
        config.telegramBotToken,
        ctx.http.fetch.bind(ctx.http),
      );

      const id = escapeHtml((payload?.identifier as string) ?? "");
      const title = escapeHtml((payload?.title as string) ?? "");
      if (!id) return;

      const message = `\ud83c\udd95 \uc774\uc288 \uc0dd\uc131: <b>${id}</b> ${title}`;
      try {
        await telegram.sendMessage(chatId, message);
      } catch (err) {
        ctx.logger.warn("이슈 생성 알림 전송 실패", { error: String(err) });
      }
    });

    // ─── Data / Actions (UI 위젯용) ─────────────────────
    ctx.data.register("bridge-status", async () => {
      const state = ((await ctx.state.get(STATE_KEY)) ?? {}) as PollState;
      const config = getConfig(await ctx.config.get());
      return {
        connected: !!config.telegramBotToken,
        chatId: state.chatId ?? null,
        lastPollAt: state.lastPollAt ?? null,
        messagesProcessed: state.messagesProcessed ?? 0,
        errorsCount: state.errorsCount ?? 0,
      };
    });

    ctx.actions.register("test-connection", async () => {
      const config = getConfig(await ctx.config.get());
      if (!config.telegramBotToken) {
        return { success: false, error: "Bot Token 미설정" };
      }
      try {
        const res = await ctx.http.fetch(
          `https://api.telegram.org/bot${config.telegramBotToken}/getMe`,
        );
        if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
        const data = (await res.json()) as {
          ok: boolean;
          result?: { username?: string };
        };
        return {
          success: data.ok,
          botUsername: data.result?.username ?? "unknown",
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });

    ctx.actions.register("send-test-message", async (params) => {
      const config = getConfig(await ctx.config.get());
      if (!config.telegramBotToken) {
        return { success: false, error: "Bot Token 미설정" };
      }

      const state = ((await ctx.state.get(STATE_KEY)) ?? {}) as PollState;
      const chatId =
        state.chatId ??
        (config.telegramChatId ? parseInt(config.telegramChatId, 10) : undefined);
      if (!chatId) {
        return {
          success: false,
          error: "Chat ID 미설정 (텔레그램에서 먼저 메시지를 보내세요)",
        };
      }

      const telegram = new TelegramClient(
        config.telegramBotToken,
        ctx.http.fetch.bind(ctx.http),
      );
      const text =
        (params as { message?: string })?.message ??
        "\ud83d\udd14 Paperclip 텔레그램 브릿지 테스트 메시지";
      await telegram.sendMessage(chatId, text);
      return { success: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: "텔레그램 브릿지 worker 실행 중" };
  },

  async onValidateConfig(config) {
    const c = config as unknown as PluginConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!c.telegramBotToken) {
      errors.push("Telegram Bot Token은 필수입니다.");
    } else if (!c.telegramBotToken.includes(":")) {
      errors.push(
        "Bot Token 형식이 올바르지 않습니다 (숫자:영문 형식이어야 합니다).",
      );
    }

    if (!c.companyId) {
      errors.push("Company ID는 필수입니다.");
    }

    if (!c.telegramChatId) {
      warnings.push(
        "Chat ID 미설정 시 첫 메시지 발신자가 자동 허용됩니다. 보안을 위해 명시적 설정을 권장합니다.",
      );
    }

    return { ok: errors.length === 0, errors, warnings };
  },
});

// ─── 명령어 실행 (ctx.issues 사용) ──────────────────────

type WorkerCtx = Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0];

async function handlePluginCommand(
  parsed: ParsedCommand,
  ctx: WorkerCtx,
  config: PluginConfig,
): Promise<string> {
  switch (parsed.type) {
    case "help":
      return [
        "\ud83d\udccb <b>사용 가능한 명령어</b>",
        "",
        "/create [제목] \u2014 새 이슈 생성",
        "  예: /create 로그인 버그 수정",
        "",
        "XXX-00 [내용] \u2014 특정 이슈에 코멘트",
        "  예: JUS-35 서버 동기화 완료",
        "",
        "/status \u2014 진행 중인 이슈 목록",
        "/help \u2014 이 도움말",
      ].join("\n");

    case "status": {
      const issues = await ctx.issues.list({
        companyId: config.companyId,
        status: "in_progress",
      });
      if (issues.length === 0) return "\u2705 현재 진행 중인 이슈 없음";
      const lines = issues.map(
        (i) =>
          `\u2022 <b>${escapeHtml(i.identifier ?? "")}</b> [${escapeHtml(i.priority ?? "")}] ${escapeHtml(i.title ?? "")}`,
      );
      return `\ud83d\udd04 <b>진행 중인 이슈 ${issues.length}건</b>\n\n${lines.join("\n")}`;
    }

    case "create": {
      const issue = await ctx.issues.create({
        companyId: config.companyId,
        title: parsed.title,
        description: parsed.description ?? "",
        priority: "high",
        ...(config.projectId ? { projectId: config.projectId } : {}),
        ...(config.ceoAgentId ? { assigneeAgentId: config.ceoAgentId } : {}),
      });
      return `\u2705 이슈 생성: <b>${escapeHtml(issue.identifier ?? "")}</b> ${escapeHtml(issue.title ?? "")}`;
    }

    case "comment": {
      // identifier로 이슈 검색 (list + filter)
      const issues = await ctx.issues.list({ companyId: config.companyId });
      const issue = issues.find((i) => i.identifier === parsed.identifier);
      if (!issue)
        return `\u274c 이슈 ${escapeHtml(parsed.identifier)}를 찾을 수 없음`;
      await ctx.issues.createComment(issue.id, parsed.text, config.companyId);
      return `\u2705 <b>${escapeHtml(parsed.identifier)}</b>에 코멘트 추가 완료`;
    }

    case "unknown":
      return handlePluginCommand(
        { type: "create", title: parsed.text },
        ctx,
        config,
      );
  }
}

export default plugin;
runWorker(plugin, import.meta.url);
