// src/services/aiService.js
// AI 엔진 통합 서비스. Ollama(기본) + Claude API(고급) 이중 구조.
// CLAUDE_API_KEY 없을 때 크래시 없이 안내 메시지 반환 (graceful fallback).

const http      = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const { getChatHistory, saveChatMessage, getStockInfo, getHoldings } = require('../db/queries');

// ============ Ollama 모델 목록 ============
/**
 * Ollama /api/tags — 설치된 모델 목록 조회
 */
async function listOllamaModels() {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  return new Promise((resolve, reject) => {
    const url = new URL('/api/tags', baseUrl);
    const req = http.request({
      hostname: url.hostname, port: url.port || 11434,
      path: url.pathname, method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const models = (json.models || []).map(m => ({
            name: m.name,
            size: m.size,
            modified: m.modified_at
          }));
          resolve(models);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ============ 비스트리밍 AI 호출 (반성 단계용) ============

/**
 * Ollama 비스트리밍 호출 — 짧은 판단용 (검색 반성, 추가 쿼리 결정 등)
 */
async function callOllamaNonStreaming(systemPrompt, userMessage, model) {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const body = JSON.stringify({
    model: model || process.env.OLLAMA_MODEL || 'gemma4:12b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  }
    ],
    stream: false,
    options: { temperature: 0.2, num_predict: 300 }
  });
  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', baseUrl);
    const req = http.request({
      hostname: url.hostname, port: url.port || 11434,
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).message?.content || ''); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Ollama 반성 타임아웃')));
    req.write(body);
    req.end();
  });
}

/**
 * Claude 비스트리밍 호출 — 짧은 판단용
 */
async function callClaudeNonStreaming(systemPrompt, userMessage) {
  if (!process.env.CLAUDE_API_KEY) return 'NONE';
  const client = getAnthropicClient();
  const msg = await client.messages.create({
    model:      process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 300,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userMessage }]
  });
  return msg.content[0]?.text || 'NONE';
}

/**
 * 1차 검색 결과를 보고 추가 검색어 1~2개 생성 (없으면 빈 배열)
 */
async function reflectForMoreQueries(originalQuery, initialResults, engine, model) {
  const REFLECT_SYS = '검색 분석 어시스턴트. 요청한 형식으로만 답하라. 설명 금지.';
  const userMsg = `사용자 질문: "${originalQuery}"

1차 검색 결과:
${initialResults.map((r, i) => `${i + 1}. ${r.title}\n${r.content}`).join('\n\n')}

더 완전한 답변을 위해 추가 검색이 필요하면 검색어를 1~2개 작성하라 (한 줄에 하나).
충분하면 NONE 만 답하라.`;

  try {
    let raw;
    if (engine === 'claude') {
      raw = await callClaudeNonStreaming(REFLECT_SYS, userMsg);
    } else {
      raw = await callOllamaNonStreaming(REFLECT_SYS, userMsg, model);
    }
    if (!raw || raw.trim().toUpperCase().startsWith('NONE')) return [];
    return raw.split('\n')
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(l => l && !l.toUpperCase().startsWith('NONE'))
      .slice(0, 2);
  } catch {
    return [];
  }
}

// ============ SearXNG 인터넷 검색 ============
/**
 * SearXNG JSON API 검색 — 상위 N개 결과 반환
 */
async function searchSearXNG(query, limit = 5) {
  // 환경변수 우선, 없으면 192.168.20.80:8888 (실측 확정 엔드포인트)
  const baseUrl = process.env.SEARXNG_URL || 'http://192.168.20.80:8888';
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'stock-talk/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.results || []).slice(0, limit).map(r => ({
            title: r.title || '',
            url: r.url || '',
            content: r.content || ''
          }));
          resolve(results);
        } catch (e) { reject(new Error('SearXNG 응답 파싱 실패: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    // 타임아웃 15초 — SearXNG가 다수 엔진 집계 시 8초 초과 빈번
    req.setTimeout(15000, () => req.destroy(new Error('SearXNG 타임아웃 (15s)')));
    req.end();
  });
}

// Anthropic 클라이언트 싱글톤 (키 있을 때만 초기화)
let anthropicClient = null;

function getAnthropicClient() {
  if (!process.env.CLAUDE_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  }
  return anthropicClient;
}

// ============ AI 모드 감지 ============

/**
 * 현재가 + 박스권 + 보유정보 기반 6가지 모드 자동 결정
 */
function detectMode(close, boxLow, boxHigh, avgPrice, volume, volMa20) {
  const LOWER_ZONE      = boxLow  * 1.07;
  const UPPER_ZONE      = boxHigh * 0.93;
  const ISSUE_THRESHOLD = volMa20 * 2.0;
  const LOSS_THRESHOLD  = avgPrice * 0.90;

  if (close <= LOWER_ZONE && close >= boxLow)               return 'MODE 1'; // 매수탐색
  if (close >= UPPER_ZONE && close <= boxHigh)              return 'MODE 2'; // 익절관리
  if (close < boxLow)                                       return 'MODE 3'; // 위기관리
  if (close > boxHigh && volume >= ISSUE_THRESHOLD)         return 'MODE 4'; // 이슈추격
  if (avgPrice > 0 && close <= LOSS_THRESHOLD)              return 'MODE 5'; // 리커버리
  return 'MODE 6';                                                            // 일반분석
}

// ============ 시스템 프롬프트 빌더 ============

// [A] 고정 역할 정의
const PROMPT_A = `당신은 한국 중소형 박스권 주식 전문 AI 분석가입니다.
핵심 전략: 장기 박스권 하단 매수 + 분할 매수, 이슈 발생 시 상단 돌파 기대.
분석 근거: OBV 수급 방향 + RSI 다이버전스 + 볼린저밴드 위치 조합.
답변 형식: 현황 요약 - 기술적 분석 - 대응 시나리오(2~3개) - 핵심 모니터링 포인트.
주의: 투자 최종 판단은 투자자 본인 책임입니다.

[후속 질문 제안 규칙]
답변 마지막에 반드시 아래 형식으로 사용자가 이어서 물어볼 만한 질문 2~3개를 제안하라.
형식: [Q: 질문내용]
예시:
[Q: 삼성전자 목표가 분석해줘]
[Q: OBV 수급 추세 자세히 설명해줘]
[Q: 분할 매수 구체적인 계획은?]`;

// [B] 모드별 지시
const PROMPT_B = {
  'MODE 1': '【매수탐색 모드】 현재가가 박스권 하단 근처입니다. OBV 수급과 RSI 다이버전스를 확인하고 분할 매수 시나리오를 제시하세요.',
  'MODE 2': '【익절관리 모드】 현재가가 박스권 상단 근처입니다. 익절 타이밍과 부분 매도 시나리오를 제시하세요.',
  'MODE 3': '【위기관리 모드】 현재가가 박스권 하단을 이탈했습니다. 추가 하락 리스크와 대응 전략을 냉정하게 분석하세요.',
  'MODE 4': '【이슈추격 모드】 박스권 상단 이탈 + 거래량 급증. 돌파 지속 가능성과 진입/관망 판단을 제시하세요.',
  'MODE 5': '【리커버리 모드】 평가손실 -10% 이상. 손실 최소화 방안과 추가 매수 여부를 분석하세요.',
  'MODE 6': '【일반분석 모드】 현재 지표를 종합 분석하고 시장 흐름을 평가하세요.'
};

/**
 * [A]+[B]+[C]+[D]+[E]+[F] 6블록 시스템 프롬프트 조합
 * [E] 현재 시점 안내 (LLM cutoff 이후 데이터 미래 오인 방지)
 * [F] 인터넷 검색 결과 (있을 때만)
 */
function buildSystemPrompt({ mode, holdings, stockInfo, latestIndicator, webResults }) {
  // [C] 개인 컨텍스트
  let blockC = '[개인 투자 컨텍스트]\n';
  if (holdings) {
    if (holdings.avg_price)      blockC += `매입단가: ${Number(holdings.avg_price).toLocaleString()}원\n`;
    if (holdings.quantity)       blockC += `보유수량: ${holdings.quantity}주\n`;
    if (holdings.available_cash) blockC += `가용자금: ${Number(holdings.available_cash).toLocaleString()}원\n`;
    if (holdings.strategy)       blockC += `투자전략: ${holdings.strategy}\n`;
    if (holdings.expected_issue) blockC += `기대이슈: ${holdings.expected_issue}\n`;
  } else {
    blockC += '보유 정보 없음\n';
  }
  if (stockInfo) {
    if (stockInfo.box_low)  blockC += `박스권 하단: ${Number(stockInfo.box_low).toLocaleString()}원\n`;
    if (stockInfo.box_high) blockC += `박스권 상단: ${Number(stockInfo.box_high).toLocaleString()}원\n`;
  }

  // [D] 실시간 지표
  let blockD = '[실시간 기술 지표 (최근 일봉)]\n';
  if (latestIndicator) {
    const d = latestIndicator;
    blockD += `날짜: ${d.date}\n`;
    blockD += `종가: ${d.close ? Number(d.close).toLocaleString() : 'N/A'}원\n`;
    blockD += `RSI(14): ${d.rsi != null ? d.rsi.toFixed(1) : 'N/A'}\n`;
    blockD += `BB 위치: ${d.bbPctB != null ? (d.bbPctB * 100).toFixed(0) + '%' : 'N/A'} (0=하단, 100=상단)\n`;
    blockD += `OBV 추세: ${(d.obv != null && d.obvMa20 != null) ? (d.obv > d.obvMa20 ? '매집(OBV>MA20)' : '분산(OBV<MA20)') : 'N/A'}\n`;
    blockD += `MACD 히스토그램: ${d.macdHistogram != null ? d.macdHistogram.toFixed(0) : 'N/A'}\n`;
    blockD += `RSI 다이버전스: ${d.rsiDivergence || '없음'}\n`;
    blockD += `OBV 다이버전스: ${d.obvDivergence || '없음'}\n`;
    blockD += `캔들 패턴: ${d.candlePattern || '없음'}\n`;
  } else {
    blockD += '지표 데이터 없음\n';
  }

  // [E] 현재 시점 — LLM 학습 cutoff 이후 데이터 미래 오인 방지 (로컬 타임존 기준)
  const _now = new Date();
  const today = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
  const blockE = `[현재 시점 안내]
오늘 날짜: ${today}
중요: 위 일봉 데이터 및 지표는 DB에서 조회한 실시간 최신 데이터입니다.
당신의 학습 cutoff 이후 날짜라도 미래 데이터가 아닌 현재 시점의 실제 시장 데이터로 인식하고 분석하세요.
DB에 없는 정보(뉴스/공시 등)는 모른다고 답변하되, 제공된 일봉/지표 데이터는 신뢰할 수 있는 최신 데이터입니다.`;

  // [F] 인터넷 검색 결과 (있을 때만)
  let blockF = '';
  if (webResults && webResults.length) {
    blockF = '[인터넷 검색 결과]\n' +
      webResults.map((r, i) =>
        `${i+1}. ${r.title}\n   URL: ${r.url}\n   요약: ${r.content}`
      ).join('\n\n') +
      '\n위 검색 결과를 참고하여 답변에 반영하세요.';
  } else if (webResults && webResults.length === 0) {
    blockF = '[인터넷 검색 결과]\n검색 결과 없음 또는 검색 실패. 일봉/지표 데이터만으로 답변하세요.';
  }

  const blocks = [PROMPT_A, PROMPT_B[mode] || PROMPT_B['MODE 6'], blockC, blockD, blockE];
  if (blockF) blocks.push(blockF);
  return blocks.join('\n\n');
}

// ============ Ollama 스트리밍 ============

/**
 * Ollama /api/chat NDJSON 스트리밍
 * @param {Array}  messages      - 대화 메시지 배열
 * @param {Function} onChunk     - 스트리밍 청크 콜백
 * @param {Function} onDone      - 완료 콜백
 * @param {string}   modelOverride - 모델 오버라이드
 * @param {Array}    images      - 첨부 이미지 배열 [{ base64, mediaType }]
 */
async function chatWithOllama(messages, onChunk, onDone, modelOverride, images) {
  const model   = modelOverride || process.env.OLLAMA_MODEL || 'gemma4:12b';
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

  // 이미지가 있으면 마지막 user 메시지에 images 배열 첨부 (Ollama 비전 API 형식)
  const finalMessages = messages.map((m, i) => {
    if (images && images.length > 0 && i === messages.length - 1 && m.role === 'user') {
      return { ...m, images: images.map(img => img.base64) };
    }
    return m;
  });

  const body = JSON.stringify({
    model, messages: finalMessages, stream: true,
    options: { temperature: 0.7, top_p: 0.9, num_predict: 4096 }
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 11434,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let fullContent = '';
      let tokenCount  = 0;
      let buffer      = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 마지막 불완전 라인은 다음 chunk에서 처리

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              fullContent += json.message.content;
              tokenCount++;
              onChunk({ content: json.message.content });
            }
            if (json.done) {
              onDone({ engine: 'ollama', tokens: tokenCount });
              resolve(fullContent);
            }
          } catch { /* JSON 파싱 실패 — 스트림 경계, 무시 */ }
        }
      });

      res.on('end', () => resolve(fullContent));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============ Claude API 스트리밍 ============

/**
 * Claude API 스트리밍
 * CLAUDE_API_KEY 없으면 크래시 없이 안내 메시지 반환 (graceful fallback)
 * @param {Array} images - 첨부 이미지 배열 [{ base64, mediaType }]
 */
async function chatWithClaude(systemPrompt, messages, onChunk, onDone, images) {
  if (!process.env.CLAUDE_API_KEY) {
    const msg = 'Claude API 키가 설정되지 않았습니다. .env 파일에 CLAUDE_API_KEY를 추가하고 앱을 재시작하세요.';
    onChunk({ content: msg });
    onDone({ engine: 'claude', tokens: 0 });
    return msg;
  }

  const client = getAnthropicClient();
  const model  = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  try {
    let fullContent  = '';
    let inputTokens  = 0;
    let outputTokens = 0;

    // 마지막 user 메시지에 이미지 첨부 (Claude vision API 형식)
    const apiMessages = messages.map((m, i) => {
      if (images && images.length > 0 && i === messages.length - 1 && m.role === 'user') {
        return {
          role: 'user',
          content: [
            ...images.map(img => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.base64 }
            })),
            { type: 'text', text: m.content }
          ]
        };
      }
      return { role: m.role, content: m.content };
    });

    const stream = client.messages.stream({
      model,
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   apiMessages
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        fullContent += event.delta.text;
        onChunk({ content: event.delta.text });
      }
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens || 0;
      }
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens || 0;
      }
    }

    onDone({ engine: 'claude', tokens: inputTokens + outputTokens });
    return fullContent;
  } catch (err) {
    const errMsg = `Claude API 오류: ${err.message}`;
    onChunk({ content: errMsg });
    onDone({ engine: 'claude', tokens: 0 });
    return errMsg;
  }
}

// ============ 채팅 진입점 ============

/**
 * AI 채팅 진입점 (main.js ipcMain.on('ai:chat') 에서 호출)
 * @param {Array} images - 첨부 이미지 배열 [{ base64, mediaType }] (선택)
 */
async function chat({ message, ticker, engine, ohlcvData, model, images, onChunk, onDone }) {
  const historyLimit = engine === 'claude' ? 40 : 20;
  const [history, stockInfo, holdings] = await Promise.all([
    getChatHistory(ticker, engine, historyLimit),
    getStockInfo(ticker),
    getHoldings(ticker)
  ]);

  const latestIndicator = ohlcvData?.length > 0 ? ohlcvData[ohlcvData.length - 1] : null;

  const close    = latestIndicator?.close  || 0;
  const boxLow   = stockInfo?.box_low      || 0;
  const boxHigh  = stockInfo?.box_high     || 0;
  const avgPrice = holdings?.avg_price     || 0;
  const volume   = latestIndicator?.volume || 0;
  const volMa20  = ohlcvData?.length >= 20
    ? ohlcvData.slice(-20).reduce((s, d) => s + d.volume, 0) / 20
    : volume;

  const mode = (boxLow && boxHigh)
    ? detectMode(close, boxLow, boxHigh, avgPrice, volume, volMa20)
    : 'MODE 6';

  // "인터넷" 트리거 — 에이전틱 다단계 검색 (최대 3라운드)
  let webResults = null;
  if (/인터넷/.test(message)) {
    const query = message.replace(/인터넷(에서)?\s*/g, '').trim() || message;
    try {
      // 1단계: 초기 검색
      onChunk({ content: `🔍 1차 검색: "${query}"...\n\n` });
      const initial = await searchSearXNG(query, 5);
      onChunk({ content: `✓ 1차 완료: ${initial.length}개\n\n` });

      // 2단계: AI 반성 — 추가 검색어 판단
      onChunk({ content: `🤔 추가 검색 필요 여부 분석 중...\n\n` });
      const moreQueries = await reflectForMoreQueries(query, initial, engine, model);

      // 3단계: 추가 검색 (병렬, 최대 2개 쿼리)
      let additional = [];
      if (moreQueries.length > 0) {
        onChunk({ content: `🔍 2차 검색: ${moreQueries.map(q => `"${q}"`).join(', ')}...\n\n` });
        const addResults = await Promise.all(
          moreQueries.map(q => searchSearXNG(q, 5).catch(() => []))
        );
        additional = addResults.flat();
        onChunk({ content: `✓ 2차 완료: ${additional.length}개\n\n` });
      }

      webResults = [...initial, ...additional];
      onChunk({ content: `✅ 총 ${webResults.length}개 결과로 분석 시작...\n\n---\n\n` });
    } catch (e) {
      console.error('SearXNG 검색 실패:', e.message);
      onChunk({ content: `⚠ 검색 실패: ${e.message}\n검색 없이 분석합니다.\n\n---\n\n` });
      webResults = [];
    }
  }

  const systemPrompt = buildSystemPrompt({ mode, holdings, stockInfo, latestIndicator, webResults });

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  await saveChatMessage(ticker, 'user', message, engine);

  let fullResponse = '';
  const wrappedOnChunk = (data) => { fullResponse += data.content || ''; onChunk(data); };
  const wrappedOnDone  = async (stats) => {
    if (fullResponse) await saveChatMessage(ticker, 'assistant', fullResponse, engine);
    onDone({ ...stats, mode });
  };

  if (engine === 'claude') {
    await chatWithClaude(systemPrompt, messages, wrappedOnChunk, wrappedOnDone, images);
  } else {
    // Ollama: system 프롬프트를 messages 첫 번째에 포함, model 인자 전달
    const ollamaMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    await chatWithOllama(ollamaMessages, wrappedOnChunk, wrappedOnDone, model, images);
  }
}

module.exports = { chat, detectMode, buildSystemPrompt, listOllamaModels };
