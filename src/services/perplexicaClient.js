// perplexicaClient.js
// 목적: Perplexica (80서버 :3000) HTTP API 클라이언트.
//       SearXNG snippet 한계(가격 캐시 + 시점 메타 부재)를 보완.
//       Perplexica는 자체적으로 SearXNG 호출 + URL 본문 fetch + LLM 답변까지 수행.
//
// 옵션 B 결합: Perplexica의 1차 답변(answer) + 출처(sources)를 받아
//   stock-talk 자체 LLM(Ollama/Claude)이 박스권/모드/holdings 컨텍스트와 결합해 최종 답변 생성.
//
// 엔드포인트: POST /api/search
//   요청 본문(JSON):
//     {
//       query, focusMode, optimizationMode, chatModel, embeddingModel,
//       history (optional)
//     }
//   응답(JSON):
//     {
//       message: "AI가 작성한 답변 텍스트 (Perplexica가 LLM 호출해 만든 1차 답변)",
//       sources: [ { metadata: { title, url }, pageContent } ]
//     }
//   (정확 키 이름은 Perplexica 버전에 따라 미묘 차이. 본 클라이언트는 키 fallback 처리.)
//
// 타임아웃 60초 — Perplexica는 LLM 추론 포함이라 SearXNG 단독(15초)보다 길게.
// 실패 시 throw 안 하고 { success:false, error } 반환 — 호출 측에서 SearXNG 폴백 처리.

const http  = require('http');
const https = require('https');

function _parseUrl(raw) {
  return new URL(raw);
}

/**
 * Perplexica /api/search 호출.
 * @param {string} query - 사용자 질의 (예: "안랩 최근 이슈")
 * @param {object} opts
 *   - focusMode:        'webSearch' | 'academicSearch' | 'writingAssistant' | 'wolframAlphaSearch' | 'youtubeSearch' | 'redditSearch' (기본 webSearch)
 *   - optimizationMode: 'speed' | 'balanced' | 'quality' (기본 balanced)
 *   - chatModel:        { provider, model } — 미지정 시 Perplexica config 기본값
 *   - embeddingModel:   { provider, model }
 *   - history:          [[role, text], ...] (옵션)
 * @returns {Promise<{ success: boolean, answer?: string, sources?: Array, error?: string }>}
 */
async function searchPerplexica(query, opts = {}) {
  const baseUrl = process.env.PERPLEXICA_URL || 'http://192.168.20.80:3000';
  let parsed;
  try { parsed = _parseUrl(baseUrl); }
  catch (e) { return { success: false, error: `PERPLEXICA_URL 파싱 실패: ${e.message}` }; }

  const lib  = parsed.protocol === 'https:' ? https : http;
  const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);

  const body = JSON.stringify({
    query,
    focusMode:        opts.focusMode        || 'webSearch',
    optimizationMode: opts.optimizationMode || 'balanced',
    ...(opts.chatModel      ? { chatModel:      opts.chatModel }      : {}),
    ...(opts.embeddingModel ? { embeddingModel: opts.embeddingModel } : {}),
    ...(opts.history        ? { history:        opts.history }        : {})
  });

  return new Promise((resolve) => {
    const req = lib.request({
      hostname: parsed.hostname,
      port,
      path:     '/api/search',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json',
        'User-Agent':     'stock-talk/1.0'
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ success: false, error: `Perplexica HTTP ${res.statusCode}: ${raw.slice(0, 200)}` });
          return;
        }
        try {
          const j = JSON.parse(raw);
          // Perplexica 응답 키 정규화 — 버전에 따라 message/answer 차이 있음
          const answer  = j.message || j.answer || j.response || '';
          const sources = Array.isArray(j.sources) ? j.sources.map(s => ({
            title:   (s.metadata && s.metadata.title) || s.title || '',
            url:     (s.metadata && s.metadata.url)   || s.url   || '',
            content: s.pageContent || s.content || ''
          })) : [];
          resolve({ success: true, answer, sources });
        } catch (e) {
          resolve({ success: false, error: `Perplexica 응답 파싱 실패: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: `Perplexica 요청 실패: ${e.message}` });
    });
    req.setTimeout(60_000, () => {
      req.destroy();
      resolve({ success: false, error: 'Perplexica 타임아웃 (60s)' });
    });

    req.write(body);
    req.end();
  });
}

module.exports = { searchPerplexica };
