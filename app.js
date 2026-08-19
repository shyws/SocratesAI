'use strict';
/* Socratopia 网页版 SPA（纯前端版）：localStorage 存储 + BYO 直连，无后端依赖。
   可直接托管到 GitHub Pages 等静态服务；API Key 仅存浏览器本地，不进仓库、不泄露。 */

const Store = window.Store;
const Engine = window.Engine;
// 前端只有 BYO 直连 + 内置 Mock，不再有"服务端 provider"
const PROVIDERS = [
  { key: 'byo', label: '用自己的 Key（有则直连，无则自动演示）' },
  { key: 'mock', label: '强制演示模式（Mock）' },
];
const LESSON_RESUME = {};

/* ----------------- 工具 ----------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function app() { return document.getElementById('app'); }

/* Markdown 渲染：marked 解析 + DOMPurify 净化（内容含 AI/用户输入，必须防 XSS）。
   库未加载时降级为纯文本保留换行，避免整页崩溃。 */
function renderMD(md) {
  const s = String(md == null ? '' : md);
  if (!s.trim()) return '';
  if (typeof window.marked === 'undefined') {
    return '<div class="md">' + esc(s).replace(/\n/g, '<br>') + '</div>';
  }
  let html;
  try {
    html = window.marked.parse(s, { breaks: true, gfm: true });
  } catch (e) {
    return '<div class="md">' + esc(s).replace(/\n/g, '<br>') + '</div>';
  }
  if (typeof window.DOMPurify !== 'undefined') {
    html = window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }
  return '<div class="md">' + html + '</div>';
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* 懒加载外部脚本 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('脚本加载失败（可能离线）'));
    document.head.appendChild(s);
  });
}

/* 浏览器端提取 PDF 文字（pdf.js） */
async function extractPdfText(file) {
  if (!window.pdfjsLib) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  }
  if (!window.pdfjsLib) throw new Error('PDF 解析库不可用');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return text;
}

/* ----------------- OCR（Tesseract.js，纯浏览器端，免费） ---------------- */
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const OCR_LANG = 'chi_sim+eng';

async function pdfPagesToCanvases(doc, scale) {
  const canvases = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
  }
  return canvases;
}

async function runOCR(images) {
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  const worker = await Tesseract.createWorker(OCR_LANG, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        const el = document.getElementById('nt-file-msg');
        if (el) el.textContent = `OCR 识别中… ${Math.round(m.progress * 100)}%`;
      }
    },
  });
  let out = '';
  for (const img of images) {
    const { data } = await worker.recognize(img);
    out += data.text + '\n';
  }
  await worker.terminate();
  return out;
}

async function ocrPdfFile(file) {
  if (!window.pdfjsLib) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const canvases = await pdfPagesToCanvases(doc, 2);
  return await runOCR(canvases);
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = URL.createObjectURL(file);
  });
}

async function ocrImageFile(file) {
  const img = await fileToImage(file);
  return await runOCR([img]);
}

/* ----------------- 路由 ----------------- */
function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'dashboard' };
  if (parts[0] === 'textbooks' && parts.length === 1) return { name: 'textbooks' };
  if (parts[0] === 'textbooks' && parts.length === 2) return { name: 'textbook', tbId: parts[1] };
  if (parts[0] === 'textbooks' && parts[2] === 'courses' && parts.length === 4) return { name: 'lesson', tbId: parts[1], courseId: parts[3] };
  if (parts[0] === 'textbooks' && parts[2] === 'courses' && parts[4] === 'review') return { name: 'review', tbId: parts[1], courseId: parts[3] };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'dashboard' };
}

function setActiveNav(route) {
  $all('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
}

async function router() {
  const r = parseHash();
  setActiveNav('/' + (r.name === 'dashboard' ? '' : r.name === 'textbooks' ? 'textbooks' : r.name === 'settings' ? 'settings' : ''));
  try {
    if (r.name === 'dashboard') await renderDashboard();
    else if (r.name === 'textbooks') await renderTextbooks();
    else if (r.name === 'textbook') await renderTextbook(r.tbId);
    else if (r.name === 'lesson') await renderLesson(r.tbId, r.courseId);
    else if (r.name === 'review') await renderReview(r.tbId, r.courseId);
    else if (r.name === 'settings') await renderSettings();
  } catch (e) {
    app().innerHTML = `<div class="card">加载失败：${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

/* ----------------- 仪表盘 ----------------- */
async function renderDashboard() {
  const state = Store.getState();
  const due = Store.dueByTextbook();
  const dueMap = {};
  due.forEach((d) => { dueMap[d.textbookId] = d; });
  let html = `<h2>仪表盘</h2>`;
  if (!state.textbooks.length) {
    html += `<div class="card muted">还没有教材。去 <a href="#/textbooks">教材库</a> 新建第一本吧。</div>`;
  }
  const dueItems = due.filter((d) => d.due > 0);
  if (dueItems.length) {
    html += `<div class="card"><h3>🔔 待复习提醒</h3>`;
    dueItems.forEach((d) => {
      html += `<div class="item"><div><div class="title">《${esc(d.title)}》</div><div class="meta">有 ${d.due} 张闪卡待复习（共 ${d.total} 张）</div></div><div class="spacer"></div><a class="btn ghost" href="#/textbooks/${d.textbookId}">去复习</a></div>`;
    });
    html += `</div>`;
  }
  state.textbooks.forEach((tb) => {
    const d = dueMap[tb.id];
    const active = tb.courses.filter((c) => c.status === 'active').length;
    html += `<div class="card">
      <div class="row"><div class="title">《${esc(tb.title)}》</div><div class="spacer"></div>
      <a class="btn ghost" href="#/textbooks/${tb.id}">打开</a></div>
      <div class="meta">阶段 ${tb.progress.stage} ｜ 已掌握 ${tb.progress.mastered.length} ｜ 薄弱 ${tb.progress.weak.length} ｜ 进行中课程 ${active} ｜ 课程 ${tb.courses.length}</div>
      ${d && d.due > 0 ? `<div class="pill warn">${d.due} 张待复习</div>` : ''}
    </div>`;
  });
  app().innerHTML = html;
}

/* ----------------- 教材阅读进度小方格 ---------------- */
function isCoveredChunk(chunkIdx, units, coveredUnitIndices) {
  if (!Array.isArray(units)) return false;
  const covered = new Set(coveredUnitIndices || []);
  for (let i = 0; i < units.length; i++) {
    if (!covered.has(i)) continue;
    const u = units[i];
    if (chunkIdx >= (u.startChunk || 0) && chunkIdx <= ((u.endChunk ?? u.startChunk) || 0)) return true;
  }
  return false;
}

function renderProgressGrid(tb, compact) {
  const n = (tb.chunks || []).length || 1;
  const prep = tb.prep;
  const covered = tb.progress && tb.progress.coveredUnitIndices ? tb.progress.coveredUnitIndices : [];
  const win = tb.progress && tb.progress.currentWindow ? tb.progress.currentWindow : null;
  const cells = compact ? 30 : 100;
  let html = `<div class="progress-grid ${compact ? 'compact' : ''}" title="每个小格约代表全书 ${Math.round(100 / cells)}%。主题色实格：此前范围；空心格：当前窗口；浅色实格：后续范围">`;
  for (let i = 0; i < cells; i++) {
    const chunkIdx = Math.min(n - 1, Math.floor(i / cells * n));
    let cls = 'progress-cell';
    if (win && chunkIdx >= win.startChunk && chunkIdx <= win.endChunk) cls += ' current';
    else if (prep && prep.status === 'completed' && isCoveredChunk(chunkIdx, prep.units, covered)) cls += ' covered';
    else cls += ' future';
    html += `<div class="${cls}"></div>`;
  }
  html += `</div>`;
  if (!compact) {
    html += `<div class="progress-legend"><span class="dot covered"></span>已覆盖 <span class="dot current"></span>当前窗口 <span class="dot future"></span>后续范围</div>`;
  }
  return html;
}

/* ----------------- 教材库 ----------------- */
async function renderTextbooks() {
  const state = Store.getState();
  let html = `<div class="row"><h2 style="margin:0">教材库</h2><div class="spacer"></div></div>
  <div class="card">
    <h3>新建教材</h3>
    <label>教材名称</label><input id="nt-title" placeholder="如：高中物理" />
    <label>教材来源（三选一：粘贴文本 / 上传 PDF / 网页链接）</label>
    <div class="row src-tabs">
      <button class="ghost src-tab active" data-tab="paste">粘贴文本</button>
      <button class="ghost src-tab" data-tab="file">上传 PDF 文件</button>
      <button class="ghost src-tab" data-tab="url">网页链接</button>
    </div>
    <div id="pane-file" style="display:none">
      <input type="file" id="nt-file" accept=".pdf,.png,.jpg,.jpeg,.gif,.bmp,.webp,.txt,.md" />
      <div class="muted" id="nt-file-msg">支持 PDF（自动提取文字；检测为扫描版时自动 OCR 识别中文）、图片（直接 OCR）、TXT、MD；选好后自动填入下方正文。</div>
    </div>
    <div id="pane-url" style="display:none">
      <div class="row"><input id="nt-url" placeholder="https://..." /><button id="nt-fetch" class="ghost">抓取正文</button></div>
      <div class="muted" id="nt-url-msg">浏览器直接抓取网页正文；多数站点会因跨域(CORS)被拦，失败请手动复制正文粘贴。</div>
    </div>
    <label style="margin-top:10px">教材正文（粘贴，或经上方上传 / 抓取自动填入；可再手动润色）</label>
    <textarea id="nt-text" placeholder="例如：牛顿第二定律 F=ma 表明物体加速度与合外力成正比，与质量成反比……"></textarea>
    <label style="margin-top:8px">本教材人设（可选，创建后覆盖全局默认人设）</label>
    <textarea id="nt-persona" placeholder="如：用严谨推导风，多追问公式来源；留空则沿用全局默认人设"></textarea>
    <div class="row" style="margin-top:10px"><button id="nt-save">创建并切片</button><span class="muted" id="nt-msg"></span></div>
  </div>`;
  state.textbooks.forEach((tb) => {
    html += `<div class="item">
      <div><div class="title">《${esc(tb.title)}》</div>
      <div class="meta">切片 ${tb.chunks.length} 段 ｜ 课程 ${tb.courses.length} ｜ 阶段 ${tb.progress.stage}${tb.personaOverride ? ' ｜ 专用人设' : ''}</div></div>
      <div class="spacer"></div>
      <a class="btn ghost" href="#/textbooks/${tb.id}">打开</a>
      <button class="btn danger" data-del="${tb.id}">删除</button>
    </div>`;
  });
  app().innerHTML = html;

  let currentTab = 'paste';
  const showTab = (tab) => {
    currentTab = tab;
    $('#pane-file').style.display = tab === 'file' ? 'block' : 'none';
    $('#pane-url').style.display = tab === 'url' ? 'block' : 'none';
    $all('.src-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  };
  $all('.src-tab').forEach((b) => b.onclick = () => showTab(b.dataset.tab));

  $('#nt-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#nt-file-msg').textContent = '解析中…';
    try {
      let txt = '';
      if (/\.pdf$/i.test(f.name)) {
        txt = await extractPdfText(f);
        if (txt.trim().length < 30) {
          $('#nt-file-msg').textContent = '未检测到文字层，正在用 OCR 识别（中文）…';
          txt = await ocrPdfFile(f);
        }
      } else if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)) {
        $('#nt-file-msg').textContent = '正在用 OCR 识别图片（中文）…';
        txt = await ocrImageFile(f);
      } else {
        txt = await f.text();
      }
      const ta = $('#nt-text');
      ta.value = (ta.value ? ta.value + '\n\n' : '') + txt;
      $('#nt-file-msg').textContent = `已提取 ${txt.length} 字，已填入正文（可继续手动润色）。`;
    } catch (err) {
      $('#nt-file-msg').textContent = '提取失败：' + err.message + '（可改为"粘贴文本"）';
    }
  };

  $('#nt-fetch').onclick = async () => {
    const url = $('#nt-url').value.trim();
    if (!url) return ($('#nt-url-msg').textContent = '请填写链接');
    $('#nt-fetch').disabled = true; $('#nt-url-msg').textContent = '抓取中…';
    try {
      // 纯前端 fetch：多数站点会因 CORS 被拦截，失败引导手动粘贴
      const resp = await fetch(url, { mode: 'cors' });
      const text = await resp.text();
      const ta = $('#nt-text');
      ta.value = (ta.value ? ta.value + '\n\n' : '') + text;
      $('#nt-url-msg').textContent = `已抓取 ${text.length} 字，已填入正文。`;
    } catch (e) {
      $('#nt-url-msg').textContent = '抓取失败（浏览器跨域限制）：请手动复制网页正文粘贴到上方文本框。';
    } finally { $('#nt-fetch').disabled = false; }
  };

  $('#nt-save').onclick = async () => {
    const title = $('#nt-title').value.trim();
    const text = $('#nt-text').value;
    if (!title) return ($('#nt-msg').textContent = '请填写名称');
    if (!text || !text.trim()) return ($('#nt-msg').textContent = '请先填写 / 上传 / 抓取教材正文');
    Store.createTextbook({ title, text, personaOverride: $('#nt-persona').value });
    $('#nt-title').value = ''; $('#nt-text').value = ''; $('#nt-persona').value = '';
    $('#nt-msg').textContent = '已创建';
    renderTextbooks();
  };
  $all('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认删除该教材及其所有课程？')) return;
    Store.deleteTextbook(b.dataset.del);
    renderTextbooks();
  });
}

/* ----------------- 教材详情（课程列表 + 人设覆盖） ----------------- */
async function renderTextbook(tbId) {
  const state = Store.getState();
  const tb = state.textbooks.find((t) => t.id === tbId);
  if (!tb) return (app().innerHTML = `<div class="card">教材不存在</div>`);
  const prep = tb.prep;
  const prepStatusText = !prep
    ? '尚未备课。建议先对教材做整体梳理，AI 会按知识点划分单元并跟踪进度。'
    : prep.status === 'processing'
      ? '正在备课中，请稍候…'
      : `备课完成（${prep.detailLevel} 档），共 ${(prep.units || []).length} 个单元 · ${new Date(prep.completedAt).toLocaleString()}`;

  let html = `<div class="row"><a class="btn ghost" href="#/textbooks">← 教材库</a><div class="spacer"></div></div>
  <h2>《${esc(tb.title)}》</h2>
  <div class="card">
    <h3>每教材人设覆盖（可选，覆盖全局默认人设）</h3>
    <textarea id="po" placeholder="例如：用严谨推导风，多追问公式来源；可不填，留空则沿用全局人设">${esc(tb.personaOverride || '')}</textarea>
    <div class="row" style="margin-top:8px"><button id="po-save">保存人设覆盖</button><span class="muted" id="po-msg"></span></div>
  </div>
  <div class="card">
    <h3>📐 备课与教材进度</h3>
    <div class="muted" style="margin-bottom:10px">${prepStatusText}</div>
    ${renderProgressGrid(tb)}
    <div id="prep-controls" class="row" style="margin-top:12px;align-items:flex-end">
      <div>
        <label style="margin-top:0">备课详细度</label>
        <select id="prep-level">
          <option value="1">1 精简：标题 + 核心知识点</option>
          <option value="2" selected>2 标准：标题 + 摘要 + 知识点关系</option>
          <option value="3">3 详细：含定义、易错点、示例</option>
        </select>
      </div>
      <button id="prep-now">立即备课</button>
      ${prep && prep.status === 'completed' ? `<button id="prep-reset" class="ghost">清除备课</button>` : ''}
    </div>
    <div id="prep-msg" class="muted" style="margin-top:8px"></div>
    <div id="prep-units" style="margin-top:10px"></div>
  </div>
  <div class="card">
    <h3>课程（=每次教学）</h3>
    <div class="row" style="margin-bottom:8px"><button id="nc">+ 新建课程</button></div>
    <div id="courses"></div>
  </div>`;
  app().innerHTML = html;

  const renderCourses = () => {
    const box = $('#courses');
    if (!tb.courses.length) { box.innerHTML = `<div class="muted">还没有课程，点"新建课程"开始一次教学。</div>`; return; }
    box.innerHTML = tb.courses.map((c) => `
      <div class="item">
        <div><div class="title">${esc(c.title)}</div>
        <div class="meta">${c.status === 'active' ? '进行中' : '已结束'} ｜ 对话 ${c.dialogues.length} ｜ 闪卡 ${c.flashcards.length}${c.summary ? ' ｜ 已有总结' : ''}</div></div>
        <div class="spacer"></div>
        <a class="btn" href="#/textbooks/${tbId}/courses/${c.id}">进入</a>
        <a class="btn ghost" href="#/textbooks/${tbId}/courses/${c.id}/review">总结/闪卡</a>
        <button class="btn danger" data-del-course="${c.id}">删除</button>
      </div>`).join('');
    $all('[data-del-course]', box).forEach((b) => b.onclick = async () => {
      if (!confirm('确认删除该课程及其对话、闪卡、总结？此操作不可撤销。')) return;
      Store.deleteCourse(tbId, b.dataset.delCourse);
      tb.courses = Store.getState().textbooks.find((t) => t.id === tbId).courses;
      renderCourses();
    });
  };
  renderCourses();

  const renderUnits = () => {
    const box = $('#prep-units');
    if (!prep || prep.status !== 'completed' || !prep.units || !prep.units.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<details><summary>查看 ${prep.units.length} 个知识单元</summary>` +
      prep.units.map((u, i) => `
        <div class="unit-item">
          <div class="row"><b>单元 ${i + 1}：${esc(u.title)}</b><span class="muted">片段 ${u.startChunk}~${u.endChunk}</span></div>
          <div class="muted">${renderMD(u.summary || '')}</div>
        </div>`).join('') +
      `</details>`;
  };
  renderUnits();

  $('#prep-now').onclick = async () => {
    const btn = $('#prep-now'); btn.disabled = true; $('#prep-msg').textContent = '正在备课，请稍候…';
    try {
      await Engine.prepareNow(tbId, Number($('#prep-level').value));
      $('#prep-msg').textContent = '备课完成';
      renderTextbook(tbId);
    } catch (e) { $('#prep-msg').textContent = '备课失败：' + e.message; btn.disabled = false; }
  };
  const resetBtn = $('#prep-reset');
  if (resetBtn) {
    resetBtn.onclick = async () => {
      if (!confirm('清除备课单元与进度？教材正文与课程保持不变。')) return;
      Store.cancelPrep(tbId);
      renderTextbook(tbId);
    };
  }

  $('#po-save').onclick = async () => {
    Store.updateTextbook(tbId, { personaOverride: $('#po').value });
    $('#po-msg').textContent = '已保存';
  };
  $('#nc').onclick = async () => {
    Store.createCourse(tbId, {});
    tb.courses = Store.getState().textbooks.find((t) => t.id === tbId).courses;
    renderCourses();
  };
}

/* ----------------- 教学工作台（对话，可切人设） ----------------- */
async function renderLesson(tbId, courseId) {
  const state = Store.getState();
  const tb = state.textbooks.find((t) => t.id === tbId);
  const course = tb && tb.courses.find((c) => c.id === courseId);
  if (!course) return (app().innerHTML = `<div class="card">课程不存在</div>`);
  const useOverride = !!(tb.personaOverride && tb.personaOverride.trim());
  const rawCfg = Store.getApiConfigRaw();
  const byoOn = !!(rawCfg && rawCfg.apiKey);

  const isFinished = (course.status === 'ended' || course.status === 'done') && !LESSON_RESUME[courseId];
  let courseState = 'active';
  if (isFinished) courseState = 'ended';
  else if (!course.dialogues.length) courseState = 'none';

  const summaryHtml = (s) => s ? `
    <div class="row"><div class="title">已掌握</div></div><div>${s.mastered.map((x) => `<span class="pill ok">${esc(x)}</span>`).join('') || '无'}</div>
    <div class="row" style="margin-top:8px"><div class="title">薄弱</div></div><div>${s.weak.map((x) => `<span class="pill warn">${esc(x)}</span>`).join('') || '无'}</div>
    <div class="row" style="margin-top:8px"><div class="title">下一步</div></div><div class="muted">${(s.nextSteps || []).map(esc).join('；') || '无'}</div>
    <div class="row" style="margin-top:8px"><div class="title">关键点</div></div><div class="muted">${(s.keyPoints || []).map(esc).join('；') || '无'}</div>
    ${s.text ? `<div class="muted" style="margin-top:8px">${renderMD(s.text)}</div>` : ''}`
    : `<div class="muted">尚未生成总结。</div>`;

  const win = tb.progress && tb.progress.currentWindow;
  let html = `<div class="row"><a class="btn ghost" href="#/textbooks/${tbId}">← 教材</a><div class="spacer"></div></div>
  <h2>${esc(course.title)}</h2>
  ${win ? `<div class="card" style="padding:10px 14px">
    <div class="row" style="margin-bottom:8px"><div class="muted">当前窗口：${esc(tb.title)} · 片段 ${win.startChunk}~${win.endChunk}${win.title ? ' · ' + esc(win.title) : ''}</div></div>
    ${renderProgressGrid(tb, true)}
  </div>` : ''}
  <div class="card">
    <div class="row">
      <span class="muted">教材：</span><b>${esc(tb.title)}</b>
      <span class="muted" style="margin-left:8px">当前人设：</span>
      <select id="persona-sel">
        <option value="global" ${!useOverride ? 'selected' : ''}>全局默认人设</option>
        <option value="override" ${useOverride ? 'selected' : ''}>本教材专用人设（覆盖）</option>
      </select>
      <span class="muted" style="margin-left:8px">模型：</span>
      <select id="provider-sel">
        <option value="byo" ${byoOn ? 'selected' : ''}>用自己的 Key（有则直连，无则自动演示）</option>
        <option value="mock">强制演示模式（Mock）</option>
      </select>
      ${byoOn ? '<span class="muted" style="margin-left:8px;color:#b45309">已启用你的 Key，对话走你自己的模型</span>' : ''}
    </div>
    <div id="override-edit" style="display:${useOverride ? 'block' : 'none'};margin-top:8px">
      <textarea id="po2" placeholder="本教材专用人设描述">${esc(tb.personaOverride || '')}</textarea>
      <div class="row" style="margin-top:6px"><button id="po2-save" class="ghost">保存本教材人设</button><span class="muted">切到"全局默认"即停用覆盖</span></div>
    </div>
  </div>`;

  if (courseState === 'none') {
    html += `<div class="card">
      <div class="row"><div class="title">准备开始《${esc(tb.title)}》的这节课</div></div>
      <div class="muted">AI 会根据教材备课，并先抛出问题引导你思考。每节课「下课」会自动保存进度、生成闪卡与课后总结。</div>
      <div class="row" style="margin-top:10px"><button id="start-lesson">开始上课</button><span class="muted" id="start-msg"></span></div>
    </div>`;
  }

  if (courseState === 'ended') {
    html += `<div class="card">
      <div class="row"><div class="title">📚 本节课已下课</div></div>
      <div class="muted">课后总结与闪卡已生成，可点下方查看；新一轮课程会自动从本次遗留问题续接。</div>
      <div class="row" style="margin-top:10px">
        <a class="btn ghost" href="#/textbooks/${tbId}/courses/${courseId}/review">查看总结 / 闪卡</a>
        <button id="new-course" class="primary">新建课程（续接上次问题）</button>
        <button id="del-course" class="danger">删除课程</button>
      </div>
      ${course.pendingQuestion ? `<div class="muted" style="margin-top:10px">下次上课将从这个问题继续：${esc(course.pendingQuestion)}</div>` : ''}
    </div>`;
  }

  html += `<div class="card lesson">
    <div class="bubbles" id="bubbles"></div>
    ${courseState === 'active' ? `<div class="composer">
      <textarea id="input" placeholder="写下你的思考与回答…"></textarea>
      <button id="send">发送</button>
    </div>
    <div class="lesson-actions">
      <button id="finish" class="ghost">下课</button>
    </div>` : ''}
  </div>`;
  app().innerHTML = html;

  const bubbles = $('#bubbles');
  const addBubble = (role, text, provider) => {
    const d = document.createElement('div');
    d.className = 'bubble ' + role;
    const who = document.createElement('div'); who.className = 'who';
    who.textContent = (role === 'user' ? '学员' : '苏格拉底') + (provider ? ' · ' + provider : '');
    const body = document.createElement('div'); body.innerHTML = renderMD(text);
    d.appendChild(who); d.appendChild(body); bubbles.appendChild(d);
    bubbles.scrollTop = bubbles.scrollHeight;
  };
  course.dialogues.forEach((d) => addBubble(d.role, d.content, d.provider));

  $('#persona-sel').onchange = async (e) => {
    if (e.target.value === 'override') {
      $('#override-edit').style.display = 'block';
    } else {
      $('#override-edit').style.display = 'none';
      Store.updateTextbook(tbId, { personaOverride: '' });
    }
  };
  $('#po2-save').onclick = async () => {
    Store.updateTextbook(tbId, { personaOverride: $('#po2').value });
    alert('已保存本教材人设（后续对话即时生效）');
  };

  if (courseState === 'none') {
    $('#start-lesson').onclick = async () => {
      const btn = $('#start-lesson'); btn.disabled = true; $('#start-msg').textContent = '备课中…';
      try {
        await Engine.startLesson(tbId, courseId, $('#persona-sel').value, $('#provider-sel').value === 'mock');
        renderLesson(tbId, courseId);
      } catch (e) { alert('备课失败：' + e.message); btn.disabled = false; $('#start-msg').textContent = ''; }
    };
  }

  if (courseState === 'active') {
    const send = async () => {
      const input = $('#input');
      const text = input.value.trim();
      if (!text) return;
      addBubble('user', text);
      input.value = '';
      const btn = $('#send'); btn.disabled = true;
      try {
        const r = await Engine.chat(text, tbId, courseId, $('#persona-sel').value, $('#provider-sel').value === 'mock');
        addBubble('assistant', r.reply, r.provider);
      } catch (e) {
        addBubble('assistant', '出错了：' + e.message);
      } finally { btn.disabled = false; }
    };
    $('#send').onclick = send;
    $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    $('#finish').onclick = async () => {
      if (!confirm('下课并自动生成课后总结与闪卡？')) return;
      const btn = $('#finish'); btn.disabled = true;
      try {
        await Engine.endCourse(tbId, courseId);
        renderLesson(tbId, courseId);
      } catch (e) { alert('下课失败：' + e.message); btn.disabled = false; }
    };
  }

  const newCourseBtn = $('#new-course');
  if (newCourseBtn) {
    newCourseBtn.onclick = async () => {
      const c = Store.createCourse(tbId, {});
      location.hash = `#/textbooks/${tbId}/courses/${c.id}`;
    };
  }
  const delCourseBtn = $('#del-course');
  if (delCourseBtn) {
    delCourseBtn.onclick = async () => {
      if (!confirm('确认删除该课程及其对话、闪卡、总结？此操作不可撤销。')) return;
      Store.deleteCourse(tbId, courseId);
      location.hash = '#/textbooks/' + tbId;
    };
  }
}

/* ----------------- 总结与闪卡（复习 + 导出） ----------------- */
async function renderReview(tbId, courseId) {
  const state = Store.getState();
  const tb = state.textbooks.find((t) => t.id === tbId);
  const course = tb && tb.courses.find((c) => c.id === courseId);
  if (!course) return (app().innerHTML = `<div class="card">课程不存在</div>`);

  const summaryHtml = (s) => s ? `
    <div class="row"><div class="title">已掌握</div></div><div>${s.mastered.map((x) => `<span class="pill ok">${esc(x)}</span>`).join('') || '无'}</div>
    <div class="row" style="margin-top:8px"><div class="title">薄弱</div></div><div>${s.weak.map((x) => `<span class="pill warn">${esc(x)}</span>`).join('') || '无'}</div>
    <div class="row" style="margin-top:8px"><div class="title">下一步</div></div><div class="muted">${(s.nextSteps || []).map(esc).join('；') || '无'}</div>
    <div class="row" style="margin-top:8px"><div class="title">关键点</div></div><div class="muted">${(s.keyPoints || []).map(esc).join('；') || '无'}</div>`
    : `<div class="muted">尚未生成总结。结束教学时会自动生成，也可点击下方按钮手动生成。</div>`;

  let html = `<div class="row"><a class="btn ghost" href="#/textbooks/${tbId}/courses/${courseId}">← 返回对话</a><div class="spacer"></div></div>
  <h2>${esc(course.title)} · 总结与闪卡</h2>
  <div class="card"><h3>课后总结</h3><div id="summary">${summaryHtml(course.summary)}</div>
    <div class="row" style="margin-top:10px"><button id="gen-sum">生成/刷新总结</button><button id="gen-fc">生成/重生成闪卡（覆盖旧）</button></div></div>
  <div class="card">
    <div class="row"><h3 style="margin:0">闪卡（${course.flashcards.length}）</h3><div class="spacer"></div>
      <button id="review-mode" class="ghost">开始复习</button>
      <button id="exp-md" class="ghost">导出 MD</button>
      <button id="exp-anki" class="ghost">导出 Anki</button>
      <button id="exp-pdf" class="ghost">导出 PDF</button>
    </div>
    <div id="fc-list"></div>
  </div>`;
  app().innerHTML = html;

  const renderFc = () => {
    const box = $('#fc-list');
    if (!course.flashcards.length) { box.innerHTML = `<div class="muted">还没有闪卡，点"生成闪卡"。</div>`; return; }
    box.innerHTML = course.flashcards.map((f) => {
      const opts = (Array.isArray(f.options) && f.options.length)
        ? `<ol class="opts">${f.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>` : '';
      const typeLabel = f.type === 'multiple' ? '不定项' : '单选';
      const correctLabel = f.type === 'multiple' && Array.isArray(f.correctKeys) && f.correctKeys.length
        ? f.correctKeys.join(',')
        : (f.correctKey || '');
      return `<div class="fc" data-id="${f.id}">
        <div class="row"><span class="pill">${typeLabel}</span><div class="q">Q：${esc(f.question)}</div></div>
        ${opts}
        <div class="a">正确答案：${esc(correctLabel)} ｜ ${esc(f.answer)}</div>
        ${f.explanation ? `<div class="exp">解析：${renderMD(f.explanation)}</div>` : ''}
        <div class="box">box ${f.box || 1} ｜ 下次 ${new Date(f.due).toLocaleDateString()}</div>
        <div class="row" style="margin-top:6px"><button class="ghost del" data-id="${f.id}">删除</button></div>
      </div>`;
    }).join('');
    $all('.del', box).forEach((b) => b.onclick = async () => {
      Store.deleteFlashcard(tbId, courseId, b.dataset.id);
      course.flashcards = Store.getState().textbooks.find((t) => t.id === tbId).courses.find((c) => c.id === courseId).flashcards;
      renderFc();
    });
  };
  renderFc();

  $('#gen-sum').onclick = async () => {
    $('#gen-sum').disabled = true;
    try {
      await Engine.summarize(tbId, courseId);
      await renderReview(tbId, courseId);
    } catch (e) { alert('失败：' + e.message); }
    finally { const b = document.getElementById('gen-sum'); if (b) b.disabled = false; }
  };
  $('#gen-fc').onclick = async () => {
    $('#gen-fc').disabled = true;
    try {
      const r = await Engine.extractFlashcards(tbId, courseId);
      course.flashcards = Store.getState().textbooks.find((t) => t.id === tbId).courses.find((c) => c.id === courseId).flashcards;
      renderFc();
      alert('已覆盖生成 ' + r.flashcards.length + ' 张闪卡（旧的已替换）');
    } catch (e) { alert('失败：' + e.message); }
    finally { $('#gen-fc').disabled = false; }
  };

  $('#review-mode').onclick = async () => {
    const due = course.flashcards.filter((f) => new Date(f.due).getTime() <= Date.now());
    if (!due.length) return alert('当前没有待复习的闪卡 🎉');
    let i = 0;
    const next = () => {
      if (i >= due.length) { alert('本轮复习完成'); return renderReview(tbId, courseId); }
      const f = due[i];
      const box = $('#fc-list');
      const opts = (Array.isArray(f.options) && f.options.length)
        ? `<ol class="opts">${f.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>` : '';
      box.innerHTML = `<div class="fc"><div class="q">Q：${esc(f.question)}</div>
        ${opts}
        <div class="a" id="rv-a" style="display:none">正确答案：${esc(f.correctKey || '')} ｜ ${esc(f.answer)}</div>
        ${f.explanation ? `<div class="exp" id="rv-e" style="display:none">解析：${renderMD(f.explanation)}</div>` : ''}
        <div class="box">box ${f.box || 1}</div>
        <div class="row" style="margin-top:8px">
          <button id="rv-show">显示答案</button>
          <button id="rv-bad" class="ghost" style="display:none">答错了</button>
          <button id="rv-good" class="ghost" style="display:none">答对了</button>
        </div></div>`;
      $('#rv-show').onclick = () => {
        $('#rv-a').style.display = 'block';
        const e = document.getElementById('rv-e'); if (e) e.style.display = 'block';
        $('#rv-bad').style.display = ''; $('#rv-good').style.display = '';
      };
      $('#rv-good').onclick = async () => { Store.reviewFlashcard(tbId, courseId, f.id, 2); i++; next(); };
      $('#rv-bad').onclick = async () => { Store.reviewFlashcard(tbId, courseId, f.id, 1); i++; next(); };
    };
    next();
  };

  $('#exp-md').onclick = () => download(course.title + '.md', buildExportMD(course, tb), 'text/markdown');
  $('#exp-anki').onclick = () => download(course.title + '.tsv', buildExportAnki(course), 'text/plain');
  $('#exp-pdf').onclick = () => exportPDF(course, tb.title);
}

function buildExportMD(course, tb) {
  let md = `# ${course.title}\n\n教材：《${tb.title}》｜状态：${course.status}\n\n## 对话记录\n\n`;
  course.dialogues.forEach((d) => { md += `**${d.role === 'user' ? '学员' : '苏格拉底'}**：${d.content}\n\n`; });
  if (course.summary) {
    const s = course.summary;
    md += `## 课后总结\n\n- 标题：${s.title || ''}\n- 已掌握：${(s.mastered || []).join('、')}\n- 薄弱：${(s.weak || []).join('、')}\n- 下一步：${(s.nextSteps || []).join('；')}\n- 关键点：${(s.keyPoints || []).join('；')}\n`;
  }
  if (course.flashcards.length) {
    md += `\n## 闪卡（${course.flashcards.length}）\n\n`;
    course.flashcards.forEach((f, i) => {
      md += `${i + 1}. **Q**: ${f.question}\n`;
      (f.options || []).forEach((o) => { md += `   - ${o}\n`; });
      const correct = f.type === 'multiple' && Array.isArray(f.correctKeys) ? f.correctKeys.join(',') : (f.correctKey || '');
      md += `   正确答案：${correct} ｜ ${f.answer}\n`;
      if (f.explanation) md += `   解析：${f.explanation}\n`;
    });
  }
  return md;
}

function buildExportAnki(course) {
  return course.flashcards.map((f) => {
    const q = (f.question || '').replace(/\t/g, ' ').replace(/\n/g, ' ');
    const a = (f.answer || '').replace(/\t/g, ' ').replace(/\n/g, ' ');
    return q + '\t' + a;
  }).join('\n');
}

function exportPDF(course, tbTitle) {
  if (!window.html2pdf) return alert('PDF 组件未加载（需联网加载 html2pdf.js），请改用 MD 导出。');
  const esc2 = (s) => esc(s).replace(/\n/g, '<br>');
  let body = `<h2>${esc(course.title)}</h2><div>教材：${esc(tbTitle)} ｜ 状态：${course.status}</div><h3>对话记录</h3>`;
  course.dialogues.forEach((d) => { body += `<div><b>${d.role === 'user' ? '学员' : '苏格拉底'}</b>：${renderMD(d.content)}</div>`; });
  if (course.summary) {
    body += `<h3>课后总结</h3><p>已掌握：${course.summary.mastered.map(esc).join('、')}</p><p>薄弱：${course.summary.weak.map(esc).join('、')}</p><p>下一步：${course.summary.nextSteps.map(esc).join('；')}</p>`;
  }
  if (course.flashcards.length) {
    body += `<h3>闪卡</h3><ol>` + course.flashcards.map((f) => `<li><b>Q:</b> ${esc2(f.question)} <br><b>A:</b> ${esc2(f.answer)}</li>`).join('') + `</ol>`;
  }
  const wrap = document.createElement('div');
  wrap.style.padding = '24px'; wrap.style.background = '#fff';
  wrap.innerHTML = body;
  document.body.appendChild(wrap);
  window.html2pdf().set({ margin: 10, filename: course.title + '.pdf', html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4' } })
    .from(wrap).save().then(() => wrap.remove());
}

/* ----------------- 设置（全局人设 + BYO API + 数据备份） ----------------- */
async function renderSettings() {
  const state = Store.getState();
  const rawCfg = Store.getApiConfigRaw();
  const cfg = state.learner.apiConfig || {};
  const hasKey = !!(rawCfg && rawCfg.apiKey);
  let html = `<h2>设置</h2>
  <div class="card"><h3>全局默认教学者人设</h3>
    <textarea id="gp" placeholder="如：语气温和、善于用生活类比的引导者；可留空">${esc(state.learner.globalPersona || '')}</textarea>
    <div class="row" style="margin-top:8px"><button id="gp-save">保存全局人设</button><span class="muted">每教材可在教材页覆盖</span></div>
  </div>
  <div class="card">
    <h3>自带 AI API（BYO）</h3>
    <p class="muted" style="margin:4px 0 10px">${hasKey ? '已配置你自己的 Key（点击下方按钮可查看 / 修改）。' : '默认走内置演示模式；想让 Socratopia 用你自有的 LLM Key，请点下方按钮填入。'}</p>
    <div class="row">
      <button id="open-byo" class="primary">${hasKey ? '查看 / 修改 API Key' : '用自己的 API Key'}</button>
      <span class="muted" id="byo-summary">${hasKey ? `当前：${esc(cfg.provider || '?')} · ${esc(cfg.model || '(默认模型)')}` : '未配置'}</span>
    </div>
  </div>
  <div class="card">
    <h3>数据备份（全部用户数据，不含 API Key）</h3>
    <p class="muted" style="margin:4px 0 10px">数据仅存本浏览器（localStorage）。换浏览器 / 清缓存会丢，请定期导出备份；导入时若与现有数据冲突，会先提示你导出当前备份。</p>
    <div class="row">
      <button id="export-all" class="ghost">导出全部备份</button>
      <button id="import-all" class="ghost">导入备份</button>
      <input type="file" id="import-file" accept=".json,application/json" style="display:none" />
    </div>
    <div class="muted" id="backup-msg" style="margin-top:8px"></div>
  </div>
  <div class="card muted">数据说明：本应用为纯前端，所有教材 / 课程 / 进度 / 闪卡均存于你当前浏览器的 localStorage，不经过任何服务器。部署到 GitHub Pages 后，每位用户的数据都在各自浏览器中，Key 也只在本机，不进仓库、不泄露。</div>`;
  app().innerHTML = html;
  $('#gp-save').onclick = async () => { Store.updateGlobalPersona($('#gp').value); alert('已保存'); };
  $('#open-byo').onclick = () => openByoModal(rawCfg || {});
  $('#export-all').onclick = () => {
    const data = Store.exportAll();
    download('socratopia-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data, null, 2), 'application/json');
    $('#backup-msg').textContent = '已导出（不含 API Key）';
  };
  $('#import-all').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      const report = Store.previewImport(parsed);
      if (report.hasConflict) {
        openImportModal(parsed, report);
      } else {
        Store.commitImport(parsed);
        $('#backup-msg').textContent = '导入完成：' + report.note;
        router();
      }
    } catch (err) {
      $('#backup-msg').textContent = '导入失败：' + err.message;
    } finally {
      e.target.value = '';
    }
  };
}

function openByoModal(cfg) {
  const c = cfg || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-mask';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">用自己的 API Key</div>
      <div class="modal-sub">🔒 Key 仅存于本浏览器 localStorage，不经任何服务器、不进仓库，可随时清除。生产级隐私：数据完全在你自己设备上。</div>
      <label>Provider</label>
      <select id="mp-provider">
        <option value="deepseek" ${c.provider==='deepseek'?'selected':''}>DeepSeek</option>
        <option value="partner" ${c.provider==='partner'?'selected':''}>伙伴计划</option>
        <option value="kimi" ${c.provider==='kimi'?'selected':''}>Kimi</option>
        <option value="qwen" ${c.provider==='qwen'?'selected':''}>Qwen</option>
        <option value="custom" ${c.provider==='custom'?'selected':''}>自定义 OpenAI 兼容</option>
      </select>
      <label>Base URL</label><input id="mp-base" placeholder="https://.../v1" value="${esc(c.baseURL || '')}" />
      <label>API Key</label><input id="mp-key" type="password" placeholder="sk-..." value="${esc(c.apiKey || '')}" />
      <label>Model</label><input id="mp-model" placeholder="模型名" value="${esc(c.model || '')}" />
      <div class="row" style="margin-top:14px">
        <button class="ghost" id="mp-cancel">取消</button>
        <button class="primary" id="mp-save">保存并使用</button>
        <span class="muted" id="mp-msg"></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  $('#mp-cancel', overlay).onclick = () => overlay.remove();
  $('#mp-save', overlay).onclick = async () => {
    try {
      Store.updateApiConfig({
        provider: $('#mp-provider', overlay).value,
        baseURL: $('#mp-base', overlay).value,
        apiKey: $('#mp-key', overlay).value,
        model: $('#mp-model', overlay).value,
      });
      $('#mp-msg', overlay).textContent = '已保存（对话将使用你的 Key）';
      const summary = $('#byo-summary');
      if (summary) summary.textContent = `当前：${$('#mp-provider', overlay).value} · ${$('#mp-model', overlay).value || '(默认模型)'}`;
      const btn = $('#open-byo');
      if (btn && $('#mp-key', overlay).value) btn.textContent = '查看 / 修改 API Key';
      setTimeout(() => overlay.remove(), 600);
    } catch (e) {
      $('#mp-msg', overlay).textContent = '保存失败：' + (e.message || e);
    }
  };
}

/* 导入冲突确认 modal：建议先导出当前备份，再决定是否覆盖导入 */
function openImportModal(parsed, report) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-mask';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">导入将覆盖现有数据</div>
      <div class="modal-sub">检测到冲突：${esc(report.note)}</div>
      <p class="muted">为避免丢失当前浏览器里的数据，建议先点"导出当前备份"存一份；确认无误后再"确定导入"（将用备份替换现有全部数据，API Key 不覆盖）。</p>
      <div class="row">
        <button class="ghost" id="imp-export">① 导出当前备份</button>
        <button class="primary" id="imp-confirm">② 确定导入（覆盖）</button>
        <button class="ghost" id="imp-cancel">取消</button>
        <span class="muted" id="imp-msg"></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  $('#imp-cancel', overlay).onclick = () => overlay.remove();
  $('#imp-export', overlay).onclick = () => {
    const data = Store.exportAll();
    download('socratopia-backup-before-import-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data, null, 2), 'application/json');
    $('#imp-msg', overlay).textContent = '已导出当前备份，可安全导入';
  };
  $('#imp-confirm', overlay).onclick = () => {
    Store.commitImport(parsed);
    overlay.remove();
    router();
  };
}

/* ----------------- 启动 ----------------- */
(function init() {
  router();
})();
