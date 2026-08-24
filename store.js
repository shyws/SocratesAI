'use strict';
/* 纯前端存储：localStorage 单用户，无后端、无服务器。
   数据仅存浏览器本地，删后端/换部署/换机器都不影响；适配 GitHub Pages 纯静态托管。
   导入导出：单个 JSON 包含除 API Key 外的全部用户数据；导入前检测冲突。 */
window.Store = (function () {
  const LS_KEY = 'socratopia_v1';

  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function defaultStore() {
    return {
      learner: { id: 'local', globalPersona: '', preferences: '', apiConfig: null },
      textbooks: [],
    };
  }

  function normalizeTextbook(tb) {
    if (!tb) return tb;
    tb.progress = Object.assign({
      stage: 1, mastered: [], weak: [], currentGoal: '', currentUnitIndex: -1,
      coveredUnitIndices: [], currentWindow: null,
      kpStatus: {},  //知识点状态映射：kpId → 'mastered' | 'weak' | 'unlearned'
    }, tb.progress || {});
    if (tb.prep === undefined) tb.prep = null;
    if (!Array.isArray(tb.courses)) tb.courses = [];
    // 模式：'textbook'（默认，有教材正文）| 'outline'（仅导入大纲，无教材正文）
    if (tb.mode !== 'outline') tb.mode = 'textbook';
    if (tb.mode === 'outline') { tb.chunks = []; } // 大纲模式无正文切片
    tb.embeddings = null; // 向量不随备份迁移，导入后由引擎按需重新生成
    return tb;
  }

  /** 教材切片（按句/段切；与后端保持一致） */
  function sliceText(text) {
    return (text || '')
      .split(/\n+|(?<=。|；|;|\.|！|!|？|\?)/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4)
      .map((c, i) => ({ id: `c${i}`, text: c }));
  }

  let cache = null;
  function load() {
    if (cache) return cache;
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) { cache = defaultStore(); return cache; }
    try {
      const data = JSON.parse(raw);
      const base = defaultStore();
      const textbooks = (Array.isArray(data.textbooks) ? data.textbooks : []).map(normalizeTextbook);
      cache = Object.assign(base, data, {
        learner: Object.assign(base.learner, data.learner || {}),
        textbooks,
      });
      return cache;
    } catch (e) {
      cache = defaultStore();
      return cache;
    }
  }
  function save() { localStorage.setItem(LS_KEY, JSON.stringify(cache)); }

  function maskApiConfig(cfg) {
    if (!cfg) return cfg;
    const { apiKey, ...rest } = cfg;
    const masked = apiKey ? (apiKey.slice(0, 4) + '****' + apiKey.slice(-4)) : '';
    return Object.assign({}, rest, { apiKey: masked, hasKey: !!apiKey });
  }

  function getState() {
    const s = load();
    return {
      learner: Object.assign({}, s.learner, { apiConfig: maskApiConfig(s.learner.apiConfig) }),
      textbooks: s.textbooks,
    };
  }

  /* ---------------- learner 配置 ---------------- */
  function getApiConfigRaw() { return load().learner.apiConfig; }
  function updateApiConfig(cfg) { const s = load(); s.learner.apiConfig = cfg || null; save(); return s.learner.apiConfig; }
  function updateGlobalPersona(text) { const s = load(); s.learner.globalPersona = text || ''; save(); return s.learner; }

  /* ---------------- 向量缓存 + 检索模式 ---------------- */
  function getEmbeddings(tbId) { const tb = findTextbook(tbId); return tb ? tb.embeddings : null; }
  function setEmbeddings(tbId, emb) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    tb.embeddings = emb; save(); return tb.embeddings;
  }
  function setRagMode(mode) {
    const s = load();
    const cfg = Object.assign({}, s.learner.apiConfig || {});
    cfg.ragMode = (mode === 'lexical') ? 'lexical' : 'vector';
    s.learner.apiConfig = cfg; save(); return cfg;
  }

  /* ---------------- 教材 ---------------- */
  function findTextbook(tbId) { return load().textbooks.find((t) => t.id === tbId); }
  function createTextbook({ title, text, personaOverride }) {
    const s = load();
    const tb = normalizeTextbook({
      id: uid('tb_'), title: (title || '未命名教材').trim(),
      chunks: sliceText(text || ''), personaOverride: personaOverride || '',
      courses: [], activeCourseId: null, prep: null,
    });
    s.textbooks.push(tb); save(); return tb;
  }
  function updateTextbook(tbId, patch) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    if (patch.title != null) tb.title = patch.title;
    if (patch.personaOverride != null) tb.personaOverride = patch.personaOverride;
    if (patch.text != null) { tb.chunks = sliceText(patch.text); tb.embeddings = null; }
    save(); return tb;
  }
  function deleteTextbook(tbId) {
    const s = load();
    s.textbooks = s.textbooks.filter((t) => t.id !== tbId); save();
    return { ok: true };
  }

  /* ---------------- 导入三级大纲（无教材正文模式） ---------------- */
  // 解析三级 Markdown 大纲：## 单元 → ### 小节 → - 知识点。
  // 返回 { units, knowledgePoints, syllabus }，可直接作为 prep 内容。
  function parseOutline(markdown) {
    const lines = (markdown || '').split(/\r?\n/);
    const units = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^#\s+/.test(line)) continue; // 文档总标题（# 一级），忽略，教材标题由外部单独提供
      if (/^##\s+/.test(line)) {
        if (cur) units.push(cur);
        cur = { title: line.replace(/^##\s+/, '').trim(), summary: '', sections: [], kps: [], startChunk: units.length, endChunk: units.length };
        continue;
      }
      if (/^###\s+/.test(line)) {
        if (cur) cur.sections.push(line.replace(/^###\s+/, '').trim());
        continue;
      }
      if (/^[-*]\s+/.test(line) || /^\d+[.、)]\s+/.test(line)) {
        if (!cur) cur = { title: '导入大纲', summary: '', sections: [], kps: [], startChunk: 0, endChunk: 0 };
        const t = line.replace(/^[-*]\s+/, '').replace(/^\d+[.、)]\s+/, '').trim();
        if (t) cur.kps.push(t);
        continue;
      }
      // 普通段落：若紧跟单元标题、且尚未出现小节/知识点，作为单元摘要
      if (cur && cur.kps.length === 0 && cur.sections.length === 0) {
        cur.summary = (cur.summary ? cur.summary + ' ' : '') + line;
      }
    }
    if (cur) units.push(cur);
    if (!units.length) {
      throw new Error('大纲解析失败：未找到任何「## 单元」或知识点。请按三级结构组织：## 单元 → ### 小节 → - 知识点。');
    }
    units.forEach((u) => { if (!u.summary && u.sections.length) u.summary = '包含：' + u.sections.join('、'); });
    const knowledgePoints = [];
    let kpIdx = 0;
    const builtUnits = units.map((u, i) => {
      const kps = u.kps.map((t) => {
        const kp = { id: `kp_${String(kpIdx + 1).padStart(3, '0')}`, title: t, unitIndex: i, chunkStart: i, chunkEnd: i };
        knowledgePoints.push(kp); kpIdx++; return t;
      });
      return { title: u.title, summary: (u.summary || '').trim(), knowledgePoints: kps, startChunk: i, endChunk: i };
    });
    return { units: builtUnits, knowledgePoints, syllabus: (markdown || '').trim() };
  }

  // 新建「大纲模式」教材：无正文，prep 直接由导入的三级大纲生成。
  function createOutlineTextbook({ title, outline, personaOverride }) {
    const s = load();
    const parsed = parseOutline(outline);
    const tb = normalizeTextbook({
      id: uid('tb_'), title: (title || '未命名大纲').trim(),
      chunks: [], personaOverride: personaOverride || '',
      courses: [], activeCourseId: null, mode: 'outline',
      prep: {
        status: 'completed', detailLevel: 0, units: parsed.units,
        knowledgePoints: parsed.knowledgePoints, syllabus: parsed.syllabus,
        completedAt: new Date().toISOString(), error: null, phase: null,
      },
    });
    s.textbooks.push(tb); save(); return tb;
  }

  // 向已存在（或新建）的「大纲模式」教材重新导入大纲：覆盖 prep 并重置进度，避免旧 KP 状态错配。
  function importOutlineToTextbook(tbId, { title, outline }) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    const parsed = parseOutline(outline);
    tb.mode = 'outline';
    tb.chunks = [];
    if (title && title.trim()) tb.title = title.trim();
    tb.prep = {
      status: 'completed', detailLevel: 0, units: parsed.units,
      knowledgePoints: parsed.knowledgePoints, syllabus: parsed.syllabus,
      completedAt: new Date().toISOString(), error: null, phase: null,
    };
    tb.progress = Object.assign(tb.progress || {}, {
      currentUnitIndex: -1, coveredUnitIndices: [], currentWindow: null, kpStatus: {},
    });
    save(); return tb;
  }

  /* ---------------- 备课 ---------------- */
  function setPrep(tbId, prep) { const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在'); tb.prep = prep || null; save(); return tb.prep; }
  function getPrep(tbId) { const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在'); return tb.prep; }
  function updatePrep(tbId, patch) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    tb.prep = Object.assign({}, tb.prep || {}, patch); save(); return tb.prep;
  }
  function cancelPrep(tbId) { return setPrep(tbId, null); }

  /* ---------------- 进度窗口 ---------------- */
  // KP 级进度辅助：hasKps=是否有知识点数据；allResolved=所有 KP 均为 mastered/weak；
  // nextKpUnitIndex=第一个未掌握 KP 所属 unit（用于把教学窗口推进到该 unit）。
  function kpProgressInfo(tb) {
    const kps = tb.prep && Array.isArray(tb.prep.knowledgePoints) ? tb.prep.knowledgePoints : [];
    const status = (tb.progress && tb.progress.kpStatus) || {};
    if (!kps.length) return { hasKps: false, allResolved: false, nextKpUnitIndex: -1 };
    let allResolved = true;
    let nextKpUnitIndex = -1;
    for (let i = 0; i < kps.length; i++) {
      const st = status[kps[i].id];
      if (st === 'mastered' || st === 'weak') continue;
      allResolved = false;
      if (nextKpUnitIndex < 0) nextKpUnitIndex = (kps[i].unitIndex != null ? kps[i].unitIndex : 0);
    }
    return { hasKps: true, allResolved, nextKpUnitIndex };
  }
  function getCurrentWindow(tb) {
    const isOutline = tb.mode === 'outline';
    const n = (tb.chunks || []).length;
    if (!isOutline && !n) return null;
    const info = kpProgressInfo(tb);
    // KP 已全部 resolved（mastered/weak）→ 视为学完，返回 null（UI 显示"✅ 已完成"）。
    // 单 unit 教材（如 SSD/BSP，全书=1 个 unit）因此不会在第 1 节课后被误判"完成"，而是继续围绕未掌握 KP 推进。
    if (info.hasKps && info.allResolved) return null;
    if (tb.progress && tb.progress.currentWindow && !tb.progress.completedAll) return tb.progress.currentWindow;
    const prep = tb.prep;
    if (prep && prep.status === 'completed' && Array.isArray(prep.units) && prep.units.length) {
      const covered = new Set(tb.progress.coveredUnitIndices || []);
      // 优先推进到"下一个未掌握 KP 所在 unit"；否则退回首个未 covered 的 unit。
      let unitIndex = prep.units.findIndex((_, i) => !covered.has(i));
      if (unitIndex < 0) unitIndex = prep.units.length - 1;
      if (info.hasKps && info.nextKpUnitIndex >= 0) unitIndex = info.nextKpUnitIndex;
      if (isOutline) {
        return { startChunk: unitIndex, endChunk: unitIndex, unitIndex };
      }
      const u = prep.units[unitIndex];
      return { startChunk: Math.max(0, u.startChunk || 0), endChunk: Math.min(n - 1, u.endChunk ?? n - 1), unitIndex };
    }
    if (isOutline) return { startChunk: 0, endChunk: 0, unitIndex: -1 };
    return { startChunk: 0, endChunk: n - 1, unitIndex: -1 };
  }
  function setProgressWindow(tbId, window) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    tb.progress = tb.progress || {};
    tb.progress.currentWindow = window;
    if (window && window.unitIndex != null) tb.progress.currentUnitIndex = window.unitIndex;
    // 手动设窗口 = 重新进入未完成学习 → 清除"已完成"标记（否则 getCurrentWindow 会一直返回 null）
    if (window) tb.progress.completedAll = false;
    save(); return tb.progress;
  }
  function advanceProgress(tbId) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    tb.progress = tb.progress || {};
    const covered = new Set(tb.progress.coveredUnitIndices || []);
    const currentIdx = tb.progress.currentUnitIndex;
    if (currentIdx != null && currentIdx >= 0) covered.add(currentIdx);
    const prep = tb.prep;
    const info = kpProgressInfo(tb);
    const isOutline = tb.mode === 'outline';
    const n = tb.chunks.length;
    let nextIdx = -1;
    if (prep && prep.status === 'completed' && Array.isArray(prep.units) && prep.units.length) {
      nextIdx = prep.units.findIndex((_, i) => !covered.has(i));
      if (nextIdx < 0) nextIdx = prep.units.length - 1;
    }
    tb.progress.coveredUnitIndices = Array.from(covered);
    tb.progress.currentUnitIndex = nextIdx;
    // 完成判定：优先以 KP 是否全部 resolved（mastered/weak）为准；无 KP 数据时退回 unit 覆盖判定。
    // 单 unit 教材（如 SSD/BSP，全书=1 个 unit）不会在第 1 节课后就被误判"完成"，
    // 而是继续围绕未掌握 KP 推进，直到所有 KP 都 mastered/weak 才标记 completedAll。
    const done = info.hasKps ? info.allResolved : (nextIdx < 0);
    if (done) {
      tb.progress.completedAll = true;
      tb.progress.currentWindow = { startChunk: 0, endChunk: isOutline ? 0 : Math.max(0, n - 1), unitIndex: -1 };
    } else {
      tb.progress.completedAll = false;
      const unitIndex = (info.hasKps && info.nextKpUnitIndex >= 0) ? info.nextKpUnitIndex : nextIdx;
      if (isOutline) {
        tb.progress.currentWindow = { startChunk: unitIndex, endChunk: unitIndex, unitIndex };
      } else {
        const u = prep.units[unitIndex];
        tb.progress.currentWindow = { startChunk: Math.max(0, (u && u.startChunk) || 0), endChunk: Math.min(n - 1, (u && (u.endChunk ?? n - 1)) || n - 1), unitIndex };
      }
    }
    save(); return tb.progress;
  }
  /* ---- 知识点状态（per-KP: mastered / weak / unlearned） ---- */
  function getKpStatus(tbId) { const tb = findTextbook(tbId); return tb ? (tb.progress && tb.progress.kpStatus) || {} : {}; }
  function updateKpStatus(tbId, kpStatusMap) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    if (!tb.progress) tb.progress = {};
    tb.progress.kpStatus = Object.assign(tb.progress.kpStatus || {}, kpStatusMap);
    save(); return tb.progress.kpStatus;
  }

  /* ---------------- 课程 ---------------- */
  function findCourse(tbId, courseId) { const tb = findTextbook(tbId); return tb ? tb.courses.find((c) => c.id === courseId) : null; }
  function createCourse(tbId, opts) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    const n = tb.courses.length + 1;
    const padded = String(n).padStart(2, '0');
    const title = (opts && opts.title && opts.title.trim()) ? opts.title.trim() : `${padded} · 《${tb.title}》`;
    const course = {
      id: uid('co_'), title, status: 'active',
      createdAt: new Date().toISOString(), dialogues: [], summary: null,
      flashcards: [], lastQuestion: '', pendingQuestion: '',
    };
    tb.courses.push(course);
    tb.activeCourseId = course.id; save(); return course;
  }
  function appendDialogue(tbId, courseId, { role, content, provider }) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    course.dialogues.push({ role, content, ts: new Date().toISOString(), provider: provider || '' });
    if (role === 'assistant') course.lastQuestion = content;
    if (course.dialogues.length > 60) course.dialogues = course.dialogues.slice(-60);
    save(); return course;
  }
  function setSummary(tbId, courseId, summary) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    course.summary = Object.assign({ generatedAt: new Date().toISOString() }, summary);
    course.status = 'ended'; save(); return course.summary;
  }
  function saveCourse(tbId, courseId, patch) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    Object.assign(course, patch); save(); return course;
  }
  function getActiveCourse(tbId) {
    const tb = findTextbook(tbId);
    if (!tb || !tb.activeCourseId) return null;
    return tb.courses.find((c) => c.id === tb.activeCourseId) || null;
  }
  function deleteCourse(tbId, courseId) {
    const tb = findTextbook(tbId); if (!tb) throw new Error('教材不存在');
    tb.courses = tb.courses.filter((c) => c.id !== courseId);
    if (tb.activeCourseId === courseId) tb.activeCourseId = null;
    save(); return { ok: true, removed: 1 };
  }
  function clearActiveCourse(tbId) { const tb = findTextbook(tbId); if (!tb) return { ok: true }; tb.activeCourseId = null; save(); return { ok: true }; }

  /* ---------------- 闪卡 + SM-2 ---------------- */
  function addFlashcards(tbId, courseId, cards, opts) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    if (opts && opts.replace) course.flashcards = [];
    const now = Date.now();
    const list = (cards || []).map((c) => {
      const rawAnswer = (c.correctKey || c.answer || '').toString().trim();
      const type = (c.type === 'multiple' || /[,，]/.test(rawAnswer)) ? 'multiple' : 'single';
      const keys = rawAnswer.split(/[,，]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      const correctKey = type === 'single' ? (keys[0] || rawAnswer.toUpperCase()) : '';
      const correctKeys = type === 'multiple' ? keys : [];
      const optsArr = Array.isArray(c.options) ? c.options : [];
      let correctText = '';
      if (type === 'single' && /^[A-Da-d]$/.test(correctKey) && optsArr.length) {
        const re = new RegExp('^' + correctKey + '\\s*[.、)．]?\\s*');
        const hit = optsArr.find((o) => re.test(String(o).trim())) || String(optsArr[0] || '');
        correctText = String(hit).replace(re, '').trim();
      } else if (type === 'multiple' && optsArr.length) {
        correctText = optsArr
          .filter((o) => keys.some((k) => new RegExp('^' + k + '\\s*[.、)．]?\\s*').test(String(o).trim())))
          .map((o) => String(o).replace(/^[A-Da-d]\s*[.、)．]?\s*/, '').trim())
          .join('；') || rawAnswer;
      }
      return {
        id: uid('fc_'), question: c.question || '', type, options: optsArr,
        correctKey, correctKeys, answer: correctText || rawAnswer,
        explanation: c.explanation || '', box: 1, due: new Date(now).toISOString(),
        favorite: false,
      };
    });
    course.flashcards.push(...list); save(); return list;
  }
  // 切换闪卡收藏状态（参考 AI 题库小程序的收藏功能）
  function toggleFlashcardFavorite(tbId, courseId, cardId) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    const fc = course.flashcards.find((f) => f.id === cardId); if (!fc) throw new Error('闪卡不存在');
    fc.favorite = !fc.favorite; save(); return fc;
  }
  function updateFlashcard(tbId, courseId, cardId, patch) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    const fc = course.flashcards.find((f) => f.id === cardId); if (!fc) throw new Error('闪卡不存在');
    if (patch.question != null) fc.question = patch.question;
    if (patch.answer != null) fc.answer = patch.answer;
    save(); return fc;
  }
  function deleteFlashcard(tbId, courseId, cardId) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    course.flashcards = course.flashcards.filter((f) => f.id !== cardId); save();
    return { ok: true };
  }
  const SM2_INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 16, 5: 30 };
  function reviewFlashcard(tbId, courseId, cardId, quality) {
    const course = findCourse(tbId, courseId); if (!course) throw new Error('课程不存在');
    const fc = course.flashcards.find((f) => f.id === cardId); if (!fc) throw new Error('闪卡不存在');
    const correct = Number(quality) >= 2;
    fc.box = correct ? Math.min((fc.box || 1) + 1, 5) : 1;
    const days = SM2_INTERVALS[fc.box] || 1;
    fc.due = new Date(Date.now() + days * 86400000).toISOString();
    save(); return fc;
  }
  function dueByTextbook(now = Date.now()) {
    const s = load(); const result = [];
    for (const tb of s.textbooks) {
      let due = 0, total = 0;
      for (const c of tb.courses) for (const f of c.flashcards) { total += 1; if (new Date(f.due).getTime() <= now) due += 1; }
      if (total > 0) result.push({ textbookId: tb.id, title: tb.title, due, total });
    }
    return result;
  }

  /* ---------------- 导入 / 导出（除 API Key 外的全部数据） ---------------- */
  function exportAll() {
    const s = load();
    return {
      app: 'socratopia',
      version: 1,
      exportedAt: new Date().toISOString(),
      // 注意：刻意不包含 learner.apiConfig（API Key），避免泄露
      learner: {
        globalPersona: s.learner.globalPersona || '',
        preferences: s.learner.preferences || '',
      },
      textbooks: (s.textbooks || []).map((t) => { const c = Object.assign({}, t); delete c.embeddings; return c; }),
    };
  }

  /** 预览导入：对比当前状态，检测是否会产生覆盖冲突 */
  function previewImport(parsed) {
    if (!parsed || !Array.isArray(parsed.textbooks)) {
      throw new Error('备份文件格式不正确（缺少 textbooks 数组）');
    }
    const cur = load();
    const curTb = cur.textbooks || [];
    const impTb = parsed.textbooks || [];
    if (!curTb.length && !impTb.length) return { hasConflict: false, note: '两端均无数据，导入无变化' };
    if (!curTb.length) return { hasConflict: false, willImport: impTb.length, note: `将导入 ${impTb.length} 本教材` };
    if (!impTb.length) return { hasConflict: false, note: '导入内容为空，不会改动现有数据' };
    const curIds = new Set(curTb.map((t) => t.id));
    const impIds = new Set(impTb.map((t) => t.id));
    const overlap = [...curIds].filter((id) => impIds.has(id));
    const onlyCur = [...curIds].filter((id) => !impIds.has(id));
    const onlyImp = [...impIds].filter((id) => !curIds.has(id));
    return {
      hasConflict: true,
      curCount: curTb.length,
      impCount: impTb.length,
      overlapCount: overlap.length,
      onlyCurCount: onlyCur.length,
      onlyImpCount: onlyImp.length,
      note: `当前 ${curTb.length} 本 / 导入 ${impTb.length} 本；导入将覆盖 ${overlap.length} 本同名教材、新增 ${onlyImp.length} 本、移除当前独有的 ${onlyCur.length} 本。建议先导出当前备份再导入。`,
    };
  }

  /** 提交导入：用备份覆盖（保留当前 API Key 不覆盖） */
  function commitImport(parsed) {
    const cur = load();
    const textbooks = (parsed.textbooks || []).map(normalizeTextbook);
    cache = {
      learner: Object.assign({}, cur.learner, {
        globalPersona: (parsed.learner && parsed.learner.globalPersona) || '',
        preferences: (parsed.learner && parsed.learner.preferences) || '',
        apiConfig: cur.learner.apiConfig || null, // 始终保留本地现有 Key
      }),
      textbooks,
    };
    save();
    return cache;
  }

  return {
    getState, getApiConfigRaw, updateApiConfig, updateGlobalPersona,
    createTextbook, updateTextbook, deleteTextbook,
    parseOutline, createOutlineTextbook, importOutlineToTextbook,
    setPrep, getPrep, updatePrep, cancelPrep, getCurrentWindow, setProgressWindow, advanceProgress,
    getKpStatus, updateKpStatus,
    createCourse, appendDialogue, setSummary, saveCourse, getActiveCourse, clearActiveCourse, deleteCourse,
    addFlashcards, updateFlashcard, deleteFlashcard, toggleFlashcardFavorite, reviewFlashcard, dueByTextbook,
    getEmbeddings, setEmbeddings, setRagMode,
    exportAll, previewImport, commitImport,
    // 暴露给 UI 的辅助
    _raw: load,
  };
})();
