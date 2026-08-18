/**
 * Mock transport — same interface as the real one, fully in-process.
 *
 * Two modes:
 *  • script mode: DSH_FEISHU_SCRIPT=<json> runs a scenario (text messages,
 *    button clicks with wait-for-card, delays) and writes every card/text the
 *    bridge produced to DSH_FEISHU_OUT, then exits the process. This is the
 *    offline end-to-end test path.
 *  • REPL mode (no script): stdin lines become user messages — handy for
 *    driving the real bridge by hand without Feishu credentials.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { sleep } from '../util.js';
import { log } from '../log.js';

let seq = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export class MockTransport {
  constructor(config) {
    this.kind = 'mock';
    this.config = config;
    this.handlers = null;
    /** every outbound item: {kind, chatId, messageId, at, card?, text?, versions:[]} */
    this.sent = [];
    this.byMessageId = new Map();
    this.defaultChat = 'oc_mock_p2p';
    this.defaultOpen = 'ou_mock_me';
  }

  async start(handlers) {
    this.handlers = handlers;
    const script = process.env.DSH_FEISHU_SCRIPT;
    if (script) {
      const steps = JSON.parse(fs.readFileSync(script, 'utf8'));
      // let the rest of the tree settle before firing user input
      setTimeout(() => this.#runScript(steps).catch((e) => this.#fail(e)), 300);
    } else {
      this.#repl().catch((e) => log.error(`mock repl: ${e.message}`));
    }
  }

  async stop() {}

  // ------------------------------------------------------------ outbound

  async sendCard(chatId, card) {
    const messageId = nextId('msg');
    const item = { kind: 'card', chatId, messageId, at: Date.now(), card, versions: [] };
    this.sent.push(item);
    this.byMessageId.set(messageId, item);
    return { messageId };
  }

  async updateCard(messageId, card) {
    const item = this.byMessageId.get(messageId);
    if (!item) throw new Error(`mock: unknown messageId ${messageId}`);
    item.card = card;
    item.versions.push({ at: Date.now() });
    return { messageId };
  }

  async sendText(chatId, text) {
    const messageId = nextId('msg');
    this.sent.push({ kind: 'text', chatId, messageId, at: Date.now(), text });
    return { messageId };
  }

  // ------------------------------------------------------------ inbound (script/repl)

  async #runScript(steps) {
    for (const step of steps) {
      if (step.wait) {
        await sleep(step.wait);
        continue;
      }
      if (step.text !== undefined) {
        await this.userMessage({ text: step.text, chatId: step.chatId, openId: step.openId });
        continue;
      }
      if (step.click) {
        await this.#click(step.click);
        continue;
      }
      if (step.resumeFromBindings !== undefined) {
        const bindings = JSON.parse(fs.readFileSync(`${this.config.dataDir}/bindings.json`, 'utf8'));
        const entries = Object.values(bindings);
        const target = entries[step.resumeFromBindings];
        if (!target?.sessionId) throw new Error('resumeFromBindings: no such binding');
        await this.userMessage({ text: `/resume ${target.sessionId.replace(/^session-/, '').slice(0, 8)}` });
        continue;
      }
      throw new Error(`unknown script step: ${JSON.stringify(step).slice(0, 80)}`);
    }
    await sleep(Number(process.env.DSH_FEISHU_TAIL_WAIT || 600));
    this.#writeOut();
    log.info('mock script complete');
    if (process.env.DSH_FEISHU_MOCK_EXIT !== '0') process.exit(0);
  }

  async userMessage({ text, chatId, openId, messageId }) {
    if (!this.handlers) throw new Error('mock: not started');
    const msg = {
      chatId: chatId ?? this.defaultChat,
      openId: openId ?? this.defaultOpen,
      messageId: messageId ?? nextId('in'),
      text,
    };
    await this.handlers.onMessage(msg);
  }

  async #click({ bridge, label, decision, chatId }) {
    // wait until a card carrying the wanted button value exists
    for (let i = 0; i < 200; i++) {
      const value = this.#findActionValue({ bridge, label, decision, chatId });
      if (value) {
        await this.handlers.onCardAction({ value, openId: this.defaultOpen });
        return;
      }
      await sleep(50);
    }
    throw new Error(`mock: button not found: ${JSON.stringify({ bridge, label, decision })}`);
  }

  #findActionValue({ bridge, label, decision, chatId }) {
    for (const item of this.sent) {
      if (item.kind !== 'card') continue;
      if (chatId && item.chatId !== chatId) continue;
      for (const el of item.card?.elements ?? []) {
        for (const action of el.actions ?? []) {
          const v = action.value ?? {};
          if (v.bridge === bridge) {
            if (bridge === 'ask' && (label === undefined || v.label === label)) return v;
            if (bridge === 'approval' && (decision === undefined || v.decision === decision)) return v;
          }
        }
      }
    }
    return null;
  }

  async #repl() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    log.info('mock REPL: 每行作为一条用户消息；Ctrl-D 退出');
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      this.userMessage({ text }).catch((e) => log.error(`repl: ${e.message}`));
    });
  }

  #writeOut() {
    const out = process.env.DSH_FEISHU_OUT;
    if (!out) return;
    fs.mkdirSync(new URL('.', `file://${out}`).pathname, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(this.sent, null, 1));
  }

  #fail(e) {
    log.error(`mock script failed: ${e.stack ?? e}`);
    this.#writeOut();
    process.exit(1);
  }
}
