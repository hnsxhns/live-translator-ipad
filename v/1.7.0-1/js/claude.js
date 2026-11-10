// Claude API straight from the browser (Anthropic allows this with the direct-browser-access header).

export const MODEL = "claude-opus-5-5";
const API = "https://api.anthropic.com/v1";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";   // refusal fallback: route to another model

export class ClaudeError extends Error {
  constructor(status, type, message) {
    super(message || type || `HTTP ${status}`);
    this.status = status;
    this.type = type || "";
  }
}

function headers(apiKey, extra = {}) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    ...extra,
  };
}

async function errorFrom(res) {
  let type = "", msg = "";
  try {
    const j = await res.json();
    type = j?.error?.type || "";
    msg = j?.error?.message || "";
  } catch { /* not JSON */ }
  return new ClaudeError(res.status, type, msg);
}

/** Checks that the key works (same as models.list(limit=1) on desktop). */
export async function checkKey(apiKey) {
  const res = await fetch(`${API}/models?limit=1`, { headers: headers(apiKey) });
  if (!res.ok) throw await errorFrom(res);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream a Claude reply; returns the full text. Retries once without the fallback option if rejected,
 * and once more on rate limits / overload / network errors (like the SDK's max_retries=1).
 * `prompt` is either the user's text or a full list of messages (multi-turn chat).
 */
export async function claudeStream(apiKey, { system, prompt, effort, onPiece, model, thinking, maxTokens = 4000 }) {
  const messages = Array.isArray(prompt) ? prompt : [{ role: "user", content: prompt }];
  const m = model || MODEL;
  for (const useFallback of [true, false]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = { model: m, max_tokens: maxTokens, system, messages, stream: true,
                     output_config: { effort } };
      if (thinking) body.thinking = thinking;
      const extra = {};
      if (useFallback && !m.startsWith("claude-haiku")) {     // Haiku has no fallback
        body.fallbacks = "default";
        extra["anthropic-beta"] = FALLBACK_BETA;
      }
      let out = "";
      try {
        const res = await fetch(`${API}/messages`, { method: "POST", headers: headers(apiKey, extra),
                                                     body: JSON.stringify(body) });
        if (!res.ok) throw await errorFrom(res);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const event = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              let data;
              try { data = JSON.parse(line.slice(5)); } catch { continue; }
              if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
                out += data.delta.text;
                onPiece?.(data.delta.text);
              } else if (data.type === "error") {
                throw new ClaudeError(0, data.error?.type, data.error?.message);
              }
            }
          }
        }
        return out;
      } catch (e) {
        const msg = String(e?.message || e).toLowerCase();
        // only the optional fallback setting is worth retrying without
        if (useFallback && !out && e instanceof ClaudeError && e.status === 400 && msg.includes("fallback")) break;
        const retryable = !out && attempt === 0 && (!(e instanceof ClaudeError) || e.status === 429 ||
                          e.status >= 500 || e.type === "overloaded_error");
        if (retryable) { await sleep(1500); continue; }
        throw e;
      }
    }
  }
  return "";
}

/** Claude API errors -> short Vietnamese explanation. */
export function friendlyError(e) {
  const s = String(e?.message || e).toLowerCase();
  if (s.includes("credit balance")) {
    return ("Tài khoản API hết credit ($0). Gói Ultra có $200/tháng: vào claude.ai → Settings → Billing → " +
            "API credits → Link organization, rồi dùng API key của đúng tổ chức đó.");
  }
  if (e instanceof ClaudeError) {
    if (e.status === 401) return "API key không còn hợp lệ. Hãy đăng nhập lại.";
    if (e.status === 403) return "Tài khoản không có quyền dùng model này.";
    if (e.status === 429) return "Đang gửi quá nhiều yêu cầu (rate limit). Ứng dụng sẽ tự thử lại.";
    return `Lỗi Claude: ${String(e.message).slice(0, 160)}`;
  }
  if (e instanceof TypeError) return "Mất kết nối tới Claude. Kiểm tra mạng.";
  return `Lỗi Claude: ${String(e?.message || e).slice(0, 160)}`;
}
