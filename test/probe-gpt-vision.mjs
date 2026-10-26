// probe-gpt-vision.mjs — test whether codex-proxy /chat/completions accepts image_url input
const KEY = process.env.CODEX_PROXY_API_KEY;
if (!KEY) { console.log('NO_KEY'); process.exit(1); }
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const models = ['gpt-6.1-sol', 'gpt-6-luna'];
for (const model of models) {
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: PNG_1PX } },
            { type: 'text', text: '这张图片里有什么？一句话回答。' },
          ],
        }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    const body = await res.text();
    if (!res.ok) {
      console.log(`[${model}] HTTP ${res.status} (${Date.now() - t0}ms): ${body.slice(0, 300)}`);
    } else {
      let j; try { j = JSON.parse(body); } catch {}
      const content = j?.choices?.[0]?.message?.content;
      console.log(`[${model}] HTTP 200 (${Date.now() - t0}ms) content=${content ? JSON.stringify(content.slice(0, 200)) : 'EMPTY'} finish=${j?.choices?.[0]?.finish_reason}`);
    }
  } catch (e) {
    console.log(`[${model}] EXC (${Date.now() - t0}ms): ${e.message}`);
  }
}
