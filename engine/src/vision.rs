//! 비전(이미지 이해) 모델: Qwen2.5-VL 같은 GGUF + mmproj 를 llama.cpp mtmd 로 구동한다.
//!
//! 코딩 모델은 글만 읽으므로, 업로드된 이미지(화면 캡처·디자인 시안·다이어그램·PDF 스캔 페이지)는
//! 이 모델이 "개발자가 구현할 수 있을 만큼 자세한 글"로 풀어 주고, 코딩 모델이 그 글을 보고 코드를 쓴다.
//!
//! 메모리 절약: 첫 요청 때 로드하고, 일정 시간(idle) 쓰지 않으면 내린다.
//! 모든 호출은 엔진의 단일 추론 스레드에서만 이루어진다.

use std::ffi::CString;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::mtmd::{mtmd_default_marker, MtmdBitmap, MtmdContext, MtmdContextParams, MtmdInputText};
use llama_cpp_2::sampling::LlamaSampler;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct VisionRequest {
    /// 이미지 파일 바이트 (PNG/JPEG/WebP/GIF 등) — base64
    pub image: String,
    /// 이미지에 대해 무엇을 할지 (비우면 기본: 개발자용 상세 분석)
    #[serde(default)]
    pub prompt: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_max_tokens() -> usize {
    2048
}
fn default_temperature() -> f32 {
    0.1
}

#[derive(Debug, Clone, Serialize)]
pub struct VisionResponse {
    pub text: String,
    pub model_name: String,
    pub image_width: u32,
    pub image_height: u32,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub finish_reason: String,
    /// 이미지 인코딩 + 프롬프트 처리 시간 (초)
    pub prompt_seconds: f64,
    pub tokens_per_second: f64,
    /// 이번 요청에서 모델을 새로 로드했는지 (로드 시간 포함 여부 판단용)
    pub loaded_now: bool,
    /// 직전 요청과 같은 이미지라 인코딩을 재사용했는지
    pub image_cached: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VisionInfo {
    pub available: bool,
    pub loaded: bool,
    pub model_path: String,
    pub mmproj_path: String,
    pub n_ctx: u32,
    pub idle_unload_seconds: u64,
}

pub const DEFAULT_PROMPT: &str = "이 이미지를 개발자가 그대로 코드로 구현할 수 있도록 한국어로 자세히 분석해 주세요. 이미지에 해당하는 항목만 쓰고, 해당하지 않는 항목은 아예 쓰지 마세요.\n\
\n\
## 종류\n\
UI 화면 / 디자인 시안 / 다이어그램(아키텍처·ERD·흐름도) / 코드·터미널·오류 화면 / 문서·표 중 하나.\n\
\n\
## 글자\n\
이미지 안의 모든 글자를 위치 순서대로 빠짐없이 그대로 옮겨 적기. 코드·오류 메시지는 코드 블록으로.\n\
\n\
## 구조 (UI·시안일 때)\n\
위에서 아래로 영역(헤더·사이드바·본문·카드·푸터)을 나누고, 영역마다 들어 있는 구성요소(버튼·입력창·링크·표·아이콘·이미지)를 나열.\n\
각 구성요소마다: 글자, 위치(왼쪽/가운데/오른쪽), 대략 크기, 정렬, 다른 요소와의 간격.\n\
\n\
## 색상과 모양 (UI·시안일 때)\n\
배경색, 헤더 색, 카드 색, 버튼 색, 글자 색, 링크 색, 테두리 색을 각각 #hex 로 추정. 모서리 둥글기, 그림자, 글자 크기·굵기.\n\
\n\
## 연결 (다이어그램일 때)\n\
모든 노드와 연결(화살표 방향, 라벨), 계층 구조.\n\
\n\
## 오류 (오류 화면일 때)\n\
오류 메시지 전문과 원인으로 보이는 부분.\n\
\n\
추측한 값은 '(추정)'이라고 표시하세요.";

/// mmproj 가 같은 폴더에 있는 비전 모델을 찾는다 (--vision-model 을 주지 않았을 때).
/// 규칙: 파일명에 "VL" 또는 "vision" 이 들어간 GGUF(mmproj 제외) + 같은 폴더의 mmproj*.gguf
pub fn discover(models_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let entries: Vec<PathBuf> = std::fs::read_dir(models_dir).ok()?.filter_map(|e| e.ok().map(|e| e.path())).collect();
    let is_gguf = |p: &PathBuf| p.extension().map(|e| e.eq_ignore_ascii_case("gguf")).unwrap_or(false);
    let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut models: Vec<&PathBuf> = entries
        .iter()
        .filter(|p| is_gguf(p) && !name(p).starts_with("mmproj") && (name(p).contains("-vl-") || name(p).contains("vision")))
        .collect();
    models.sort();
    for m in models {
        let stem = name(m).trim_end_matches(".gguf").to_string();
        // 같은 계열 이름의 mmproj 우선 (예: Qwen2.5-VL-7B-Instruct-Q4_K_M ↔ mmproj-Qwen2.5-VL-7B-Instruct-Q8_0)
        let base = stem.rsplit_once('-').map(|(b, _)| b.to_string()).unwrap_or(stem.clone());
        let mut projs: Vec<&PathBuf> = entries.iter().filter(|p| is_gguf(p) && name(p).starts_with("mmproj")).collect();
        projs.sort_by_key(|p| if name(p).contains(&base) { 0 } else { 1 });
        if let Some(p) = projs.first() {
            return Some((m.clone(), (*p).clone()));
        }
    }
    None
}

/// 로드된 비전 모델. 필드 해제 순서가 중요하다: mtmd → ctx → model (Drop 에서 명시적으로 처리).
struct Loaded {
    mtmd: Option<MtmdContext>,
    ctx: Option<LlamaContext<'static>>,
    model: Option<Box<LlamaModel>>,
    name: String,
    /// 마지막으로 인코딩한 이미지: (이미지 해시, 이미지까지의 KV 위치, 가로, 세로, 이미지 토큰 수).
    /// 같은 이미지에 대한 다음 질문(종류 판별 → 본 분석)은 이미지 인코딩을 건너뛴다.
    image_cache: Option<(u64, i32, u32, u32, usize)>,
}

impl Drop for Loaded {
    fn drop(&mut self) {
        self.mtmd.take();
        self.ctx.take();
        self.model.take();
    }
}

pub struct Vision {
    model_path: PathBuf,
    mmproj_path: PathBuf,
    n_ctx: u32,
    n_batch: u32,
    n_threads: i32,
    gpu_layers: u32,
    pub idle_unload_seconds: u64,
    loaded: Option<Loaded>,
    last_used: Instant,
}

impl Vision {
    pub fn new(model_path: PathBuf, mmproj_path: PathBuf, n_ctx: u32, n_threads: i32, gpu_layers: u32, idle_unload_seconds: u64) -> Self {
        Self {
            model_path,
            mmproj_path,
            n_ctx,
            n_batch: 2048,
            n_threads,
            gpu_layers,
            idle_unload_seconds,
            loaded: None,
            last_used: Instant::now(),
        }
    }

    pub fn info(&self) -> VisionInfo {
        VisionInfo {
            available: true,
            loaded: self.loaded.is_some(),
            model_path: self.model_path.display().to_string(),
            mmproj_path: self.mmproj_path.display().to_string(),
            n_ctx: self.n_ctx,
            idle_unload_seconds: self.idle_unload_seconds,
        }
    }

    /// 지금 메모리에서 내린다. 내렸으면 true.
    pub fn unload(&mut self) -> bool {
        self.loaded.take().is_some()
    }

    /// 최근 idle 초 안에 쓰였으면 그대로 둔다 (0 이면 바로 내림)
    pub fn unload_if_idle(&mut self, idle: u64) -> bool {
        if idle > 0 && self.last_used.elapsed().as_secs() < idle {
            return false;
        }
        self.unload()
    }

    /// 오래 쓰지 않았으면 메모리에서 내린다. 내렸으면 true.
    pub fn maybe_unload(&mut self) -> bool {
        if self.loaded.is_some() && self.idle_unload_seconds > 0 && self.last_used.elapsed().as_secs() >= self.idle_unload_seconds {
            self.loaded = None;
            return true;
        }
        false
    }

    fn ensure_loaded(&mut self, backend: &LlamaBackend) -> Result<bool> {
        if self.loaded.is_some() {
            return Ok(false);
        }
        for p in [&self.model_path, &self.mmproj_path] {
            if !p.exists() {
                bail!("비전 모델 파일이 없습니다: {}", p.display());
            }
        }
        let params = LlamaModelParams::default().with_n_gpu_layers(self.gpu_layers);
        let model = Box::new(
            LlamaModel::load_from_file(backend, &self.model_path, &params).map_err(|e| anyhow!("비전 모델 로드 실패: {e}"))?,
        );
        // SAFETY: model 은 Box 안에 있어 주소가 고정되고, Loaded::drop 에서 ctx·mtmd 를 먼저 해제한 뒤 model 을 해제한다.
        let model_ref: &'static LlamaModel = unsafe { &*(model.as_ref() as *const LlamaModel) };
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(self.n_ctx))
            .with_n_batch(self.n_batch)
            .with_n_ubatch(512)
            .with_n_threads(self.n_threads)
            .with_n_threads_batch(self.n_threads);
        let ctx = model_ref.new_context(backend, ctx_params).map_err(|e| anyhow!("비전 컨텍스트 생성 실패: {e}"))?;
        let mparams = MtmdContextParams {
            use_gpu: true,
            print_timings: false,
            n_threads: self.n_threads,
            media_marker: CString::new(mtmd_default_marker()).unwrap(),
            image_min_tokens: -1,
            image_max_tokens: -1,
        };
        let mtmd = MtmdContext::init_from_file(&self.mmproj_path.to_string_lossy(), model_ref, &mparams)
            .map_err(|e| anyhow!("mmproj 로드 실패 ({}): {e}", self.mmproj_path.display()))?;
        if !mtmd.support_vision() {
            bail!("이 mmproj 는 이미지를 지원하지 않습니다: {}", self.mmproj_path.display());
        }
        let name = model_ref
            .meta_val_str("general.name")
            .unwrap_or_else(|_| self.model_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
        self.loaded = Some(Loaded { mtmd: Some(mtmd), ctx: Some(ctx), model: Some(model), name, image_cache: None });
        Ok(true)
    }

    pub fn describe(&mut self, backend: &LlamaBackend, req: &VisionRequest) -> Result<VisionResponse> {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(req.image.trim())
            .context("image 는 base64 로 인코딩된 이미지여야 합니다")?;
        if bytes.is_empty() {
            bail!("이미지가 비어 있습니다");
        }
        let loaded_now = self.ensure_loaded(backend)?;
        self.last_used = Instant::now();
        let n_batch = self.n_batch as i32;
        let l = self.loaded.as_mut().unwrap();
        let model: &LlamaModel = l.model.as_ref().unwrap();
        let ctx = l.ctx.as_mut().unwrap();
        let mtmd = l.mtmd.as_mut().unwrap();

        let instruction = if req.prompt.trim().is_empty() { DEFAULT_PROMPT } else { req.prompt.trim() };
        let marker = mtmd_default_marker();
        let user = format!("{marker}\n{instruction}");
        let chat = vec![LlamaChatMessage::new("user".into(), user.clone()).map_err(|e| anyhow!("{e}"))?];
        let prompt = model
            .chat_template(None)
            .ok()
            .and_then(|t| model.apply_chat_template(&t, &chat, true).ok())
            .unwrap_or_else(|| format!("<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"));
        // 프롬프트를 [이미지까지] + [지시문 이후] 로 나눈다. 앞부분은 같은 이미지면 KV 를 재사용한다.
        let cut = prompt.find(marker).map(|i| i + marker.len()).ok_or_else(|| anyhow!("프롬프트에 이미지 자리가 없습니다"))?;
        let (head, tail) = prompt.split_at(cut);
        let key = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            head.hash(&mut h);
            h.finish()
        };
        let n_ctx = ctx.n_ctx() as usize;
        let started = Instant::now();
        let reuse = l.image_cache.filter(|c| c.0 == key)
            .filter(|c| ctx.clear_kv_cache_seq(Some(0), Some(c.1 as u32), None).unwrap_or(false));
        let (n_img, w, h, img_tokens) = match reuse {
            Some((_, n, w, h, t)) => (n, w, h, t),
            None => {
                l.image_cache = None;
                ctx.clear_kv_cache();
                let bitmap = MtmdBitmap::from_buffer(mtmd, &bytes, false).map_err(|e| anyhow!("이미지를 읽을 수 없습니다 (PNG/JPEG/WebP 등): {e}"))?;
                let (w, h) = (bitmap.nx(), bitmap.ny());
                let chunks = mtmd
                    .tokenize(MtmdInputText { text: head.to_string(), add_special: true, parse_special: true }, &[&bitmap])
                    .map_err(|e| anyhow!("이미지 토큰화 실패: {e}"))?;
                let t = chunks.total_positions() as usize;
                if t + 256 >= n_ctx {
                    bail!("이미지가 너무 큽니다 ({t} 토큰, 비전 컨텍스트 {n_ctx}). 더 작은 이미지를 사용하세요");
                }
                let n = chunks.eval_chunks(mtmd, ctx, 0, 0, n_batch, false).map_err(|e| anyhow!("이미지 인코딩 실패: {e}"))?;
                l.image_cache = Some((key, n, w, h, t));
                (n, w, h, t)
            }
        };
        let image_cached = reuse.is_some();
        // 지시문 부분은 일반 텍스트 토큰으로 이어서 디코딩 (마지막 토큰에서만 logits)
        let vocab = model.vocab();
        let tail_tokens = vocab.tokenize(tail.as_bytes(), false, true);
        if tail_tokens.is_empty() || n_img as usize + tail_tokens.len() + 64 >= n_ctx {
            bail!("지시문이 너무 깁니다");
        }
        let mut batch = LlamaBatch::new(n_batch.max(1) as usize, 1);
        let last = tail_tokens.len() - 1;
        for (ci, chunk) in tail_tokens.chunks(n_batch.max(1) as usize).enumerate() {
            batch.clear();
            for (i, tok) in chunk.iter().enumerate() {
                let idx = ci * n_batch as usize + i;
                batch.add(*tok, n_img + idx as i32, &[0], idx == last)?;
            }
            ctx.decode(&mut batch).map_err(|e| anyhow!("지시문 디코딩 실패: {e}"))?;
        }
        let n_past = n_img + tail_tokens.len() as i32;
        let n_prompt = img_tokens + tail_tokens.len();
        let prompt_seconds = started.elapsed().as_secs_f64();

        // 같은 문장을 반복하는 것을 막기 위해 반복 패널티를 항상 넣는다
        let penalties = LlamaSampler::penalties(model.n_vocab(), 256, 1.05, 0.0, 0.0);
        let mut sampler = if req.temperature <= 0.0 {
            LlamaSampler::chain_simple([penalties, LlamaSampler::greedy()])
        } else {
            LlamaSampler::chain_simple([
                penalties,
                LlamaSampler::top_k(40),
                LlamaSampler::top_p(0.9, 1),
                LlamaSampler::temp(req.temperature),
                LlamaSampler::dist(0xFFFF_FFFF),
            ])
        };
        let max_new = req.max_tokens.min(n_ctx - n_past as usize - 1);
        let mut out: Vec<u8> = Vec::new();
        let mut produced = 0usize;
        let mut n_cur = n_past;
        let mut finish_reason = "length".to_string();
        let gen_started = Instant::now();
        let mut logits_idx: i32 = batch.n_tokens() - 1; // 지시문 마지막 토큰 위치
        while produced < max_new {
            let token = sampler.sample(ctx, logits_idx);
            if vocab.is_eog(token) {
                finish_reason = "stop".into();
                break;
            }
            out.extend(vocab.token_to_piece(token, false, None));
            produced += 1;
            batch.clear();
            batch.add(token, n_cur, &[0], true)?;
            n_cur += 1;
            ctx.decode(&mut batch).map_err(|e| anyhow!("토큰 디코딩 실패: {e}"))?;
            logits_idx = 0;
        }
        self.last_used = Instant::now();
        let secs = gen_started.elapsed().as_secs_f64().max(1e-6);
        Ok(VisionResponse {
            text: String::from_utf8_lossy(&out).trim().to_string(),
            model_name: l.name.clone(),
            image_width: w,
            image_height: h,
            prompt_tokens: n_prompt,
            completion_tokens: produced,
            finish_reason,
            prompt_seconds,
            tokens_per_second: produced as f64 / secs,
            loaded_now,
            image_cached,
        })
    }
}
