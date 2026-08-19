'use strict';
/* BYO 直连 LLM（OpenAI 兼容 /chat/completions）。
   纯前端：Key 只存浏览器 localStorage，不经任何服务器，不进仓库。
   默认端点采用 DeepSeek（与「AI 题库」小程序实现一致）：用户只需在设置页填入
   自己的 DeepSeek API Key 即可使用，Base URL 与模型已内置、无需手填。
   若用户曾显式填过 baseURL / model（旧数据），仍可兼容沿用。 */
window.LLM = (function () {
  // 内置默认端点（用户只需填 Key）
  const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
  const DEFAULT_MODEL = 'deepseek-chat';
  /** 直接调用用户自填的 OpenAI 兼容接口。
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} opts { temperature, max_tokens }
   * @param {object} apiConfig { baseURL, apiKey, model }
   * @returns {Promise<{content:string,provider:string}>} */
  async function chat(messages, opts, apiConfig) {
    if (!apiConfig || !apiConfig.apiKey || !apiConfig.apiKey.trim()) {
      throw new Error('未配置 API Key');
    }
    // 优先用用户显式填的 Base URL，否则回落内置默认值
    const baseURL = (apiConfig.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = apiConfig.model || DEFAULT_MODEL;
    const url = baseURL + '/chat/completions';
    const body = {
      model,
      messages,
      temperature: opts && opts.temperature != null ? opts.temperature : 0.7,
      max_tokens: opts && opts.max_tokens != null ? opts.max_tokens : 1200,
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiConfig.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
      throw new Error(`HTTP ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    const content = data.choices && data.choices[0] ? data.choices[0].message.content : '';
    return { content, provider: 'byo:' + (apiConfig.provider || 'deepseek') };
  }
  return { chat };
})();
