import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

interface BridgeStatus {
  connected: boolean;
  chatId: number | null;
  lastPollAt: string | null;
  messagesProcessed: number;
  errorsCount: number;
}

export function TelegramStatusWidget(_props: PluginWidgetProps) {
  const { data, loading, error, refresh } = usePluginData<BridgeStatus>("bridge-status");
  const testConnection = usePluginAction("test-connection");
  const sendTest = usePluginAction("send-test-message");

  if (loading)
    return (
      <div style={styles.container}>
        <span style={styles.loading}>로딩 중...</span>
      </div>
    );
  if (error)
    return (
      <div style={styles.container}>
        <span style={styles.error}>오류: {error.message}</span>
      </div>
    );

  const connected = data?.connected ?? false;
  const statusDot = connected ? "\ud83d\udfe2" : "\ud83d\udd34";

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <strong>{statusDot} 텔레그램 브릿지</strong>
      </div>

      <div style={styles.grid}>
        <div style={styles.label}>상태</div>
        <div>{connected ? "연결됨" : "미연결 (Bot Token 필요)"}</div>

        <div style={styles.label}>Chat ID</div>
        <div>{data?.chatId ?? "미감지"}</div>

        <div style={styles.label}>마지막 폴링</div>
        <div>{data?.lastPollAt ? formatTime(data.lastPollAt) : "-"}</div>

        <div style={styles.label}>처리된 메시지</div>
        <div>{data?.messagesProcessed ?? 0}건</div>

        {(data?.errorsCount ?? 0) > 0 && (
          <>
            <div style={styles.label}>오류</div>
            <div style={styles.error}>{data?.errorsCount}건</div>
          </>
        )}
      </div>

      <div style={styles.actions}>
        <button
          style={styles.button}
          onClick={async () => {
            const result = (await testConnection()) as {
              success?: boolean;
              botUsername?: string;
              error?: string;
            };
            if (result?.success) {
              alert(`연결 성공: @${result.botUsername}`);
            } else {
              alert(`연결 실패: ${result?.error ?? "알 수 없는 오류"}`);
            }
            refresh();
          }}
        >
          연결 테스트
        </button>
        <button
          style={styles.button}
          onClick={async () => {
            await sendTest();
            alert("테스트 메시지 전송 완료");
          }}
        >
          테스트 메시지
        </button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "0.75rem",
    fontSize: "0.875rem",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "0.25rem 0.75rem",
    alignItems: "baseline",
  },
  label: {
    color: "#888",
    fontWeight: 500,
  },
  actions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.25rem",
  },
  button: {
    padding: "0.25rem 0.75rem",
    fontSize: "0.8125rem",
    border: "1px solid #ddd",
    borderRadius: "4px",
    background: "#fafafa",
    cursor: "pointer",
  },
  loading: { color: "#888" },
  error: { color: "#e53e3e" },
};
