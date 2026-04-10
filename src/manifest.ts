import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "unchil.plugin-telegram-bridge",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "텔레그램 브릿지",
  description:
    "텔레그램 ↔ Paperclip 양방향 브릿지. 텔레그램에서 이슈 생성/코멘트, Paperclip 활동 알림을 텔레그램으로 실시간 수신.",
  author: "unchil",
  categories: ["connector", "automation"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "agents.read",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "ui.dashboardWidget.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      telegramBotToken: {
        type: "string",
        title: "Telegram Bot Token",
        description: "BotFather에서 발급받은 봇 토큰",
        format: "password",
      },
      telegramChatId: {
        type: "string",
        title: "Telegram Chat ID",
        description: "알림 수신할 채팅 ID (미설정 시 첫 메시지에서 자동 감지)",
      },
      companyId: {
        type: "string",
        title: "Company ID",
        description: "Paperclip 회사 ID",
      },
      ceoAgentId: {
        type: "string",
        title: "CEO Agent ID",
        description: "이슈 생성 시 자동 할당할 에이전트 ID",
      },
      projectId: {
        type: "string",
        title: "Project ID",
        description: "이슈 생성 시 사용할 프로젝트 ID",
      },
    },
    required: ["telegramBotToken", "companyId"],
  },
  jobs: [
    {
      jobKey: "telegram-poll",
      displayName: "텔레그램 메시지 폴링",
      description: "텔레그램 봇 메시지를 주기적으로 수신하여 Paperclip 명령으로 처리",
      schedule: "* * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "telegram-status",
        displayName: "텔레그램 브릿지 상태",
        exportName: "TelegramStatusWidget",
      },
    ],
  },
};

export default manifest;
