// test-vision-chain.mjs — end-to-end engine-chain test against the REAL config.json
import { readFileSync } from 'node:fs';
import { resolveVisionEngines, callVisionWithFallback } from '../src/vision-tool.js';

const cfg = JSON.parse(readFileSync('C:/Users/pc/.dsh/feishu/config.json', 'utf-8')).vision;
const engines = resolveVisionEngines(cfg);
console.log('chain:', engines.map((e) => e.model).join(' -> '));

const PNG = 'data:image/png;base64,' + readFileSync(new URL('./vision-test-256.png', import.meta.url)).toString('base64');
const t0 = Date.now();
try {
  const { answer, engine } = await callVisionWithFallback(engines, PNG, '这张图片里有什么？一句话。', undefined);
  console.log(`SUCCESS via ${engine.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('answer:', answer.slice(0, 200));
} catch (e) {
  console.log(`ALL FAILED in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message.slice(0, 400)}`);
}
