'use strict';
/* 教学引擎（搬运自 src/engine/socrates.js + prep.js，纯前端版）。
   不再依赖后端：数据走 Store(localStorage)，LLM 走 LLM(BYO 直连)。
   无 API Key 时自动降级到 mock，保证离线演示闭环可用。 */
window.Engine = (function () {
  const P = window.SPROMPTS;
  const Store = window.Store;
  const LLM = window.LLM;
  const MAX_PREP_CHUNKS = 120;

  /* ---- 工具 ---- */
  function retrieve(chunks, query, topK = 3) {
    if (!chunks || !chunks.length) return [];
    const q = (query || '').toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const scored = chunks.map((c) => {
      const cl = c.toLowerCase(); let s = 0;
      for (const w of words) if (cl.includes(w)) s += 1;
      return { c, s };
    }).sort((a, b) => b.s - a.s);
    return scored.slice(0, topK).map((x) => x.c);
  }

  function parseJSON(text) {
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
      else if (ch === closeCh) { depth--; if (depth === 0) { try { return JSON.parse(t.slice(openIdx, i + 1)); } catch (e) { return null; } } }
    }
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
      catch (e) { console.warn('[Engine] BYO 调用失败，降级 mock：', e.message); }
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
    let chunks = tb ? tb.chunks.map((c) => c.text) : [];
    if (currentWindow && currentWindow.startChunk != null && currentWindow.endChunk != null) chunks = chunks.slice(currentWindow.startChunk, currentWindow.endChunk + 1);
    const anchor = retrieve(chunks, message, 3);
    const system = P.buildSystemPrompt({ personaText, progress, textbookChunks: anchor, textbookHasImages: tbHasImages });
    const history = course ? course.dialogues.slice(-8) : [];
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: message }];
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

  async function extractFlashcards(textbookId, courseId) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    const course = tb && tb.courses.find((c) => c.id === courseId);
    if (!course) throw new Error('课程不存在');
    const currentWindow = course.currentWindow || Store.getCurrentWindow(tb);
    const windowCtx = enrichWindow(currentWindow, tb);
    const cleanedDialogues = (course.dialogues || []).map((d) => ({ role: d.role, content: cleanForReview(d.content || '') }));
    const messages = [
      { role: 'system', content: P.buildFlashcardSystem({ currentWindow: windowCtx }) },
      ...cleanedDialogues,
    ];
    if (course.summary) messages.push({ role: 'assistant', content: '本次总结：' + JSON.stringify(course.summary) });
    const { content, provider } = await callLLM(messages, { task: 'flashcards', temperature: 0.4, max_tokens: 3000 });
    let cards = [];
    if (provider !== 'mock') cards = parseJSON(content) || [];
    if (!Array.isArray(cards) || !cards.length) cards = mockFlashcards(course.dialogues);
    const added = Store.addFlashcards(textbookId, courseId, cards, { replace: true });
    return { flashcards: added, provider };
  }

  async function endCourse(textbookId, courseId) {
    const s = Store._raw();
    const tb = s.textbooks.find((t) => t.id === textbookId);
    const course = tb && tb.courses.find((c) => c.id === courseId);
    if (!course) throw new Error('课程不存在');
    const fallbackPending = cleanPending(course.lastQuestion || '');
    const { summary } = await summarize(textbookId, courseId);
    const { flashcards } = await extractFlashcards(textbookId, courseId);
    const pendingQuestion = cleanPending(summary.pendingQuestion || fallbackPending || '');
    const saved = Store.saveCourse(textbookId, courseId, { pendingQuestion, status: 'ended', endedAt: new Date().toISOString() });
    Store.advanceProgress(textbookId);
    return { summary: saved.summary, flashcards: saved.flashcards, pendingQuestion, courseId };
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
  function mockFlashcards(dialogues) {
    const turns = (dialogues || []).filter((d) => d.role === 'assistant');
    const templates = [
      { opts: ['A. 该说法与教材无关', 'B. 该结论可由教材片段直接推出', 'C. 这是纯主观感受，无对错', 'D. 应忽略教材自行判断'], ans: 'B', exp: '复习卡只考学科知识点；正确项须基于教材片段推导，不凭空发挥。' },
      { opts: ['A. 仅看字面', 'B. 结合上下文与教材锚点', 'C. 凭直觉判断', 'D. 忽略定义'], ans: 'B', exp: '正确理解应结合教材上下文，而非孤立看字面。' },
      { opts: ['A. 概念等价', 'B. 概念有包含/依赖关系', 'C. 完全无关', 'D. 互为反义'], ans: 'B', exp: '教材中相关概念多为包含或依赖关系，需厘清边界。' },
      { opts: ['A. 直接背结论', 'B. 先理解前提再推导', 'C. 跳过例子', 'D. 只记公式'], ans: 'B', exp: '苏格拉底式学习强调从前提推导，而非记忆结论。' },
    ];
    const cards = []; let i = 0;
    while (cards.length < 10) {
      const t = turns[i % Math.max(turns.length, 1)];
      const q = t ? String(t.content || '').replace(/\n+/g, ' ').slice(0, 36) : '本节课的核心知识点';
      const tmpl = templates[cards.length % templates.length];
      cards.push({ question: `关于"${q}…"，以下说法正确的是？`, options: tmpl.opts, answer: tmpl.ans, explanation: tmpl.exp });
      i++;
    }
    return cards;
  }

  return { prepareNow, chat, startLesson, summarize, extractFlashcards, endCourse, reviewFlashcard, callLLM };
})();
