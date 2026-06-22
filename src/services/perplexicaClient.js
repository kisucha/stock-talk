// perplexicaClient.js
// 목적: Perplexica (80서버 :3001) 신규 빌드 API 클라이언트.
//       Perplexica의 "검색 + 본문 fetch" 단계만 활용 → sources를 우리 LLM 컨텍스트로 주입.
//       Perplexica 자체 LLM 답변은 무시 (우리 LLM이 박스권/holdings/모드 결합해 최종 답변).
//
// 신규 SSE 스키마 (실측 캡처):
//   NDJSON 형식 (data: prefix 없음, 각 라인이 JSON 객체).
//   라인 1: { type: "block",       block: { id, type: "research", data: { subSteps: [] } } }
//   라인 N: { type: "updateBlock", blockId, patch: [{op:"replace", path:"/data/subSteps", value:[...]}] }
//
//   subSteps 종류:
//     - { type: "searching",      searching: [질문1, 질문2, ...] }
//     - { type: "search_results", reading:   [{ content, metadata: { title, url } }, ...] }
//     - 이후 answer/sources/citations block 추가 가능 (LLM 답변 — 무시함)
//
// 필수 헤더:
//   - Origin:  http://192.168.20.80:3001
//   - Referer: http://192.168.20.80:3001/c/{chatId}
//   - 미설정 시 응답 즉시 종료(112 bytes만) — 권한/CORS 검증 추정.
//
// 환경 변수:
//   PERPLEXICA_URL         — 기본 http://192.168.20.80:3001
//   PERPLEXICA_CHAT_MODEL  — Perplexica가 내부적으로 쓸 모델 (search_results만 받아도 일부 호출).
//                            기본 gemma4:12b
//   PERPLEXICA_EMBED_MODEL — 기본 bge-m3:latest

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

let _ollamaProviderId = null;

function _lib(p)  { return p.protocol === 'https:' ? https : http; }
function _port(p) { return p.port || (p.protocol === 'https:' ? 443 : 80); }

function _httpRequest(method, baseUrl, path, body, timeoutMs) {
  const parsed  = new URL(baseUrl);
  const lib     = _lib(parsed);
  const port    = _port(parsed);
  const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve) => {
    const req = lib.request({
      hostname: parsed.hostname, port, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (stock-talk/1.0)'
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function _getOllamaProviderId(baseUrl) {
  if (_ollamaProviderId) return _ollamaProviderId;
  const res = await _httpRequest('GET', baseUrl, '/api/config', null, 8000);
  if (res.status !== 200) return null;
  try {
    const j = JSON.parse(res.body);
    const providers = (j.values && j.values.modelProviders) || [];
    const ollama = providers.find(p => (p.type || '').toLowerCase() === 'ollama'
                                    || (p.name || '').toLowerCase() === 'ollama');
    if (ollama && ollama.id) {
      _ollamaProviderId = ollama.id;
      console.log(`[perplexica] Ollama providerId 캐시: ${ollama.id}`);
      return ollama.id;
    }
  } catch (e) { console.warn('[perplexica] config 파싱 실패:', e.message); }
  return null;
}

// block patch 누적 — JSON Patch op="replace" path="/data/subSteps" 만 처리 (Perplexica가 매번 전체 배열을 교체 송신).
function _applyPatch(blocks, evt) {
  if (evt.type === 'block' && evt.block) {
    blocks.set(evt.block.id, evt.block);
  } else if (evt.type === 'updateBlock' && evt.blockId && Array.isArray(evt.patch)) {
    const b = blocks.get(evt.blockId);
    if (!b) return;
    for (const p of evt.patch) {
      if (p.op === 'replace' && p.path === '/data/subSteps') {
        b.data = b.data || {};
        b.data.subSteps = p.value;
      }
      // 다른 path/op은 무시 — search_results 추출에만 관심.
    }
  }
}

function _extractSources(blocks) {
  const out = [];
  for (const b of blocks.values()) {
    const subs = (b.data && b.data.subSteps) || [];
    for (const s of subs) {
      if (s.type === 'search_results' && Array.isArray(s.reading)) {
        for (const r of s.reading) {
          out.push({
            title:   (r.metadata && r.metadata.title) || r.title || '',
            url:     (r.metadata && r.metadata.url)   || r.url   || '',
            content: r.content || r.pageContent || ''
          });
        }
      }
    }
  }
  return out;
}

/**
 * Perplexica /api/chat 호출 → search_results 추출 → { sources } 반환.
 * Perplexica 자체 LLM 답변(answer)은 무시 — 우리 LLM이 박스권 컨텍스트와 결합해 최종 답변 생성.
 *
 * @param {string} query
 * @param {object} opts
 *   - optimizationMode: 'speed' | 'balanced' | 'quality'  (기본 'speed')
 *   - timeoutMs: 기본 90_000 (search_results 도착 후 즉시 close)
 *   - earlyClose: 기본 true — search_results subStep 발견하는 순간 connection close
 * @returns {Promise<{success, answer?, sources?, error?}>}
 *   answer는 항상 '' — 우리 LLM이 답변 생성. sources는 검색결과 [{title,url,content}, ...]
 */
async function searchPerplexica(query, opts = {}) {
  const baseUrl = process.env.PERPLEXICA_URL || 'http://192.168.20.80:3001';
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch (e) { return { success: false, error: `PERPLEXICA_URL 파싱 실패: ${e.message}` }; }

  const providerId = await _getOllamaProviderId(baseUrl);
  if (!providerId) return { success: false, error: 'Perplexica Ollama provider 미설정 (/api/config)' };

  // chatId 생성 + 페이지 사전 GET — UI는 /c/{chatId} 진입 시 SSR로 세션 초기화함.
  // API 직접 호출 시 이 단계 생략하면 일부 query에서 backend hang 가능. 사전 GET으로 세션 준비.

  const chatKey  = process.env.PERPLEXICA_CHAT_MODEL  || 'gemma4:12b';
  const embedKey = process.env.PERPLEXICA_EMBED_MODEL || 'bge-m3:latest';

  const chatId    = crypto.randomBytes(16).toString('hex');
  const messageId = crypto.randomBytes(7).toString('hex');

  // /c/{chatId} 페이지 사전 GET — Perplexica backend가 chatId 세션 준비. 짧은 timeout.
  await _httpRequest('GET', baseUrl, `/c/${chatId}`, null, 5000).catch(() => null);

  const body = {
    content: query,
    chatId,
    chatModel:      { key: chatKey,  providerId },
    embeddingModel: { key: embedKey, providerId },
    files: [],
    history: Array.isArray(opts.history) ? opts.history : [],
    message: { messageId, chatId, content: query },
    optimizationMode: opts.optimizationMode || 'speed',
    sources: Array.isArray(opts.sources) ? opts.sources : ['web'],
    systemInstructions: opts.systemInstructions != null ? opts.systemInstructions : null
  };
  const payload  = JSON.stringify(body);
  const timeoutMs = opts.timeoutMs || 90_000;
  const earlyClose = opts.earlyClose !== false;

  const lib  = _lib(parsed);
  const port = _port(parsed);

  return new Promise((resolve) => {
    const blocks  = new Map();
    let buffer    = '';
    let errMsg    = null;
    let closedEarly = false;

    const req = lib.request({
      hostname: parsed.hostname, port, path: '/api/chat', method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(payload),
        'Accept':          '*/*',
        // Accept-Language 명시 — Perplexica가 LLM 검색 쿼리 분기 시 언어 인식.
        // 부재 시 영어 검색 분기 → 한국 인물/이슈 검색 결과 빈약 → backend hang.
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        // Accept-Encoding 명시 안 함 — Node http 자동 압축 해제 안 함. SSE 스트림 그대로 받기.
        'Origin':          baseUrl,                          // 신규 빌드 필수
        'Referer':         `${baseUrl}/c/${chatId}`,         // 신규 빌드 필수
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => resolve({ success: false, error: `Perplexica HTTP ${res.statusCode}: ${raw.slice(0, 300)}` }));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (closedEarly) return;
        buffer += chunk;
        let idx;
        // NDJSON — 각 라인이 JSON 객체. `\n` 또는 `\r\n` 구분.
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'error') errMsg = typeof evt.data === 'string' ? evt.data : JSON.stringify(evt);
            else _applyPatch(blocks, evt);
          } catch (e) { /* 부분 라인/heartbeat 무시 */ }
        }
        // 조기 종료 — search_results 발견하면 즉시 close (LLM 답변 안 기다림)
        if (earlyClose) {
          const sources = _extractSources(blocks);
          if (sources.length > 0) {
            closedEarly = true;
            req.destroy();
            resolve({ success: true, answer: '', sources });
          }
        }
      });
      res.on('end', () => {
        if (closedEarly) return;
        if (errMsg) { resolve({ success: false, error: `Perplexica 오류: ${errMsg}` }); return; }
        const sources = _extractSources(blocks);
        if (sources.length === 0) resolve({ success: false, error: 'Perplexica search_results 미수신' });
        else resolve({ success: true, answer: '', sources });
      });
    });

    req.on('error', (e) => {
      if (!closedEarly) resolve({ success: false, error: `Perplexica 요청 실패: ${e.message}` });
    });
    req.setTimeout(timeoutMs, () => {
      if (closedEarly) return;
      req.destroy();
      const sources = _extractSources(blocks);
      if (sources.length > 0) resolve({ success: true, answer: '', sources });
      else resolve({ success: false, error: `Perplexica 타임아웃 (${timeoutMs}ms)` });
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { searchPerplexica };
