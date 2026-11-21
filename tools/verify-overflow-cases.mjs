#!/usr/bin/env node
// Case 3 requires usage.output === 0, but the real session shows output=1.
// So some OTHER check fired. Test Case 2 and Case 1 explicitly.
import { isContextOverflow } from '@earendil-works/pi-ai';

console.log('=== Case 2: stopReason="stop" and input+cacheRead > contextWindow ===');
for (const win of [65536, 200000]) {
  const m = { stopReason: 'stop', usage: { input: 170000, cacheRead: 0 } };
  console.log(`  win=${win} used=170000 -> ${isContextOverflow(m, win)}`);
}

console.log('\n=== Case 3 strict: needs usage.output === 0 ===');
for (const out of [0, 1]) {
  for (const win of [65536, 200000]) {
    const m = { stopReason: 'length', usage: { input: 47, cacheRead: 166272, output: out } };
    console.log(`  out=${out} win=${win} used=166319 -> ${isContextOverflow(m, win)}`);
  }
}

console.log('\n=== Case 1: stopReason="error" + matching message ===');
const errMsgs = [
  'context_length_exceeded: This prompt contains 373,786 inline characters, which exceeds the maximum',
  'InternalError.Algo.InvalidParameter',
  'Range of input length should be [1, X]',
];
for (const msg of errMsgs) {
  const m = { stopReason: 'error', errorMessage: msg, usage: { input: 1, cacheRead: 0 } };
  console.log(`  ${isContextOverflow(m, 65536)} <- ${msg.slice(0, 70)}`);
}