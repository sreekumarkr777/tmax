// Token + cost meter: reads a session's transcript (JSONL) incrementally and adds up
// what every assistant reply used. Cost is what the same tokens would cost at
// Anthropic API list prices; on a Claude subscription it's a "value used" estimate.
const fs = require('fs');

// $ per million tokens: [input, output, cache read]. Cache writes bill at 1.25× input.
const PRICES = [
  [/fable-5-2|mythos-5-2/, [8, 40, 0.2]],
  [/fable|mythos/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-(5|4)/, [5, 25, 0.5]],
  [/sonnet-5-5/, [2, 10, 0.1]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-5-5/, [0.1, 0.5, 0.01]],
  [/haiku/, [1, 5, 0.1]],
];
const FALLBACK = [4, 20, 0.2];

function priceFor(model = '') {
  const m = String(model).toLowerCase();
  for (const [re, p] of PRICES) if (re.test(m)) return p;
  return FALLBACK;
}

function costOf(u, model) {
  const [pin, pout, pread] = priceFor(model);
  return ((u.input_tokens || 0) * pin + (u.cache_creation_input_tokens || 0) * pin * 1.25 +
    (u.cache_read_input_tokens || 0) * pread + (u.output_tokens || 0) * pout) / 1e6;
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, replies: 0, model: null, days: {} };
}

/**
 * Add any new lines of `file` to `meter` ({ offset, seen, usage, file }).
 * Returns true when the totals changed.
 */
function readUsage(meter, file) {
  if (!file) return false;
  if (meter.file !== file) { meter.file = file; meter.offset = 0; meter.seen = new Set(); meter.usage = emptyUsage(); meter.rest = ''; }
  let fd;
  let changed = false;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    if (size < meter.offset) { meter.offset = 0; meter.seen = new Set(); meter.usage = emptyUsage(); meter.rest = ''; }
    if (size === meter.offset) return false;
    const buf = Buffer.alloc(size - meter.offset);
    fs.readSync(fd, buf, 0, buf.length, meter.offset);
    meter.offset = size;
    const text = meter.rest + buf.toString('utf8');
    const lines = text.split('\n');
    meter.rest = lines.pop() || '';
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj.message;
      const u = msg && msg.usage;
      if (!u || obj.type !== 'assistant') continue;
      // one reply is written as several lines (one per content block) carrying the same usage
      const key = (msg.id || '') + ':' + (obj.requestId || '');
      if (meter.seen.has(key)) continue;
      meter.seen.add(key);
      const U = meter.usage;
      const c = costOf(u, msg.model);
      U.input += u.input_tokens || 0;
      U.output += u.output_tokens || 0;
      U.cacheRead += u.cache_read_input_tokens || 0;
      U.cacheWrite += u.cache_creation_input_tokens || 0;
      U.cost += c;
      U.replies++;
      if (msg.model && !/synthetic/.test(msg.model)) U.model = msg.model;
      const day = dayKey(obj.timestamp ? Date.parse(obj.timestamp) || Date.now() : Date.now());
      const D = U.days[day] || (U.days[day] = { tokens: 0, cost: 0 });
      D.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      D.cost += c;
      changed = true;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return changed;
}

module.exports = { readUsage, emptyUsage, priceFor, costOf, dayKey };
