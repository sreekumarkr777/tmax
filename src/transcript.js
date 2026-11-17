// Context gauge: read the tail of the session transcript (JSONL) and find the
// most recent assistant message's token usage. input + cache reads + cache
// writes ≈ how much of the context window the conversation currently fills.
const fs = require('fs');

const TAIL_BYTES = 256 * 1024;

function readContextUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"usage"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.isSidechain) continue; // subagent traffic doesn't fill the main context
      const u = obj.message && obj.message.usage;
      if (!u) continue;
      const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (!used) continue;
      return { used, model: obj.message.model || null };
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return null;
}

module.exports = { readContextUsage };
