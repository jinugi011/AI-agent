/** FastAPI 백엔드 / Rust 엔진 HTTP 클라이언트.
 *
 * 로컬 모드: 백엔드(127.0.0.1:8010)·엔진(127.0.0.1:18091)에 직접 연결.
 * 원격 모드: Cloudflare Tunnel 주소(serverUrl) 하나로 백엔드에 연결하고, LLM 생성도 백엔드가 중계한다.
 *           API 토큰(+선택: Cloudflare Access 서비스 토큰)은 VS Code SecretStorage 에 보관.
 */
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

export const SECRET_TOKEN = 'localAgent.apiToken';
export const SECRET_CF_ID = 'localAgent.cfAccessClientId';
export const SECRET_CF_SECRET = 'localAgent.cfAccessClientSecret';

let secrets: vscode.SecretStorage | undefined;
const secretCache = new Map<string, string>();

/** activate 에서 호출: 비밀값을 메모리에 캐시하고 변경을 따라간다. */
export async function initClients(store: vscode.SecretStorage) {
  secrets = store;
  for (const k of [SECRET_TOKEN, SECRET_CF_ID, SECRET_CF_SECRET]) secretCache.set(k, (await store.get(k)) ?? '');
  store.onDidChange(async (e) => secretCache.set(e.key, (await store.get(e.key)) ?? ''));
}

export async function setSecret(key: string, value: string) {
  if (!secrets) return;
  if (value) await secrets.store(key, value);
  else await secrets.delete(key);
  secretCache.set(key, value);
}

export function isRemote(): boolean {
  return vscode.workspace.getConfiguration('localAgent').get<string>('mode', 'local') === 'remote';
}

function cfg() {
  const c = vscode.workspace.getConfiguration('localAgent');
  const remote = isRemote();
  return {
    remote,
    backend: (remote ? c.get<string>('serverUrl', '') : c.get<string>('backendUrl', 'http://127.0.0.1:8010')).replace(/\/$/, ''),
    engine: c.get<string>('engineUrl', 'http://127.0.0.1:18091').replace(/\/$/, ''),
  };
}

/** 원격 모드 인증 헤더 */
function authHeaders(): Record<string, string> {
  if (!isRemote()) return {};
  const h: Record<string, string> = {};
  const token = secretCache.get(SECRET_TOKEN);
  if (token) h.Authorization = `Bearer ${token}`;
  const id = secretCache.get(SECRET_CF_ID);
  const sec = secretCache.get(SECRET_CF_SECRET);
  if (id && sec) {
    h['CF-Access-Client-Id'] = id;
    h['CF-Access-Client-Secret'] = sec;
  }
  return h;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 마지막 백엔드 연결 실패 이유 (상태 표시용) */
export let lastBackendError = '';

async function request<T>(base: string, path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  if (!base) throw new HttpError(0, '원격 서버 주소가 설정되지 않았습니다 (Yang Coding: 원격 접속 설정)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
      signal: init?.signal ?? ctrl.signal,
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Cloudflare Access 로그인 페이지(HTML) 등
      throw new HttpError(res.status, res.status === 403 || text.includes('cloudflareaccess')
        ? 'Cloudflare Access 가 요청을 막았습니다 (서비스 토큰 확인)'
        : `JSON 이 아닌 응답 (HTTP ${res.status})`);
    }
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
      await request(cfg().backend, '/api/health', { timeoutMs: isRemote() ? 8000 : 2000 });
      lastBackendError = '';
      return true;
    } catch (e: any) {
      lastBackendError = e?.status === 401 ? 'API 토큰이 없거나 틀립니다' : (e?.message ?? String(e));
      return false;
    }
  },
};

export const engine = {
  async health(): Promise<any | null> {
    try {
      if (isRemote()) {
        // 원격: 엔진은 서버 localhost 에만 있으므로 백엔드에 상태를 묻는다
        const st: any = await backend.get('/api/engine/status', 8000);
        return st.online && st.model?.model_name ? { model: st.model } : null;
      }
      const data: any = await request(cfg().engine, '/health', { timeoutMs: 2000 });
      // 같은 포트의 다른 서버를 엔진으로 착각하지 않도록 모델 정보 확인
      return data?.model?.model_name ? data : null;
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
    const c = cfg();
    const url = c.remote ? `${c.backend}/api/llm/generate` : `${c.engine}/generate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ messages, max_tokens: opts.maxTokens, temperature: opts.temperature, stream: true }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(res.status, `엔진 오류 (HTTP ${res.status}): ${detail.slice(0, 300)}`);
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
        } // {"ping":1}: 원격 중계의 연결 유지 신호 → 무시
      }
    }
    return { text, stats };
  },
};
