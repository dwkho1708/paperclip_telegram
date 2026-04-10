import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/bot.js";
import { chunkMessage, escapeHtml } from "../src/telegram-client.js";
import { formatActivity, formatRunReport } from "../src/bot.js";

describe("parseCommand", () => {
  it("/status 명령어", () => {
    expect(parseCommand("/status")).toEqual({ type: "status" });
  });

  it("/help 명령어", () => {
    expect(parseCommand("/help")).toEqual({ type: "help" });
  });

  it("/create 명령어 (제목만)", () => {
    const result = parseCommand("/create 로그인 버그 수정");
    expect(result).toEqual({ type: "create", title: "로그인 버그 수정" });
  });

  it("/create 명령어 (제목+설명)", () => {
    const result = parseCommand("/create 새 기능\n상세 설명");
    expect(result).toEqual({
      type: "create",
      title: "새 기능",
      description: "상세 설명",
    });
  });

  it("JUS-XX [내용] 코멘트", () => {
    const result = parseCommand("JUS-35 서버 동기화 완료");
    expect(result).toEqual({
      type: "comment",
      identifier: "JUS-35",
      text: "서버 동기화 완료",
    });
  });

  it("/comment JUS-XX [내용] 코멘트", () => {
    const result = parseCommand("/comment JUS-36 검토 완료");
    expect(result).toEqual({
      type: "comment",
      identifier: "JUS-36",
      text: "검토 완료",
    });
  });

  it("일반 텍스트 → 이슈 생성", () => {
    const result = parseCommand("텔레그램 알림 오류 확인");
    expect(result).toEqual({
      type: "create",
      title: "텔레그램 알림 오류 확인",
    });
  });

  it("대소문자 무시 식별자", () => {
    const result = parseCommand("jus-10 소문자 테스트");
    expect(result).toEqual({
      type: "comment",
      identifier: "JUS-10",
      text: "소문자 테스트",
    });
  });
});

describe("chunkMessage", () => {
  it("짧은 메시지는 분할하지 않음", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("긴 메시지를 줄바꿈 기준으로 분할", () => {
    const text = "A\nB\nC\nD\nE";
    const chunks = chunkMessage(text, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toContain("A");
  });
});

describe("escapeHtml", () => {
  it("HTML 특수문자를 이스케이프", () => {
    expect(escapeHtml('<b>"test"</b> & more')).toBe(
      "&lt;b&gt;&quot;test&quot;&lt;/b&gt; &amp; more",
    );
  });
});

describe("formatActivity", () => {
  it("done 이벤트 포맷", () => {
    const result = formatActivity("issue.updated", {
      status: "done",
      identifier: "JUS-10",
      title: "테스트 이슈",
      _previous: { status: "in_progress" },
    }, "CTO");
    expect(result).toContain("JUS-10");
    expect(result).toContain("CTO");
    expect(result).toContain("done");
  });

  it("일상적 전환은 null 반환", () => {
    const result = formatActivity("issue.updated", {
      status: "in_progress",
      _previous: { status: "todo" },
    });
    expect(result).toBeNull();
  });

  it("이슈 생성 포맷", () => {
    const result = formatActivity("issue.created", {
      identifier: "JUS-20",
      title: "새 이슈",
    });
    expect(result).toContain("JUS-20");
    expect(result).toContain("새 이슈");
  });
});

describe("formatRunReport", () => {
  it("완료 보고서 포맷", () => {
    const result = formatRunReport("JUS-10", "CTO", "done", "작업 완료 코멘트", "테스트 이슈");
    expect(result).toContain("완료");
    expect(result).toContain("JUS-10");
    expect(result).toContain("CTO");
    expect(result).toContain("작업 완료 코멘트");
  });

  it("블로킹 보고서 포맷", () => {
    const result = formatRunReport("JUS-11", "DevAgent", "blocked", null, "블로킹 이슈");
    expect(result).toContain("블로킹");
    expect(result).toContain("JUS-11");
  });
});
