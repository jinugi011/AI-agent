/** FastAPI 백엔드 / Rust 엔진 HTTP 클라이언트. */
import * as vscode from 'vscode';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateStats {
  prompt_tokens: number;
  completion_tokens: number;
  tokens_per_second: number;
  finish_reason: string;
}

function cfg() {
  const c = vscode.workspace.getConfiguration('localAgent');
  return {
    backend: c.get<string>('backendUrl', 'http://127.0.0.1:8010').replace(/\/$/, ''),
    engine: c.get<string>('engineUrl', 'http://127.0.0.1:8091').replace(/\/$/, ''),
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(base: string, path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: init?.signal ?? ctrl.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new HttpError(res.status, data.detail || data.error || `HTTP ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export const backend = {
  get: <T = any>(path: string, timeoutMs?: number) => request<T>(cfg().backend, path, { timeoutMs }),
  post: <T = any>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>(cfg().backend, path, { method: 'POST', body: JSON.stringify(body), timeoutMs }),
  async alive(): Promise<boolean> {
    try {
      await request(cfg().backend, '/api/health', { timeoutMs: 2000 });
      return true;
    } catch {
      return false;
    }
  },
};

export const engine = {
  async health(): Promise<any | null> {
    try {
      return await request(cfg().engine, '/health', { timeoutMs: 2000 });
    } catch {
      return null;
    }
  },

  /** 토큰 스트리밍 생성. signal 로 중단하면 엔진도 생성을 멈춘다(연결 종료 감지). */
  async stream(
    messages: ChatMessage[],
    opts: { maxTokens: number; temperature: number; signal: AbortSignal },
    onToken: (t: string) => void,
  ): Promise<{ text: string; stats?: GenerateStats }> {
    const res = await fetch(`${cfg().engine}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: opts.maxTokens, temperature: opts.temperature, stream: true }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(res.status, `엔진 오류: ${detail}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let stats: GenerateStats | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (typeof ev.token === 'string') {
          text += ev.token;
          onToken(ev.token);
        } else if (ev.done) {
          if (ev.error) throw new Error(ev.error);
          stats = ev;
        }
      }
    }
    return { text, stats };
  },
};
