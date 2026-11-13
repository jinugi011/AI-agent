//! agent-engine: 로컬 GGUF 코딩 모델을 llama.cpp(Metal)로 구동하는 HTTP 추론 서버.
//!
//!   GET  /health    → 모델 정보
//!   POST /generate  → {messages, max_tokens, temperature, top_p, grammar, stop, seed}
//!
//! HTTP 워커 스레드는 요청을 받아 채널로 넘기고, 모델/KV 캐시를 소유한
//! 단일 추론 스레드가 순차 처리한다 (llama 컨텍스트는 스레드 간 공유하지 않는다).

mod engine;

use std::io::Write;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use anyhow::Result;
use clap::Parser;
use tiny_http::{Header, Method, Response, Server};

use engine::{Engine, EngineConfig, GenerateRequest, GenerateResponse};

#[derive(Parser, Debug)]
#[command(name = "agent-engine", about = "Local coding-model inference server (Rust + llama.cpp)")]
struct Args {
    /// GGUF 모델 경로
    #[arg(long, env = "ENGINE_MODEL_PATH")]
    model: String,
    #[arg(long, env = "ENGINE_HOST", default_value = "127.0.0.1")]
    host: String,
    #[arg(long, env = "ENGINE_PORT", default_value_t = 8091)]
    port: u16,
    /// 컨텍스트 길이 (M3 Max 36GB + 30B-A3B Q4 기준 32k 권장)
    #[arg(long, env = "ENGINE_CTX", default_value_t = 32768)]
    ctx: u32,
    #[arg(long, default_value_t = 512)]
    batch: u32,
    /// Metal 로 올릴 레이어 수 (999 = 전부)
    #[arg(long, default_value_t = 999)]
    gpu_layers: u32,
    #[arg(long, default_value_t = 8)]
    threads: i32,
    /// 서버를 띄우지 않고 프롬프트 한 번만 실행 (동작 확인용)
    #[arg(long)]
    prompt: Option<String>,
}

enum Event {
    Token(String),
    Done(Result<GenerateResponse, String>),
}

type Job = (GenerateRequest, mpsc::Sender<Event>);

/// 스트리밍 응답: 소켓에 직접 chunked NDJSON 을 쓰고 이벤트마다 flush 한다.
/// 클라이언트가 끊기면 쓰기가 실패 → 수신 채널이 drop → 추론 스레드가 생성을 중단한다.
fn stream_events(request: tiny_http::Request, rx: mpsc::Receiver<Event>) {
    let mut w = request.into_writer();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nTransfer-Encoding: chunked\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if w.write_all(head.as_bytes()).and_then(|_| w.flush()).is_err() {
        return;
    }
    for ev in rx {
        let (line, last) = match ev {
            Event::Token(t) => (serde_json::json!({ "token": t }).to_string(), false),
            Event::Done(Ok(res)) => {
                let mut v = serde_json::to_value(&res).unwrap();
                v["done"] = serde_json::Value::Bool(true);
                (v.to_string(), true)
            }
            Event::Done(Err(e)) => (serde_json::json!({ "done": true, "error": e }).to_string(), true),
        };
        let payload = format!("{line}\n");
        let chunk = format!("{:x}\r\n{payload}\r\n", payload.len());
        if w.write_all(chunk.as_bytes()).and_then(|_| w.flush()).is_err() {
            return;
        }
        if last {
            break;
        }
    }
    let _ = w.write_all(b"0\r\n\r\n");
    let _ = w.flush();
}

fn json_response(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap())
}

fn error_body(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn main() -> Result<()> {
    let args = Args::parse();
    let cfg = EngineConfig {
        model_path: args.model.clone(),
        n_ctx: args.ctx,
        n_batch: args.batch,
        n_gpu_layers: args.gpu_layers,
        n_threads: args.threads,
    };

    eprintln!("[engine] 모델 로딩: {}", cfg.model_path);
    // 선언 역순으로 drop 되므로 eng(컨텍스트) → model → backend 순서로 안전하게 해제된다.
    let (backend, model) = engine::load_model(&cfg)?;
    let mut eng = Engine::new(&backend, &model, &cfg)?;
    eprintln!(
        "[engine] 로드 완료: {} ({:.1}B params, ctx {})",
        eng.info.model_name,
        eng.info.n_params as f64 / 1e9,
        eng.info.n_ctx
    );

    if let Some(prompt) = args.prompt {
        let req: GenerateRequest = serde_json::from_value(serde_json::json!({
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 256
        }))?;
        let res = eng.generate(&req)?;
        println!("{}", res.text);
        eprintln!("[engine] {} tokens, {:.1} tok/s", res.completion_tokens, res.tokens_per_second);
        return Ok(());
    }

    let info_json = Arc::new(serde_json::json!({ "status": "ok", "model": eng.info }).to_string());
    let addr = format!("{}:{}", args.host, args.port);
    let server = Arc::new(Server::http(&addr).map_err(|e| anyhow::anyhow!("{addr} 바인드 실패: {e}"))?);
    eprintln!("[engine] listening on http://{addr}");

    let (job_tx, job_rx) = mpsc::channel::<Job>();

    for _ in 0..4 {
        let server = Arc::clone(&server);
        let job_tx = job_tx.clone();
        let info_json = Arc::clone(&info_json);
        thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let response = match (request.method(), request.url()) {
                    (Method::Get, "/health") => json_response(200, info_json.to_string()),
                    (Method::Post, "/generate") => {
                        let mut body = String::new();
                        if let Err(e) = request.as_reader().read_to_string(&mut body) {
                            json_response(400, error_body(&format!("본문 읽기 실패: {e}")))
                        } else {
                            match serde_json::from_str::<GenerateRequest>(&body) {
                                Err(e) => json_response(400, error_body(&format!("잘못된 요청 JSON: {e}"))),
                                Ok(req) => {
                                    let streaming = req.stream;
                                    let (tx, rx) = mpsc::channel();
                                    if job_tx.send((req, tx)).is_err() {
                                        json_response(503, error_body("추론 스레드가 종료되었습니다"))
                                    } else if streaming {
                                        stream_events(request, rx);
                                        continue;
                                    } else {
                                        let done = rx.iter().find_map(|ev| match ev {
                                            Event::Done(r) => Some(r),
                                            Event::Token(_) => None,
                                        });
                                        match done {
                                            Some(Ok(res)) => json_response(200, serde_json::to_string(&res).unwrap()),
                                            Some(Err(msg)) => json_response(422, error_body(&msg)),
                                            None => json_response(500, error_body("추론 결과 수신 실패")),
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => json_response(404, error_body("not found")),
                };
                let _ = request.respond(response);
            }
        });
    }
    drop(job_tx);

    // 메인 스레드 = 추론 스레드
    for (req, reply) in job_rx {
        let streaming = req.stream;
        let res = eng
            .generate_with(&req, &mut |t| !streaming || reply.send(Event::Token(t.to_string())).is_ok())
            .map_err(|e| format!("{e:#}"));
        if let Ok(r) = &res {
            eprintln!(
                "[engine] prompt {} + gen {} tokens ({:.1} tok/s, {})",
                r.prompt_tokens, r.completion_tokens, r.tokens_per_second, r.finish_reason
            );
        }
        let _ = reply.send(Event::Done(res));
    }
    Ok(())
}
