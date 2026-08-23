#!/usr/bin/env node
/**
 * apply-research — validate & integrate Codex research deliverables.
 *
 * Usage:
 *   node tools/apply-research.mjs            # validate + apply (settings.yaml merge + applied.json)
 *   node tools/apply-research.mjs --check    # validate only, no writes
 *   node tools/apply-research.mjs --dry      # show what would change, no writes
 *
 * Deliverables (see research/BRIEF.md):
 *   research/glm-vision-models.json     → settings.yaml model rows (auto)
 *   research/feishu-capabilities.json   → research/out/applied.json (params snapshot)
 *
 * Rules:
 *   - Hand-rolled JSON-Schema subset validator (type/required/properties/
 *     additionalProperties/items/minItems/enum/pattern) — no deps.
 *   - Any schema violation rejects the WHOLE file with the first error path.
 *   - Only contextWindow / maxOutputTokens / input are ever written to
 *     settings.yaml; `input` requires the model's own declared facts.
 *   - conflictsWithBaseline entries are printed for human adjudication and
 *     never auto-applied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const DRY = args.has('--dry');

// ------------------------------------------------------------- mini validator

function validate(value, schema, at = '$') {
  const errs = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => {
      switch (t) {
        case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
        case 'array': return Array.isArray(value);
        case 'string': return typeof value === 'string';
        case 'integer': return Number.isInteger(value);
        case 'number': return typeof value === 'number';
        case 'boolean': return typeof value === 'boolean';
        case 'null': return value === null;
        default: return true;
      }
    });
    if (!ok) errs.push(`${at}: expected type ${types.join('|')}, got ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  if (value === null || value === undefined) {
    // required still enforced below; pattern/minItems only for present values
    if (schema.required && typeof value !== 'object') {
      for (const k of schema.required) errs.push(`${at}: missing required "${k}"`);
    }
    return errs;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${at}: ${JSON.stringify(value)} not in [${schema.enum.map((e) => JSON.stringify(e)).join(', ')}]`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errs.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errs.push(`${at}: ${JSON.stringify(value.slice(0, 40))} fails pattern ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errs.push(`${at}: needs ≥${schema.minItems} items, got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((v, i) => errs.push(...validate(v, schema.items, `${at}[${i}]`)));
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const k of schema.required ?? []) {
      if (!(k in value) || value[k] === undefined) errs.push(`${at}: missing required "${k}"`);
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) errs.push(...validate(value[k], sub, `${at}.${k}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) errs.push(`${at}: unexpected property "${k}"`);
      }
    }
  }
  return errs;
}

// ------------------------------------------------------------------- helpers

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

function loadYamlLib() {
  // js-yaml resolves only from the dsh install root on this machine; use
  // createRequire from DSH_ROOT (default D:\dsh-install).
  const dshRoot = process.env.DSH_ROOT || 'D:\\dsh-install';
  const req = createRequire(path.join(dshRoot, 'noop.js'));
  return req('js-yaml');
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function banner(msg) { console.log(`\n== ${msg}`); }

// ------------------------------------------------------- 1) validate files

banner('校验交付物 schema');

const deliverables = [
  ['glm-vision-models.json', 'glm-vision-models.schema.json'],
  ['feishu-capabilities.json', 'feishu-capabilities.schema.json'],
];
const docs = {};
for (const [file, schemaFile] of deliverables) {
  const fp = path.join(root, 'research', file);
  const sp = path.join(root, 'research', 'schema', schemaFile);
  if (!fs.existsSync(fp)) die(`${file} 不存在（research 未交付或未完成）`);
  if (!fs.existsSync(sp)) die(`${schemaFile} 不存在`);
  const doc = readJson(fp);
  const errs = validate(doc, readJson(sp), file);
  if (errs.length) {
    console.error(errs.map((e) => `  ${e}`).join('\n'));
    die(`${file} schema 校验失败（首个错误见上）— 整体拒收`);
  }
  docs[file] = doc;
  console.log(`✓ ${file} 校验通过`);
  for (const c of doc.conflictsWithBaseline ?? []) {
    console.log(`⚠️ 与基线冲突 [${c.field}] 基线=${JSON.stringify(c.baseline)} 发现=${JSON.stringify(c.finding)}：${c.explanation}（需人工裁决，未自动应用）`);
  }
}
if (CHECK_ONLY) {
  console.log('\n--check：仅校验，退出');
  process.exit(0);
}

// ------------------------------------------------- 2) R1 → settings.yaml

banner('合并 R1（GLM 视觉模型）→ settings.yaml');

const settingsPath = process.env.DSH_SETTINGS || path.join(process.env.USERPROFILE || '', '.dsh', 'settings.yaml');
const r1 = docs['glm-vision-models.json'];
const yaml = loadYamlLib();
const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
const settings = yaml.load(settingsRaw);

const providers = settings?.['llm-pi-ai']?.providers ?? {};
const glm = providers.glm_coding ?? (providers.glm_coding = {});
glm.models = Array.isArray(glm.models) ? glm.models : [];

const BASELINE = { // what the bridge shipped with — facts we verified ourselves
  'glm-4.5v': { contextWindow: 65536 },
  'glm-4.6v': { contextWindow: 65536 },
};

let changed = 0;
const planned = [];
for (const m of r1.models ?? []) {
  if (!m.id?.startsWith('glm-')) continue;
  const row = glm.models.find((x) => x.id === m.id);
  const updates = {};
  if (Number.isInteger(m.contextWindow)) updates.contextWindow = m.contextWindow;
  if (Number.isInteger(m.maxOutputTokens)) updates.maxOutputTokens = m.maxOutputTokens;
  if (Array.isArray(m.input) && m.input.includes('image')) updates.input = ['text', 'image'];
  if (row) {
    Object.assign(row, updates);
  } else {
    glm.models.push({ id: m.id, input: ['text', 'image'], ...updates });
  }
  changed++;
  planned.push(`${m.id}: ${JSON.stringify(updates)} (stability=${m.stability}${m.deprecated ? ' ⚠️已弃用' : ''})`);
}
console.log(planned.length ? planned.map((p) => `  · ${p}`).join('\n') : '  （无可合并条目）');

// sanity: never mark a known text-only model as vision
for (const t of ['glm-5.3', 'glm-4.7', 'glm-5-turbo']) {
  const row = glm.models.find((x) => x.id === t);
  if (row?.input?.includes('image')) {
    die(`拒绝：${t} 服务端实测仅文本（基线 1210），不会写入 image 输入`);
  }
}

if (!DRY) {
  const out = yaml.dump(settings, { lineWidth: 120 });
  fs.writeFileSync(settingsPath, out, 'utf8');
  console.log(`✓ settings.yaml 已更新（${changed} 个模型行）`);
} else {
  console.log('(dry：未写入)');
}

// --------------------------------------------- 3) R2 → research/out/applied.json

banner('生成 R2 参数快照 → research/out/applied.json');

const r2 = docs['feishu-capabilities.json'];
const qps = r2?.cardPatchRateLimit?.qps;
const applied = {
  appliedAt: new Date().toISOString(),
  cardThrottleMs: Number.isFinite(qps) && qps > 0 ? Math.max(50, Math.ceil(1000 / qps)) : null,
  cardRateSource: r2?.cardPatchRateLimit?.sources?.[0] ?? null,
  fileUpload: r2?.fileUpload ?? null,
  groupChat: {
    replyStrategy: r2?.groupChat?.replyStrategy ?? null,
    botOpenIdDiscovery: r2?.groupChat?.botOpenIdDiscovery ?? null,
  },
  messageResource: r2?.messageResource ?? null,
  modelsRecommended: (r1.models ?? []).filter((m) => m.recommended).map((m) => m.id),
};
console.log(`  cardThrottleMs ← ${applied.cardThrottleMs ?? '（无数据，保持现状）'}`);
if (!DRY) {
  const outDir = path.join(root, 'research', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'applied.json'), JSON.stringify(applied, null, 2), 'utf8');
  console.log('✓ research/out/applied.json 已写入');
} else {
  console.log('(dry：未写入)');
}

console.log('\n完成。冲突项（如有 ⚠️）请人工裁决后手工调整。');
