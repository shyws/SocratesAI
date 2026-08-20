'use strict';
/* 教学引擎（搬运自 src/engine/socrates.js + prep.js，纯前端版）。
   不再依赖后端：数据走 Store(localStorage)，LLM 走 LLM(BYO 直连)。
   无 API Key 时自动降级到 mock，保证离线演示闭环可用。 */
window.Engine = (function () {
  const P = window.SPROMPTS;
  const Store = window.Store;
  const LLM = window.LLM;
  const MAX_PREP_CHUNKS = 120;

  /* ---- 教材 RAG：向量语义检索（transformers.js 本地 bge）+ 中文词频回退 ---- */
  const EMBED_MODEL = 'Xenova/bge-small-zh-v1.5';
  const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
  let _tfMod = null, _extractor = null, _embedBroken = false;

  function getRagMode() {
    const cfg = Store.getApiConfigRaw();
    if (!cfg || !cfg.apiKey) return 'lexical'; // 演示 / 无 Key 模式不加载向量模型，直接走词频
    return (cfg && cfg.ragMode) || 'vector'; // 'vector' | 'lexical'
  }

  async function ensureExtractor() {
    if (_extractor) return _extractor;
    if (_embedBroken) return null;
    try {
      const mod = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2');
      try { mod.env.allowLocalModels = false; } catch (e) {}
      try { mod.env.HF_HUB_URL = 'https://hf-mirror.com'; } catch (e) {} // 国内镜像，避免 huggingface.co 直连失败
      _extractor = await mod.pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
      _tfMod = mod;
      console.info('[Engine] 本地向量模型已加载：' + EMBED_MODEL);
      return _extractor;
    } catch (e) {
      console.warn('[Engine] 本地向量模型加载失败，回退中文词频检索：', e && e.message);
      _embedBroken = true;
      return null;
    }
  }

  // 批量生成句向量（已归一化）；失败返回 null
  async function embedTexts(texts) {
    if (!texts || !texts.length) return null;
    const ex = await ensureExtractor();
    if (!ex) return null;
    try {
      const out = await ex(texts, { pooling: 'mean', normalize: true });
      const dim = out.dims[out.dims.length - 1];
      const data = out.data; // Float32Array，长度 = n*dim
      const vecs = [];
      for (let i = 0; i < texts.length; i++) vecs.push(Array.from(data.subarray(i * dim, (i + 1) * dim)));
      return { dim, vecs };
    } catch (e) {
      console.warn('[Engine] 向量推理失败，回退中文词频检索：', e && e.message);
      _embedBroken = true;
      return null;
    }
  }

  // 确保教材 [start,end] 区间内所有 chunk 已向量化（增量缓存到 Store）
  async function ensureEmbeddings(tb, start, end) {
    const cfg = Store.getApiConfigRaw();
    if (!cfg || !cfg.apiKey) return null; // 演示 / 无 Key 模式不加载向量模型
    if (!tb) return null;
    let emb = (tb.embeddings && tb.embeddings.model === EMBED_MODEL) ? tb.embeddings : null;
    if (!emb || emb.n !== tb.chunks.length) emb = { dim: 0, vecs: [], model: EMBED_MODEL, n: tb.chunks.length };
    const missing = [];
    for (let i = start; i <= end && i < tb.chunks.length; i++) {
      if (!emb.vecs[i] || emb.vecs[i].length === 0) missing.push(i);
    }
    if (missing.length) {
      const res = await embedTexts(missing.map((i) => tb.chunks[i].text || ''));
      if (!res) return null;
      if (!emb.dim) emb.dim = res.dim;
      for (let k = 0; k < missing.length; k++) emb.vecs[missing[k]] = res.vecs[k];
      try { Store.setEmbeddings(tb.id, emb); } catch (e) { console.warn('[Engine] 向量持久化失败（可能超 localStorage 上限），本次会话仅内存缓存：', e.message); }
    }
    return emb;
  }

  function cosine(a, b) {
    let s = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s; // 已归一化 → 点积即余弦
  }

  // 中文友好的词频 / 字符 n-gram 回退检索（向量不可用时的兜底，仍基于窗口 top-k）
  function tokenize(text) {
    const t = (text || '').toLowerCase();
    const grams = [];
    const cn = t.match(/[\u4e00-\u9fff]/g);
    if (cn && cn.length >= 2) { for (let i = 0; i < cn.length - 1; i++) grams.push(cn[i] + cn[i + 1]); }
    else if (cn) { grams.push.apply(grams, cn); }
    const en = t.match(/[a-z0-9]+/g);
    if (en) grams.push.apply(grams, en);
    return grams.length ? grams : [t];
  }
  function lexicalRetrieve(chunks, query, topK) {
    const grams = tokenize(query);
    const q = (query || '').toLowerCase();
    const scored = chunks.map((c) => {
      const cl = c.toLowerCase(); let s = 0;
      for (const g of grams) if (cl.includes(g)) s += 1;
      if (cl.includes(q)) s += 2;
      return { c, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, topK).map((x) => x.c);
  }

  // RAG 检索：在教材窗口 [opts.start, opts.end] 内取与 query 最相关的 topK 片段。
  // opts.tb 提供全局 chunk 以便复用向量缓存。向量失败自动回退词频。
  async function retrieve(chunks, query, topK = 3, opts = {}) {
    if (!chunks || !chunks.length) return [];
    const useWindow = opts.tb && opts.start != null && opts.end != null;
    const cand = useWindow ? chunks.slice(opts.start, opts.end + 1) : chunks;
    if (getRagMode() === 'vector' && useWindow) {
      const emb = await ensureEmbeddings(opts.tb, opts.start, opts.end);
      if (emb && emb.dim) {
        const q = await embedTexts([BGE_QUERY_PREFIX + query]);
        if (q && q.vecs[0]) {
          const qv = q.vecs[0];
          const scored = [];
          for (let i = opts.start; i <= opts.end && i < chunks.length; i++) {
            if (emb.vecs[i]) scored.push({ c: chunks[i], s: cosine(qv, emb.vecs[i]) });
          }
          scored.sort((a, b) => b.s - a.s);
          return scored.slice(0, topK).map((x) => x.c);
        }
      }
    }
    return lexicalRetrieve(cand, query, topK);
  }

  // 若解析结果是对象且启用 unwrapArray，则提取其中首个数组字段（兼容 {flashcards:[...]} 等包裹形式）
  function unwrapIfNeeded(obj, opts) {
    if (Array.isArray(obj)) return obj;
    if (opts && opts.unwrapArray && obj && typeof obj === 'object') {
      const arr = Object.keys(obj).reduce((acc, k) => acc || (Array.isArray(obj[k]) ? obj[k] : null), null);
      if (arr) return arr;
    }
    return obj;
  }
  function parseJSON(text, opts) {
    if (typeof text !== 'string') return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const openIdx = t.search(/[[{]/);
    if (openIdx < 0) return null;
    const openCh = t[openIdx];
    const closeCh = openCh === '[' ? ']' : '}';
    let depth = 0, inStr = false, esc = false;
    for (let i = openIdx; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else if (ch === '"') inStr = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) {
          const slice = t.slice(openIdx, i + 1);
          return tryParseJSON(slice, opts);
        }
      }
    }
    return null;
  }
  // 先直接解析；失败则做容错清洗（尾随逗号）后重试。
  // 注意：不替换中文引号——中文引号常作为题目文本内容出现，盲目替换会破坏合法 JSON。
  function tryParseJSON(raw, opts) {
    try { return unwrapIfNeeded(JSON.parse(raw), opts); } catch (e) { /* 继续尝试清洗 */ }
    let s = raw.replace(/,(\s*[}\]])/g, '$1').replace(/，(\s*[}\]])/g, '$1'); // 移除尾随逗号（半角/全角）
    try { return unwrapIfNeeded(JSON.parse(s), opts); } catch (e) { /* 仍失败 */ }
    return null;
  }

  function toArr(x) {
    if (Array.isArray(x)) return x.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    if (typeof x === 'string' && x.trim()) return [x.trim()];
    return [];
  }

  function cleanPending(text) {
    if (!text) return '';
    return text
      .replace(/〔[^\n〕]*〕\s*/g, '')
      .replace(/（教材依据：[^\n]*）\s*/g, '')
      .replace(/（参考你的教材：[^\n]*）\s*/g, '')
      .replace(/\*[^*]+\*\s*/g, '')
      .replace(/\n{2,}/g, '\n').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  function cleanForReview(text) {
    if (!text) return '';
    return text
      .replace(/〔[^\n〕]*〕\s*/g, '')
      .replace(/（教材依据：[^\n]*）\s*/g, '')
      .replace(/（参考你的教材：[^\n]*）\s*/g, '')
      .replace(/\*[^*]+\*\s*/g, '')
      .replace(/\n{2,}/g, '\n').replace(/\s{2,}/g, ' ').trim();
  }
  function enrichWindow(window, tb) {
    if (!window) return null;
    const copy = Object.assign({}, window);
    const prep = tb && tb.prep;
    if (prep && prep.status === 'completed' && Array.isArray(prep.units) && window.unitIndex != null && window.unitIndex >= 0) {
      const u = prep.units[window.unitIndex];
      if (u) { copy.title = copy.title || u.title; copy.summary = copy.summary || u.summary; copy.knowledgePoints = copy.knowledgePoints || u.knowledgePoints; }
    }
    return copy;
  }

  /* ---- LLM 调用：有 Key 直连，无 Key / 失败降级 mock ---- */
  async function callLLM(messages, opts = {}) {
    const cfg = Store.getApiConfigRaw();
    if (!opts.forceMock && cfg && cfg.apiKey && cfg.apiKey.trim()) {
      try { return await LLM.chat(messages, opts, cfg); }
      catch (e) {
        console.warn('[Engine] BYO 调用失败，降级 mock：', e.message);
        if (opts.failLoud) throw e; // 部分任务要求失败必须可见，不再静默兜底
      }
    }
    return { content: mockByTask(opts.task, messages), provider: 'mock' };
  }

  function mockByTask(task, messages) {
    if (task === 'chat' || task === 'lesson') return mockLessonReply(messages);
    return ''; // prep/summary/flashcards 由各自函数检测 mock 后改用结构化 mock
  }
  function mockLessonReply(messages) {
    const last = messages[messages.length - 1];
    const userText = (last && last.role === 'user') ? String(last.content || '').replace(/\n+/g, ' ').slice(0, 40) : '';
    if (/开始|认知地图|第一|引导|回顾/.test(userText)) {
      return '（演示模式 · 未接入真实模型）我们先建立本节课的认知地图：今天要搞懂的核心问题就藏在教材开头。请你先告诉我，看到这个主题时，你脑子里最先联想到的是什么？从一个具体例子说起就好。';
    }
    return '（演示模式 · 未接入真实模型）这是一个示例引导：你能先说说你对刚才这个问题的理解吗？试着用自己的话复述一遍，我们再来推敲其中的前提和逻辑。';
  }

  /* ---- 备课相关（搬运 prep.js） ---- */
  function formatChunks(chunks, max = MAX_PREP_CHUNKS) {
    return chunks.slice(0, max).map((c, i) => `片段${i}: ${c.text || c}`).join('\n');
  }
  function normalizeUnits(units, totalChunks) {
    if (!Array.isArray(units) || !units.length) return [];
    const out = units.map((u) => ({
      title: String(u.title || '未命名单元').trim(),
      summary: String(u.summary || '').trim(),
      knowledgePoints: Array.isArray(u.knowledgePoints) ? u.knowledgePoints.map(String) : [],
      startChunk: Math.max(0, Math.min(totalChunks - 1, parseInt(u.startChunk, 10) || 0)),
      endChunk: Math.max(0, Math.min(totalChunks - 1, parseInt(u.endChunk, 10) || (totalChunks - 1))),
    }));
    out.forEach((u) => { if (u.endChunk < u.startChunk) u.endChunk = u.startChunk; });
    out.sort((a, b) => a.startChunk - b.startChunk);
    for (let i = 1; i < out.length; i++) {
      if (out[i].startChunk <= out[i - 1].endChunk) {
        const mid = Math.floor((out[i - 1].endChunk + out[i].endChunk) / 2);
        out[i - 1].endChunk = mid;
        out[i].startChunk = Math.min(mid + 1, out[i].endChunk);
      }
    }
    if (out[out.length - 1].endChunk < totalChunks - 1) out[out.length - 1].endChunk = totalChunks - 1;
    return out;
  }
  function mockPrep(chunks) {
    const n = chunks.length || 1;
    const unitCount = Math.min(Math.max(3, Math.ceil(n / 12)), 8);
    const per = Math.ceil(n / unitCount);
    const units = [];
    for (let i = 0; i < unitCount; i++) {
      const s = i * per;
      const e = Math.min(n - 1, (i + 1) * per - 1);
      units.push({ title: `单元 ${i + 1}`, summary: '（演示模式）本单元涵盖该部分教材片段的核心内容。', knowledgePoints: [`知识点 ${i * 2 + 1}`, `知识点 ${i * 2 + 2}`], startChunk: s, endChunk: e });
    }
    return { status: 'completed', detailLevel: 2, units, completedAt: new Date().toISOString() };
  }

  async function prepareNow(textbookId, detailLevel = 2) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    if (!tb) throw new Error('教材不存在');
    const totalChunks = tb.chunks.length;
    if (!totalChunks) throw new Error('教材为空，无法备课');
    Store.updatePrep(textbookId, { status: 'processing', detailLevel, scheduledAt: null, error: null });
    const chunksText = formatChunks(tb.chunks, MAX_PREP_CHUNKS);
    const messages = [
      { role: 'system', content: P.buildPrepSystem(detailLevel) },
      { role: 'user', content: `以下是一本教材的连续片段（共 ${totalChunks} 段，本次分析前 ${Math.min(totalChunks, MAX_PREP_CHUNKS)} 段），请按知识点划分为教学单元并输出 JSON：\n\n${chunksText}` },
    ];
    try {
      const { content, provider } = await callLLM(messages, { task: 'prep', temperature: 0.35, max_tokens: 2000 });
      let units = [];
      if (provider !== 'mock') { const parsed = parseJSON(content); units = normalizeUnits((parsed && parsed.units) || [], totalChunks); }
      if (!units.length) units = mockPrep(tb.chunks).units;
      const prep = { status: 'completed', detailLevel, units, completedAt: new Date().toISOString(), error: null };
      Store.setPrep(textbookId, prep);
      Store.setProgressWindow(textbookId, Store.getCurrentWindow(tb));
      return prep;
    } catch (e) {
      const fallback = mockPrep(tb.chunks); fallback.error = e.message;
      Store.setPrep(textbookId, fallback); return fallback;
    }
  }

  /* ---- 对话 ---- */
  async function chat(message, textbookId, courseId, usePersona, forceMock) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    const course = tb && tb.courses.find((c) => c.id === courseId);
    const personaText = usePersona === 'global'
      ? (s.learner.globalPersona || '')
      : ((tb && tb.personaOverride && tb.personaOverride.trim()) || (s.learner.globalPersona || ''));
    const progress = tb ? tb.progress : null;
    const tbHasImages = !!(tb && tb.hasImages);
    const currentWindow = (course && course.currentWindow) || (tb ? Store.getCurrentWindow(tb) : null);
    const allChunks = tb ? tb.chunks.map((c) => c.text) : [];
    let win = null;
    if (currentWindow && currentWindow.startChunk != null && currentWindow.endChunk != null) win = { start: currentWindow.startChunk, end: currentWindow.endChunk };
    // RAG 检索：在教材窗口 [start,end] 内取与问题最相关的 top-3 片段（向量优先，失败自动回退词频）
    const anchor = await retrieve(allChunks, message, 3, { tb, start: win ? win.start : 0, end: win ? win.end : Math.max(0, allChunks.length - 1) });
    // 稳定系统提示（规则+人设+进度+媒介）放最前 → DeepSeek/OpenAI 前缀缓存命中（1/10 价）
    const stableSystem = P.buildSystemPrompt({ personaText, progress, textbookHasImages: tbHasImages });
    const messages = [{ role: 'system', content: stableSystem }];
    const anchorText = P.buildAnchorPrompt(anchor);
    if (anchorText) messages.push({ role: 'system', content: anchorText });
    const history = course ? course.dialogues.slice(-8) : [];
    messages.push(...history, { role: 'user', content: message });
    const { content: reply, provider } = await callLLM(messages, { task: 'chat', max_tokens: 1500, forceMock: !!forceMock });
    if (course) {
      Store.appendDialogue(textbookId, course.id, { role: 'user', content: message, provider });
      Store.appendDialogue(textbookId, course.id, { role: 'assistant', content: reply, provider });
    }
    return { reply, provider };
  }

  async function startLesson(textbookId, courseId, usePersona, forceMock) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    if (!tb) throw new Error('教材不存在');
    const course = tb.courses.find((c) => c.id === courseId);
    if (!course) throw new Error('课程不存在');
    const personaText = usePersona === 'global'
      ? (s.learner.globalPersona || '')
      : ((tb.personaOverride && tb.personaOverride.trim()) || (s.learner.globalPersona || ''));
    let pendQ = '';
    const finished = (tb.courses || []).filter((c) => c.id !== course.id && (c.status === 'ended' || c.status === 'done'));
    const last = finished[finished.length - 1];
    if (last) {
      pendQ = last.summary && last.summary.pendingQuestion
        ? cleanPending(last.summary.pendingQuestion)
        : (last.pendingQuestion || cleanPending(last.lastQuestion || '') || cleanPending(((last.dialogues || []).filter((d) => d.role === 'assistant').pop() || {}).content || ''));
    }
    const currentWindow = Store.getCurrentWindow(tb);
    const windowCtx = enrichWindow(currentWindow, tb);
    const allTexts = tb.chunks.map((c) => c.text);
    let windowTexts = allTexts;
    if (currentWindow && currentWindow.startChunk != null && currentWindow.endChunk != null) windowTexts = allTexts.slice(currentWindow.startChunk, currentWindow.endChunk + 1);
    const chunks = windowTexts.slice(0, 8);
    const system = P.buildLessonPrompt({ personaText, textbookChunks: chunks, pendingQuestion: pendQ, textbookHasImages: !!tb.hasImages, currentWindow: windowCtx });
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: pendQ
        ? '请基于以上教材（含上次遗留问题与本节课窗口）开始本节课：先回顾遗留问题，再把它变成今天的第一个引导性问题，并确保问题落在本节课窗口内。'
        : '请基于以上教材与本节课窗口开始本节课：先说目标（建立认知地图），再从窗口内抛出第一个引导性问题。' },
    ];
    // 预载当前窗口向量（与开场生成并行，不阻塞）；失败自动回退词频
    if (currentWindow && currentWindow.startChunk != null && currentWindow.endChunk != null) {
      ensureEmbeddings(tb, currentWindow.startChunk, currentWindow.endChunk).catch((e) => console.warn('[Engine] 预载向量失败：', e && e.message));
    }
    const { content: reply, provider } = await callLLM(messages, { task: 'lesson', max_tokens: 1500, forceMock: !!forceMock });
    Store.appendDialogue(textbookId, course.id, { role: 'assistant', content: reply, provider });
    Store.saveCourse(textbookId, course.id, { currentWindow: windowCtx });
    const full = tb.courses.find((c) => c.id === courseId);
    return { courseId: course.id, opener: reply, provider, course: full };
  }

  async function summarize(textbookId, courseId) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    const course = tb && tb.courses.find((c) => c.id === courseId);
    if (!course) throw new Error('课程不存在');
    const currentWindow = course.currentWindow || Store.getCurrentWindow(tb);
    const windowCtx = enrichWindow(currentWindow, tb);
    const lastQuestion = cleanPending(course.lastQuestion || '');
    const messages = [
      { role: 'system', content: P.buildSummarySystem({ currentWindow: windowCtx, lastQuestion }) },
      ...course.dialogues.map((d) => ({ role: d.role, content: d.content })),
    ];
    const { content, provider } = await callLLM(messages, { task: 'summary', temperature: 0.3, max_tokens: 1500 });
    let parsed = {};
    if (provider !== 'mock') parsed = parseJSON(content) || {};
    const title = (typeof parsed.title === 'string' && parsed.title.trim()) ? parsed.title.trim().slice(0, 40) : '';
    const summary = {
      title, mastered: toArr(parsed.mastered), weak: toArr(parsed.weak),
      nextSteps: toArr(parsed.nextSteps), keyPoints: toArr(parsed.keyPoints),
      pendingQuestion: cleanPending(parsed.pendingQuestion || lastQuestion || ''),
    };
    const isEmpty = !summary.title && !summary.mastered.length && !summary.weak.length && !summary.nextSteps.length && !summary.keyPoints.length;
    if (isEmpty) {
      const fb = mockSummary(course.dialogues);
      summary.title = fb.title; summary.mastered = fb.mastered; summary.weak = fb.weak;
      summary.nextSteps = fb.nextSteps; summary.keyPoints = fb.keyPoints;
      summary.pendingQuestion = cleanPending(course.lastQuestion || '');
    }
    const saved = Store.setSummary(textbookId, courseId, summary);
    if (saved.title) Store.saveCourse(textbookId, courseId, { title: saved.title });
    return { summary: saved, provider };
  }

  async function extractFlashcards(textbookId, courseId, opts = {}) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    const course = tb && tb.courses.find((c) => c.id === courseId);
    if (!course) throw new Error('课程不存在');

    // 演示模式：用户明确同意使用 mock 闪卡（用于无 Key 或调试场景）
    if (opts.forceMock) {
      const targetCount = Math.min(20, Math.max(10, opts.targetCount || 10));
      const cards = mockFlashcards(course.dialogues, targetCount);
      const added = Store.addFlashcards(textbookId, courseId, cards, { replace: true });
      return { flashcards: added, provider: 'mock', targetCount };
    }

    const cfg = Store.getApiConfigRaw();
    if (!cfg || !cfg.apiKey || !cfg.apiKey.trim()) {
      throw new Error('未配置 API Key，无法生成真实闪卡。请先在「设置」页填写 DeepSeek API Key，或勾选「使用演示闪卡」。');
    }

    const currentWindow = course.currentWindow || Store.getCurrentWindow(tb);
    const windowCtx = enrichWindow(currentWindow, tb);
    // 目标题数：下限 10 道；按本窗口知识点数适当增加（覆盖更多知识点）；上限 20 防止超出模型产出质量
    const kpCount = (windowCtx && Array.isArray(windowCtx.knowledgePoints)) ? windowCtx.knowledgePoints.length : 0;
    const targetCount = Math.min(20, Math.max(10, opts.targetCount || kpCount));
    // 限制送审对话长度：只取最近 24 轮，避免上下文/token 超限导致 JSON 截断
    const recentDialogues = (course.dialogues || []).slice(-24);
    const cleanedDialogues = recentDialogues.map((d) => ({ role: d.role, content: cleanForReview(d.content || '') }));
    const messages = [
      { role: 'system', content: P.buildFlashcardSystem({ currentWindow: windowCtx, targetCount }) },
      ...cleanedDialogues,
    ];
    if (course.summary) messages.push({ role: 'assistant', content: '本次总结：' + JSON.stringify(course.summary) });

    const { content, provider } = await callLLM(messages, { task: 'flashcards', temperature: 0.4, max_tokens: 8192, failLoud: true });

    if (provider === 'mock') {
      throw new Error('未配置 API Key 或 API 调用失败，无法生成真实闪卡。请检查「设置」中的 API Key，或选择「使用演示闪卡」。');
    }

    let cards = parseJSON(content, { unwrapArray: true });
    if (!Array.isArray(cards) || !cards.length) {
      const preview = String(content || '').replace(/\s+/g, ' ').slice(0, 300);
      console.warn('[Engine] 闪卡解析失败，原始响应前 300 字：', preview);
      throw new Error(`AI 返回的闪卡无法解析为合法 JSON 数组（可能截断或格式异常）。响应片段：${preview || '（空）'}`);
    }
    const added = Store.addFlashcards(textbookId, courseId, cards, { replace: true });
    return { flashcards: added, provider, targetCount };
  }

  async function endCourse(textbookId, courseId) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    const course = tb && tb.courses.find((c) => c.id === courseId);
    if (!course) throw new Error('课程不存在');
    const fallbackPending = cleanPending(course.lastQuestion || '');
    const { summary } = await summarize(textbookId, courseId);
    // 闪卡失败不应阻止下课保存进度；记录错误供前端提示用户手动重试
    let flashcards = course.flashcards || [];
    let flashcardError = '';
    let flashcardProvider = '';
    try {
      const r = await extractFlashcards(textbookId, courseId);
      flashcards = r.flashcards;
      flashcardProvider = r.provider;
    } catch (e) {
      flashcardError = e.message;
      console.warn('[Engine] 下课时闪卡生成失败，课程仍会结束：', e.message);
    }
    const pendingQuestion = cleanPending(summary.pendingQuestion || fallbackPending || '');
    const saved = Store.saveCourse(textbookId, courseId, { pendingQuestion, status: 'ended', endedAt: new Date().toISOString() });
    Store.advanceProgress(textbookId);
    return { summary: saved.summary, flashcards: saved.flashcards, pendingQuestion, courseId, flashcardError, flashcardProvider };
  }

  function reviewFlashcard(tbId, courseId, fcId, quality) { return Store.reviewFlashcard(tbId, courseId, fcId, quality); }

  /* ---- mock 结构化数据（搬运自 socrates.js） ---- */
  function mockSummary(dialogues) {
    const turns = dialogues.filter((d) => d.role === 'user').length;
    return {
      title: '（演示）本节课要点回顾',
      mastered: ['（演示）学员尝试用自己的话回答问题'],
      weak: ['（演示）部分概念仍需巩固'],
      nextSteps: ['（演示）可继续深入本章下一节'],
      keyPoints: ['（演示）本节课围绕教材片段展开苏格拉底式探讨'],
      text: `（演示模式 · 未接入真实模型）本节课共 ${turns} 轮师生对话，学员在引导下尝试独立思考。接入真实 API 后将生成个性化总结。`,
    };
  }
  function mockFlashcards(dialogues, targetCount) {
    const count = Math.max(10, targetCount || 10);
    const turns = (dialogues || []).filter((d) => d.role === 'assistant');
    const templates = [
      { opts: ['A. 该说法与教材无关', 'B. 该结论可由教材片段直接推出', 'C. 这是纯主观感受，无对错', 'D. 应忽略教材自行判断'], ans: 'B', exp: '复习卡只考学科知识点；正确项须基于教材片段推导，不凭空发挥。' },
      { opts: ['A. 仅看字面', 'B. 结合上下文与教材锚点', 'C. 凭直觉判断', 'D. 忽略定义'], ans: 'B', exp: '正确理解应结合教材上下文，而非孤立看字面。' },
      { opts: ['A. 概念等价', 'B. 概念有包含/依赖关系', 'C. 完全无关', 'D. 互为反义'], ans: 'B', exp: '教材中相关概念多为包含或依赖关系，需厘清边界。' },
      { opts: ['A. 直接背结论', 'B. 先理解前提再推导', 'C. 跳过例子', 'D. 只记公式'], ans: 'B', exp: '苏格拉底式学习强调从前提推导，而非记忆结论。' },
    ];
    const cards = []; let i = 0;
    while (cards.length < count) {
      const tmpl = templates[cards.length % templates.length];
      cards.push({ question: '关于本节课的核心知识点，以下说法正确的是？', options: tmpl.opts, answer: tmpl.ans, explanation: tmpl.exp });
      i++;
    }
    return cards;
  }

  return { prepareNow, chat, startLesson, summarize, extractFlashcards, endCourse, reviewFlashcard, callLLM };
})();
