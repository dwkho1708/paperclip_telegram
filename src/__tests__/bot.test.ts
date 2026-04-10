/**
 * JUS-34: 텔레그램 봇 브릿지 비즈니스 로직 단위 테스트
 *
 * 검증 항목:
 *  - parseCommand: /help, /status, /create, JUS-XX 코멘트 단축 형식, 알 수 없는 입력
 *  - formatActivity: issue.updated (done/blocked만 보고) / issue.created / 알 수 없는 액션
 *  - formatRunReport: 에이전트 작업 완료 보고서 포맷
 */

import { describe, it, expect } from 'vitest';
import { parseCommand, formatActivity, formatRunReport } from '../bot.js';

// ── parseCommand ──────────────────────────────────────────────────────────────

describe('parseCommand — /help, /status', () => {
  it('/help → type:help', () => {
    expect(parseCommand('/help')).toEqual({ type: 'help' });
  });

  it('/HELP 대문자 → type:help', () => {
    expect(parseCommand('/HELP')).toEqual({ type: 'help' });
  });

  it('/status → type:status', () => {
    expect(parseCommand('/status')).toEqual({ type: 'status' });
  });

  it('/STATUS 대문자 → type:status', () => {
    expect(parseCommand('/STATUS')).toEqual({ type: 'status' });
  });
});

describe('parseCommand — /create', () => {
  it('/create [제목] → title 추출', () => {
    const result = parseCommand('/create 로그인 버그 수정');
    expect(result).toEqual({ type: 'create', title: '로그인 버그 수정', description: undefined });
  });

  it('/create 멀티라인 → 첫 줄=title, 나머지=description', () => {
    const result = parseCommand('/create 새 기능 추가\n상세 설명 내용\n두 번째 줄');
    expect(result.type).toBe('create');
    if (result.type === 'create') {
      expect(result.title).toBe('새 기능 추가');
      expect(result.description).toBe('상세 설명 내용\n두 번째 줄');
    }
  });

  it('일반 평문 (프리픽스 없음) → type:create', () => {
    const result = parseCommand('텔레그램 알림 오류 확인 요청');
    expect(result.type).toBe('create');
    if (result.type === 'create') {
      expect(result.title).toBe('텔레그램 알림 오류 확인 요청');
    }
  });
});

describe('parseCommand — JUS-XX 코멘트 단축 형식', () => {
  it('JUS-35 [내용] → type:comment, identifier=JUS-35', () => {
    const result = parseCommand('JUS-35 서버 동기화 완료');
    expect(result).toEqual({ type: 'comment', identifier: 'JUS-35', text: '서버 동기화 완료' });
  });

  it('/comment JUS-36 [내용] → type:comment', () => {
    const result = parseCommand('/comment JUS-36 마이그레이션 검토 완료');
    expect(result).toEqual({ type: 'comment', identifier: 'JUS-36', text: '마이그레이션 검토 완료' });
  });

  it('jus-37 소문자 → identifier 대문자로 정규화', () => {
    const result = parseCommand('jus-37 QR 스캔 확인');
    expect(result.type).toBe('comment');
    if (result.type === 'comment') {
      expect(result.identifier).toBe('JUS-37');
    }
  });

  it('JUS-XX 뒤 내용 없음 → type:create (코멘트 아님)', () => {
    const result = parseCommand('JUS-99');
    expect(result.type).toBe('create');
  });

  it('JUS-XX 코멘트 멀티라인 → 전체 내용이 text', () => {
    const result = parseCommand('JUS-34 1차 구현 완료\n추가 테스트 필요');
    expect(result.type).toBe('comment');
    if (result.type === 'comment') {
      expect(result.text).toContain('1차 구현 완료');
      expect(result.text).toContain('추가 테스트 필요');
    }
  });
});

describe('parseCommand — unknown', () => {
  it('빈 문자열 → type:unknown', () => {
    const result = parseCommand('');
    expect(result.type).toBe('unknown');
  });
});

// ── formatActivity ─────────────────────────────────────────────────────────

describe('formatActivity — issue.updated', () => {
  it('issue.updated: done → ✅ 포함', () => {
    const msg = formatActivity('issue.updated', {
      identifier: 'JUS-35',
      status: 'done',
      _previous: { status: 'in_progress' },
    });
    expect(msg).toContain('✅');
    expect(msg).toContain('JUS-35');
    expect(msg).toContain('done');
  });

  it('issue.updated: blocked → 🚫 포함', () => {
    const msg = formatActivity('issue.updated', {
      identifier: 'JUS-36',
      status: 'blocked',
      _previous: { status: 'in_progress' },
    });
    expect(msg).toContain('🚫');
    expect(msg).toContain('JUS-36');
  });

  it('issue.updated: in_progress → null (노이즈 필터)', () => {
    const msg = formatActivity('issue.updated', {
      identifier: 'JUS-34',
      status: 'in_progress',
      _previous: { status: 'todo' },
    });
    expect(msg).toBeNull();
  });

  it('issue.updated: 에이전트 이름 포함', () => {
    const msg = formatActivity('issue.updated', {
      identifier: 'JUS-40',
      status: 'done',
      _previous: { status: 'in_progress' },
    }, 'CTO');
    expect(msg).toContain('CTO');
    expect(msg).toContain('✅');
  });

  it('issue.updated: done + title → 제목 포함', () => {
    const msg = formatActivity('issue.updated', {
      identifier: 'JUS-41',
      title: '로그인 버그 수정',
      status: 'done',
      _previous: { status: 'in_progress' },
    });
    expect(msg).toContain('JUS-41');
    expect(msg).toContain('📌');
    expect(msg).toContain('로그인 버그 수정');
  });
});

describe('formatActivity — issue.created', () => {
  it('issue.created → 🆕 포함 메시지', () => {
    const msg = formatActivity('issue.created', {
      identifier: 'JUS-40',
      title: '새 이슈 제목',
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('🆕');
    expect(msg).toContain('JUS-40');
    expect(msg).toContain('새 이슈 제목');
  });
});

describe('formatActivity — 알 수 없는 action', () => {
  it('알 수 없는 액션 → null 반환', () => {
    const msg = formatActivity('issue.archived', { identifier: 'JUS-34' });
    expect(msg).toBeNull();
  });

  it('비어있는 action → null 반환', () => {
    const msg = formatActivity('', {});
    expect(msg).toBeNull();
  });
});

// ── formatRunReport ─────────────────────────────────────────────────────────

describe('formatRunReport', () => {
  it('done + 코멘트 → 완료 보고서', () => {
    const msg = formatRunReport('JUS-50', 'CTO', 'done', '빌드 설정 완료. CI 파이프라인 연결함.');
    expect(msg).toContain('✅');
    expect(msg).toContain('CTO');
    expect(msg).toContain('JUS-50');
    expect(msg).toContain('완료');
    expect(msg).toContain('빌드 설정 완료');
  });

  it('blocked + 코멘트 → 블로킹 보고서', () => {
    const msg = formatRunReport('JUS-51', 'UX Designer', 'blocked', '디자인 시스템 미확정');
    expect(msg).toContain('🚫');
    expect(msg).toContain('UX Designer');
    expect(msg).toContain('블로킹');
    expect(msg).toContain('디자인 시스템 미확정');
  });

  it('done + 코멘트 없음 → 식별자만 포함', () => {
    const msg = formatRunReport('JUS-52', 'QA', 'done', null);
    expect(msg).toContain('✅');
    expect(msg).toContain('QA');
    expect(msg).toContain('JUS-52');
    expect(msg).not.toContain('\n\n');
  });

  it('done + title → 제목 포함', () => {
    const msg = formatRunReport('JUS-54', 'CTO', 'done', '작업 완료', 'API 엔드포인트 추가');
    expect(msg).toContain('📌');
    expect(msg).toContain('API 엔드포인트 추가');
    expect(msg).toContain('작업 완료');
  });

  it('긴 코멘트 → 전체 표시 (텔레그램 전송 시 자동 분할)', () => {
    const longComment = 'A'.repeat(600);
    const msg = formatRunReport('JUS-53', 'CTO', 'done', longComment);
    expect(msg).toContain('A'.repeat(600));
  });
});
