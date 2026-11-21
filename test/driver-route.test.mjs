#!/usr/bin/env node
import assert from 'node:assert';
import { SessionDriver } from '../src/driver.js';

const driver = Object.create(SessionDriver.prototype);
driver.live = new Map();
driver.selections = new Map();

const events = [
  { type: 'turn/start', seq: 1, time: 100, data: { turn: 7 } },
  { type: 'request/header', seq: 2, time: 110, data: { header: { config: { provider: 'glm-coding', model: 'glm-5.3' } } } },
  { type: 'request/context', seq: 3, time: 111, data: { provider: 'glm-coding', model: 'glm-5.3' } },
  { type: 'llm/retry', seq: 4, time: 120, data: { provider: 'glm-coding', turn: 7, step: 1 } },
  { type: 'turn/end', seq: 5, time: 130, data: { turn: 7, reason: { kind: 'error' } } },
];
const session = { id: 's1', events };
const agent = { id: 's1', session };
driver.live.set('s1', { agent });
driver.selections.set('s1', { current: { provider: 'codex-gpt', model: 'gpt-6.1-sol' } });

const route = driver.modelForTerminalEvent(session, events[4]);
assert.deepEqual(route, { provider: 'glm-coding', model: 'glm-5.3', source: 'request/header' });
assert.equal(driver.turnStartedAt(session, events[4]), 100);

const noHeader = {
  id: 's2',
  events: [
    { type: 'turn/start', seq: 1, time: 200, data: { turn: 8 } },
    { type: 'request/context', seq: 2, time: 210, data: { provider: 'codex-gpt', model: 'gpt-6-luna' } },
    { type: 'turn/end', seq: 3, time: 220, data: { turn: 8, reason: { kind: 'error' } } },
  ],
};
assert.deepEqual(driver.modelForTerminalEvent(noHeader, noHeader.events[2]), {
  provider: 'codex-gpt', model: 'gpt-6-luna', source: 'request/context',
});

console.log('PASS terminal error route uses durable request evidence');
