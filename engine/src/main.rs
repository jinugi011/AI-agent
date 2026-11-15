//! agent-engine: 로컬 GGUF 코딩 모델을 llama.cpp(Metal)로 구동하는 HTTP 추론 서버.
//!
//!   GET  /health    → 모델 정보
//!   POST /generate  → {messages, max_tokens, temperature, top_p, grammar, stop, seed}
//!   POST /vision    → {image(base64), prompt, max_tokens} 이미지 분석 (비전 모델, 첫 요청 때 로드)
//!   POST /vision/unload → 비전 모델을 메모리에서 내림
//!
//! HTTP 워커 스레드는 요청을 받아 채널로 넘기고, 모델/KV 캐시를 소유한
//! 단일 추론 스레드가 순차 처리한다 (llama 컨텍스트는 스레드 간 공유하지 않는다).

mod engine;
mod vision;

use std::io::Write;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use anyhow::Result;
use clap::Parser;
use tiny_http::{Header, Method, Response, Server};

use engine::{Coder, EngineConfig, GenerateRequest, GenerateResponse};
use vision::{Vision, VisionRequest};

#[derive(Parser, Debug)]
#[command(name = "agent-engine", about = "Local coding-model inference server (Rust + llama.cpp)")]
struct Args {
    /// GGUF 모델 경로
    #[arg(long, env = "ENGINE_MODEL_PATH")]
    model: String,
    #[arg(long, env = "ENGINE_HOST", default_value = "127.0.0.1")]
    host: String,
    #[arg(long, env = "ENGINE_PORT", default_value_t = 18091)]
    port: u16,
    /// 컨텍스트 길이 (M3 Max 36GB + 30B-A3B Q4 기준 32k 권장)
    #[arg(long, env = "ENGINE_CTX", default_value_t = 32768)]
    ctx: u32,
    /// 프롬프트를 한 번에 넣는 토큰 수 (클수록 긴 프롬프트 처리가 빠름)
    #[arg(long, default_value_t = 2048)]
    batch: u32,
    /// GPU 한 번 연산 단위 (Metal 은 512 가 적당)
    #[arg(long, default_value_t = 512)]
    ubatch: u32,
    /// Metal 로 올릴 레이어 수 (999 = 전부)
    #[arg(long, default_value_t = 999)]
    gpu_layers: u32,
    #[arg(long, default_value_t = 8)]
    threads: i32,
    /// KV 캐시 형식 f16 | q8_0 | q4_0 (q8_0: 메모리 절반, 품질 차이 거의 없음)
    #[arg(long, env = "ENGINE_KV_TYPE", default_value = "f16")]
    kv_type: String,
    /// Flash Attention auto | on | off
    #[arg(long, env = "ENGINE_FLASH", default_value = "auto")]
    flash: String,
    /// 비전 모델 GGUF (비우면 코딩 모델과 같은 폴더에서 *-VL-*.gguf + mmproj*.gguf 자동 탐색)
    #[arg(long, env = "ENGINE_VISION_MODEL")]
    vision_model: Option<String>,
    /// 비전 모델의 mmproj GGUF
    #[arg(long, env = "ENGINE_VISION_MMPROJ")]
    vision_mmproj: Option<String>,
    /// 비전 모델 컨텍스트 길이 (이미지 1장 + 분석 결과)
    #[arg(long, env = "ENGINE_VISION_CTX", default_value_t = 8192)]
    vision_ctx: u32,
    /// 비전 모델을 이 시간(초) 동안 쓰지 않으면 메모리에서 내림 (0 = 계속 유지)
    #[arg(long, env = "ENGINE_VISION_IDLE", default_value_t = 300)]
    vision_idle: u64,
    /// 이미지 생성 작업 프로세스 포트: 코딩 모델을 다시 올리기 전에 그 프로세스를 끈다 (큰 모델은 한 번에 하나)
    #[arg(long, env = "IMAGEGEN_PORT", default_value_t = 18093)]
    imagegen_port: u16,
    /// 이미지 파일 하나를 분석하고 종료 (동작 확인용)
    #[arg(long)]
    image: Option<String>,
    /// 서버를 띄우지 않고 프롬프트 한 번만 실행 (동작 확인용)
    #[arg(long)]
    prompt: Option<String>,
}

enum Event {
    Token(String),
    Done(Result<GenerateResponse, String>),
    /// /vision, /health 처럼 JSON 하나로 끝나는 응답
    Json(Result<serde_json::Value, String>),
}

enum Work {
    Generate(GenerateRequest),
    Vision(VisionRequest),
    /// 비전 모델을 메모리에서 내림 (첨부 분석이 끝난 뒤 코딩 모델 속도를 지키기 위해).
    /// 값: 최근 이 초 안에 쓰였으면 내리지 않음 (0 = 바로 내림) — 예약 해제와 새 분석이 엇갈리는 것 방지
    VisionUnload(u64),
    /// 코딩 모델과 비전 모델을 모두 내림 (이미지 생성 동안 메모리 확보). 다음 /generate 때 자동으로 다시 올림.
    Sleep,
}

type Job = (Work, mpsc::Sender<Event>);

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
            Event::Done(Err(e)) | Event::Json(Err(e)) => (serde_json::json!({ "done": true, "error": e }).to_string(), true),
            Event::Json(Ok(v)) => (v.to_string(), true),
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

/// 이미지 생성 프로세스에 종료 요청 (없으면 false). 메모리를 돌려받은 뒤 코딩 모델을 올리기 위해.
fn stop_imagegen(port: u16) -> bool {
    use std::io::Read;
    use std::net::TcpStream;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)) else { return false };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    let _ = s.write_all(b"POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    let mut buf = [0u8; 256];
    let _ = s.read(&mut buf);
    // 프로세스가 끝나 메모리가 돌아올 때까지 잠깐 기다린다
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(100)).is_err() {
            break;
        }
    }
    true
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
        n_ubatch: args.ubatch,
        n_gpu_layers: args.gpu_layers,
        n_threads: args.threads,
        kv_type: args.kv_type.clone(),
        flash: args.flash.clone(),
    };

    eprintln!("[engine] 모델 로딩: {}", cfg.model_path);
    let backend = engine::init_backend()?;
    let mut coder: Option<Coder> = Some(Coder::load(backend, &cfg)?);
    let info = coder.as_mut().unwrap().engine().info.clone();
    eprintln!("[engine] 로드 완료: {} ({:.1}B params, ctx {})", info.model_name, info.n_params as f64 / 1e9, info.n_ctx);

    if let (Some(prompt), None) = (args.prompt.clone(), args.image.as_ref()) {
        let req: GenerateRequest = serde_json::from_value(serde_json::json!({
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 256
        }))?;
        let res = coder.as_mut().unwrap().engine().generate(&req)?;
        println!("{}", res.text);
        eprintln!("[engine] {} tokens, {:.1} tok/s", res.completion_tokens, res.tokens_per_second);
        return Ok(());
    }

    // 비전 모델 (선택): 지정 경로 > 코딩 모델 폴더 자동 탐색. 실제 로드는 첫 /vision 요청 때.
    let vision_paths = match (&args.vision_model, &args.vision_mmproj) {
        (Some(m), Some(p)) => Some((std::path::PathBuf::from(m), std::path::PathBuf::from(p))),
        _ => std::path::Path::new(&cfg.model_path).parent().and_then(vision::discover),
    };
    let mut vis = vision_paths.map(|(m, p)| {
        eprintln!("[engine] 비전 모델 사용 가능 (첫 요청 때 로드): {} + {}", m.display(), p.display());
        Vision::new(m, p, args.vision_ctx, args.threads, args.gpu_layers, args.vision_idle)
    });
    if vis.is_none() {
        eprintln!("[engine] 비전 모델 없음 — /vision 비활성 (models/ 에 *-VL-*.gguf + mmproj*.gguf 를 두면 자동 사용)");
    }

    if let Some(path) = args.image {
        use base64::Engine as _;
        let v = vis.as_mut().ok_or_else(|| anyhow::anyhow!("비전 모델이 없습니다"))?;
        let req = VisionRequest {
            image: base64::engine::general_purpose::STANDARD.encode(std::fs::read(&path)?),
            prompt: args.prompt.clone().unwrap_or_default(),
            max_tokens: 1024,
            temperature: 0.1,
        };
        let res = v.describe(backend, &req)?;
        println!("{}", res.text);
        eprintln!("[engine] 이미지 {}x{} → {} 토큰 (인코딩 {:.1}s) + gen {} tokens ({:.1} tok/s)",
            res.image_width, res.image_height, res.prompt_tokens, res.prompt_seconds, res.completion_tokens, res.tokens_per_second);
        return Ok(());
    }

    let model_info = Arc::new(serde_json::to_value(&info)?);
    let coder_loaded = Arc::new(std::sync::atomic::AtomicBool::new(true));
    // 비전 모델 상태(로드 여부)는 추론 스레드가 갱신하고, /health 는 HTTP 스레드에서 바로 읽는다 (생성 중에도 즉시 응답)
    let vision_info = |v: &Option<Vision>| v.as_ref().map(|v| serde_json::to_value(v.info()).unwrap())
        .unwrap_or_else(|| serde_json::json!({ "available": false, "loaded": false }));
    let vision_state = Arc::new(std::sync::RwLock::new(vision_info(&vis)));
    let addr = format!("{}:{}", args.host, args.port);
    let server = Arc::new(Server::http(&addr).map_err(|e| anyhow::anyhow!("{addr} 바인드 실패: {e}"))?);
    eprintln!("[engine] listening on http://{addr}");

    let (job_tx, job_rx) = mpsc::channel::<Job>();

    for _ in 0..4 {
        let server = Arc::clone(&server);
        let job_tx = job_tx.clone();
        let model_info = Arc::clone(&model_info);
        let coder_loaded = Arc::clone(&coder_loaded);
        let vision_state = Arc::clone(&vision_state);
        thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let response = match (request.method(), request.url()) {
                    (Method::Get, "/health") => {
                        let vision = vision_state.read().map(|v| v.clone()).unwrap_or_default();
                        let loaded = coder_loaded.load(std::sync::atomic::Ordering::Relaxed);
                        json_response(200, serde_json::json!({ "status": "ok", "model": *model_info, "coder_loaded": loaded, "vision": vision }).to_string())
                    }
                    (Method::Post, "/sleep") => {
                        let (tx, rx) = mpsc::channel();
                        let _ = job_tx.send((Work::Sleep, tx));
                        match rx.recv() {
                            Ok(Event::Json(Ok(v))) => json_response(200, v.to_string()),
                            _ => json_response(500, error_body("응답 수신 실패")),
                        }
                    }
                    (Method::Post, "/vision/unload") => {
                        let mut body = String::new();
                        let _ = request.as_reader().read_to_string(&mut body);
                        let idle = serde_json::from_str::<serde_json::Value>(&body).ok()
                            .and_then(|v| v.get("if_idle_seconds").and_then(|x| x.as_u64())).unwrap_or(0);
                        let (tx, rx) = mpsc::channel();
                        let _ = job_tx.send((Work::VisionUnload(idle), tx));
                        match rx.recv() {
                            Ok(Event::Json(Ok(v))) => json_response(200, v.to_string()),
                            _ => json_response(500, error_body("응답 수신 실패")),
                        }
                    }
                    (Method::Post, "/vision") => {
                        let mut body = String::new();
                        if let Err(e) = request.as_reader().read_to_string(&mut body) {
                            json_response(400, error_body(&format!("본문 읽기 실패: {e}")))
                        } else {
                            match serde_json::from_str::<VisionRequest>(&body) {
                                Err(e) => json_response(400, error_body(&format!("잘못된 요청 JSON: {e}"))),
                                Ok(req) => {
                                    let (tx, rx) = mpsc::channel();
                                    if job_tx.send((Work::Vision(req), tx)).is_err() {
                                        json_response(503, error_body("추론 스레드가 종료되었습니다"))
                                    } else {
                                        match rx.recv() {
                                            Ok(Event::Json(Ok(v))) => json_response(200, v.to_string()),
                                            Ok(Event::Json(Err(msg))) => json_response(422, error_body(&msg)),
                                            _ => json_response(500, error_body("분석 결과 수신 실패")),
                                        }
                                    }
                                }
                            }
                        }
                    }
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
                                    if job_tx.send((Work::Generate(req), tx)).is_err() {
                                        json_response(503, error_body("추론 스레드가 종료되었습니다"))
                                    } else if streaming {
                                        stream_events(request, rx);
                                        continue;
                                    } else {
                                        let done = rx.iter().find_map(|ev| match ev {
                                            Event::Done(r) => Some(r),
                                            _ => None,
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

    // 메인 스레드 = 추론 스레드. 일이 없을 때는 30초마다 깨어나 오래 안 쓴 비전 모델을 내린다.
    loop {
        let (work, reply) = match job_rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if vis.as_mut().map(|v| v.maybe_unload()).unwrap_or(false) {
                    eprintln!("[engine] 비전 모델을 메모리에서 내렸습니다 (오래 사용하지 않음)");
                    if let Ok(mut w) = vision_state.write() { *w = vision_info(&vis); }
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match work {
            Work::VisionUnload(idle) => {
                let unloaded = vis.as_mut().map(|v| v.unload_if_idle(idle)).unwrap_or(false);
                if unloaded {
                    eprintln!("[engine] 비전 모델을 메모리에서 내렸습니다 (요청)");
                    if let Ok(mut w) = vision_state.write() { *w = vision_info(&vis); }
                }
                let _ = reply.send(Event::Json(Ok(serde_json::json!({ "unloaded": unloaded }))));
            }
            Work::Vision(req) => {
                let res = match vis.as_mut() {
                    None => Err("비전 모델이 없습니다. models/ 에 Qwen2.5-VL GGUF 와 mmproj 를 받아 두세요".to_string()),
                    Some(v) => v.describe(backend, &req).map_err(|e| format!("{e:#}")),
                };
                if let Ok(r) = &res {
                    eprintln!(
                        "[engine] vision {}x{} → {} 토큰 ({:.1}s{}) + gen {} tokens ({:.1} tok/s)",
                        r.image_width, r.image_height, r.prompt_tokens, r.prompt_seconds,
                        if r.loaded_now { ", 모델 로드 포함" } else { "" }, r.completion_tokens, r.tokens_per_second
                    );
                }
                if let Ok(mut w) = vision_state.write() { *w = vision_info(&vis); }
                let _ = reply.send(Event::Json(res.map(|r| serde_json::to_value(r).unwrap())));
            }
            Work::Sleep => {
                let had = coder.take().is_some();
                let vis_had = vis.as_mut().map(|v| v.unload()).unwrap_or(false);
                coder_loaded.store(false, std::sync::atomic::Ordering::Relaxed);
                if let Ok(mut w) = vision_state.write() { *w = vision_info(&vis); }
                eprintln!("[engine] 잠자기: 코딩 모델{} 내림 (이미지 생성 등 큰 작업용 메모리 확보)", if vis_had { "·비전 모델" } else { "" });
                let _ = reply.send(Event::Json(Ok(serde_json::json!({ "slept": had }))));
            }
            Work::Generate(req) => {
                // 코딩에 집중: 비전 모델(~6GB)이 같이 있으면 스왑으로 코딩이 느려진다 → 코드 생성이 오면 내린다
                if vis.as_mut().map(|v| v.unload_if_idle(5)).unwrap_or(false) {
                    eprintln!("[engine] 코딩 요청 → 비전 모델을 내렸습니다");
                    if let Ok(mut w) = vision_state.write() { *w = vision_info(&vis); }
                }
                if coder.is_none() {
                    // 큰 모델은 한 번에 하나: 이미지 생성 프로세스를 먼저 끄고 코딩 모델을 다시 올린다
                    let stopped = stop_imagegen(args.imagegen_port);
                    let t = std::time::Instant::now();
                    match Coder::load(backend, &cfg) {
                        Ok(c) => {
                            coder = Some(c);
                            coder_loaded.store(true, std::sync::atomic::Ordering::Relaxed);
                            eprintln!("[engine] 코딩 모델 다시 올림 {:.1}s{}", t.elapsed().as_secs_f64(), if stopped { " (이미지 생성 프로세스 종료 후)" } else { "" });
                        }
                        Err(e) => {
                            let _ = reply.send(Event::Done(Err(format!("코딩 모델을 다시 올리지 못했습니다: {e:#}"))));
                            continue;
                        }
                    }
                }
                let eng = coder.as_mut().unwrap().engine();
                let streaming = req.stream;
                let res = eng
                    .generate_with(&req, &mut |t| !streaming || reply.send(Event::Token(t.to_string())).is_ok())
                    .map_err(|e| format!("{e:#}"));
                if let Ok(r) = &res {
                    eprintln!(
                        "[engine] prompt {} (재사용 {}, 새로 계산 {} · {:.1}s) + gen {} tokens ({:.1} tok/s, {})",
                        r.prompt_tokens, r.cached_tokens, r.prompt_tokens - r.cached_tokens, r.prompt_seconds,
                        r.completion_tokens, r.tokens_per_second, r.finish_reason
                    );
                }
                let _ = reply.send(Event::Done(res));
            }
        }
    }
    Ok(())
}
