/** A4 deterministic reviewer seam; no browser, network, or model dependencies. */
import { parseAuditorVerdict } from './protocol.js';
import { ProtocolParseError } from './errors.js';

export class FakeWebAuditRunner {
  constructor({ script = [] } = {}) { this.script = [...script]; this.calls = []; }

  async review(packet) {
    this.calls.push(packet);
    if (!packet?.runId || !packet?.stage || !packet?.iteration || !packet?.targetCommit) {
      throw Object.assign(new Error('audit packet is incomplete'), { code: 'AUDIT_PACKET_INVALID' });
    }
    if (!this.script.length) throw Object.assign(new Error('fake reviewer script exhausted'), { code: 'AUDIT_REVIEWER_SCRIPT_EXHAUSTED' });
    const next = this.script.shift();
    const text = typeof next === 'string' ? next : next.text;
    if (!text) throw Object.assign(new Error('fake reviewer returned no verdict'), { code: 'AUDIT_VERDICT_MISSING' });
    let verdict;
    try { verdict = parseAuditorVerdict(text); }
    catch (e) {
      if (e instanceof ProtocolParseError) throw Object.assign(new Error('fake reviewer returned malformed verdict'), { code: 'AUDIT_VERDICT_MALFORMED', cause: e });
      throw e;
    }
    return verdict;
  }
}
