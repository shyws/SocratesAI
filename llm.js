'use strict';
/* BYO 直连 LLM（OpenAI 兼容 /chat/completions）。
   纯前端：Key 只存浏览器 localStorage，不经任何服务器，不进仓库。 */
window.LLM = (function () {
  /** 直接调用用户自填的 OpenAI 兼容接口。
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} opts { temperature, max_tokens }
   * @param {object} apiConfig { baseURL, apiKey, model }
   * @returns {Promise<{content:string,provider:string}>} */
  async function chat(messages, opts, apiConfig) {
    if (!apiConfig || !apiConfig.apiKey || !apiConfig.apiKey.trim()) {
      throw new Error('未配置 API Key');
    }
    const baseURL = (apiConfig.baseURL || '').replace(/\/+$/, '');
    if (!baseURL) throw new Error('未配置 Base URL（如 https://api.deepseek.com/v1）');
    const url = baseURL + '/chat/completions';
    const body = {
      model: apiConfig.model || 'deepseek-chat',
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
    return { content, provider: 'byo:' + (apiConfig.provider || 'custom') };
  }
  return { chat };
})();
