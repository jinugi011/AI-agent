//! llama.cpp(Metal) 추론 코어. 모델과 컨텍스트는 이 모듈을 소유한 단일 스레드에서만 사용한다.

use std::num::NonZeroU32;
use std::path::Path;
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenerateRequest {
    pub messages: Vec<ChatMessage>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_top_p")]
    pub top_p: f32,
    /// GBNF 문법. 지정하면 출력이 문법을 따르도록 강제된다 (예: JSON).
    #[serde(default)]
    pub grammar: Option<String>,
    #[serde(default)]
    pub stop: Vec<String>,
    #[serde(default)]
    pub seed: Option<u32>,
    /// true 면 토큰 단위 NDJSON 스트리밍 응답
    #[serde(default)]
    pub stream: bool,
}

fn default_max_tokens() -> usize {
    2048
}
fn default_temperature() -> f32 {
    0.2
}
fn default_top_p() -> f32 {
    0.9
}

#[derive(Debug, Clone, Serialize)]
pub struct GenerateResponse {
    pub text: String,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub finish_reason: String,
    pub tokens_per_second: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub model_path: String,
    pub model_name: String,
    pub n_ctx: u32,
    pub n_params: u64,
    pub size_bytes: u64,
}

pub struct EngineConfig {
    pub model_path: String,
    pub n_ctx: u32,
    pub n_batch: u32,
    pub n_gpu_layers: u32,
    pub n_threads: i32,
}

pub struct Engine<'m> {
    model: &'m LlamaModel,
    ctx: LlamaContext<'m>,
    n_batch: usize,
    pub info: ModelInfo,
}

/// 백엔드와 모델을 소유값으로 반환한다. 호출자는 Engine(컨텍스트) → 모델 → 백엔드 순으로 해제해야 한다
/// (역순으로 해제하면 Metal 디바이스 정리 시 assert 로 종료된다).
pub fn load_model(cfg: &EngineConfig) -> Result<(LlamaBackend, LlamaModel)> {
    let mut backend = LlamaBackend::init().context("llama backend init 실패")?;
    if std::env::var("ENGINE_VERBOSE").is_err() {
        backend.void_logs();
    }

    let path = Path::new(&cfg.model_path);
    if !path.exists() {
        bail!("모델 파일을 찾을 수 없습니다: {}", cfg.model_path);
    }
    let params = LlamaModelParams::default().with_n_gpu_layers(cfg.n_gpu_layers);
    let model = LlamaModel::load_from_file(&backend, path, &params)
        .map_err(|e| anyhow!("모델 로드 실패: {e}"))?;
    Ok((backend, model))
}

impl<'m> Engine<'m> {
    pub fn new(backend: &'m LlamaBackend, model: &'m LlamaModel, cfg: &EngineConfig) -> Result<Self> {
        let n_ctx = cfg.n_ctx.min(model.n_ctx_train()).max(512);
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(cfg.n_batch)
            .with_n_threads(cfg.n_threads)
            .with_n_threads_batch(cfg.n_threads);
        let ctx = model
            .new_context(backend, ctx_params)
            .map_err(|e| anyhow!("컨텍스트 생성 실패: {e}"))?;

        let model_name = model
            .meta_val_str("general.name")
            .unwrap_or_else(|_| Path::new(&cfg.model_path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
        let info = ModelInfo {
            model_path: cfg.model_path.clone(),
            model_name,
            n_ctx: ctx.n_ctx(),
            n_params: model.n_params(),
            size_bytes: model.size(),
        };
        Ok(Self { model, ctx, n_batch: cfg.n_batch as usize, info })
    }

    fn render_prompt(&self, messages: &[ChatMessage]) -> Result<String> {
        let chat = messages
            .iter()
            .map(|m| LlamaChatMessage::new(m.role.clone(), m.content.clone()))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| anyhow!("메시지에 NUL 문자가 포함되어 있습니다: {e}"))?;
        // GGUF 내장 템플릿을 우선 사용하고, 없으면 ChatML(Qwen 계열 표준)로 대체한다.
        if let Ok(tmpl) = self.model.chat_template(None) {
            if let Ok(prompt) = self.model.apply_chat_template(&tmpl, &chat, true) {
                return Ok(prompt);
            }
        }
        let mut prompt = String::new();
        for m in messages {
            prompt.push_str(&format!("<|im_start|>{}\n{}<|im_end|>\n", m.role, m.content));
        }
        prompt.push_str("<|im_start|>assistant\n");
        Ok(prompt)
    }

    fn build_sampler(&self, req: &GenerateRequest) -> Result<LlamaSampler> {
        let mut chain = Vec::new();
        if let Some(g) = req.grammar.as_deref().filter(|g| !g.trim().is_empty()) {
            chain.push(LlamaSampler::grammar(self.model, g, "root").map_err(|e| anyhow!("문법(GBNF) 오류: {e}"))?);
        }
        if req.temperature <= 0.0 {
            chain.push(LlamaSampler::greedy());
        } else {
            chain.push(LlamaSampler::top_k(40));
            chain.push(LlamaSampler::top_p(req.top_p, 1));
            chain.push(LlamaSampler::min_p(0.05, 1));
            chain.push(LlamaSampler::temp(req.temperature));
            chain.push(LlamaSampler::dist(req.seed.unwrap_or(0xFFFF_FFFF)));
        }
        Ok(LlamaSampler::chain_simple(chain))
    }

    pub fn generate(&mut self, req: &GenerateRequest) -> Result<GenerateResponse> {
        self.generate_with(req, &mut |_| true)
    }

    /// on_text: 완결된 UTF-8 조각마다 호출. false 를 반환하면(클라이언트 끊김 등) 생성을 중단한다.
    pub fn generate_with(&mut self, req: &GenerateRequest, on_text: &mut dyn FnMut(&str) -> bool) -> Result<GenerateResponse> {
        if req.messages.is_empty() {
            bail!("messages 가 비어 있습니다");
        }
        let prompt = self.render_prompt(&req.messages)?;
        let vocab = self.model.vocab();
        let tokens = vocab.tokenize(prompt.as_bytes(), vocab.should_add_bos(), true);
        let n_ctx = self.ctx.n_ctx() as usize;
        if tokens.len() + 16 >= n_ctx {
            bail!("프롬프트가 너무 깁니다: {} 토큰 (컨텍스트 {n_ctx})", tokens.len());
        }
        let max_new = req.max_tokens.min(n_ctx - tokens.len() - 1);

        self.ctx.clear_kv_cache();
        let mut sampler = self.build_sampler(req)?;
        let mut batch = LlamaBatch::new(self.n_batch.max(1), 1);

        // 프롬프트 프리필: n_batch 단위로 나눠서 디코딩, 마지막 토큰에서만 logits 계산
        let last = tokens.len() - 1;
        for (chunk_idx, chunk) in tokens.chunks(self.n_batch.max(1)).enumerate() {
            batch.clear();
            for (i, tok) in chunk.iter().enumerate() {
                let pos = chunk_idx * self.n_batch + i;
                batch.add(*tok, pos as i32, &[0], pos == last)?;
            }
            self.ctx.decode(&mut batch).map_err(|e| anyhow!("프롬프트 디코딩 실패: {e}"))?;
        }

        let started = Instant::now();
        let mut out_bytes: Vec<u8> = Vec::new();
        let mut n_past = tokens.len();
        let mut produced = 0usize;
        let mut finish_reason = "length".to_string();
        let mut emitted = 0usize; // on_text 로 이미 내보낸 바이트 수

        while produced < max_new {
            let token = sampler.sample(&self.ctx, batch.n_tokens() - 1);
            if vocab.is_eog(token) {
                finish_reason = "stop".into();
                break;
            }
            out_bytes.extend(vocab.token_to_piece(token, false, None));
            produced += 1;

            // 한글 등 멀티바이트 문자가 토큰 경계에서 잘릴 수 있으므로 완결된 부분만 내보낸다
            let pending = &out_bytes[emitted..];
            let valid = match std::str::from_utf8(pending) {
                Ok(s) => s.len(),
                Err(e) => e.valid_up_to(),
            };
            if valid > 0 {
                let chunk = std::str::from_utf8(&pending[..valid]).unwrap_or_default();
                emitted += valid;
                if !on_text(chunk) {
                    finish_reason = "cancelled".into();
                    break;
                }
            }

            if !req.stop.is_empty() {
                let text = String::from_utf8_lossy(&out_bytes);
                if let Some(cut) = req.stop.iter().filter_map(|s| text.find(s.as_str())).min() {
                    out_bytes.truncate(cut);
                    finish_reason = "stop".into();
                    break;
                }
            }

            batch.clear();
            batch.add(token, n_past as i32, &[0], true)?;
            n_past += 1;
            self.ctx.decode(&mut batch).map_err(|e| anyhow!("토큰 디코딩 실패: {e}"))?;
        }

        let secs = started.elapsed().as_secs_f64().max(1e-6);
        Ok(GenerateResponse {
            // 멀티바이트(한글) 경계가 잘린 경우에도 안전하게 문자열화
            text: String::from_utf8_lossy(&out_bytes).into_owned(),
            prompt_tokens: tokens.len(),
            completion_tokens: produced,
            finish_reason,
            tokens_per_second: produced as f64 / secs,
        })
    }
}
