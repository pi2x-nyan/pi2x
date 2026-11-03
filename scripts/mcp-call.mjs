// Minimal generic MCP stdio client (transport only) for driving
// `computer-use-linux mcp`. Not an implementation of computer use itself.
// usage:
//   node mcp-call.mjs list
//   node mcp-call.mjs call <tool> '<json args>' [--save-image /path.png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BIN = process.env.CU_BIN || 'computer-use-linux';
const [, , mode, tool, argsJson] = process.argv;
const saveIdx = process.argv.indexOf('--save-image');
const saveTo = saveIdx > 0 ? process.argv[saveIdx + 1] : null;

const child = spawn(BIN, ['mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
});

let buf = '';
const pending = new Map();
const messages = [];

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else {
      messages.push(msg);
    }
  }
});

let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;
  child.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout on ${method}\nstderr: ${stderr.slice(-2000)}`));
      }
    }, 120000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function summarise(result) {
  const out = { isError: result.isError === true, text: null, images: [] };
  for (const c of result.content || []) {
    if (c.type === 'text') out.text = out.text ? out.text + '\n' + c.text : c.text;
    if (c.type === 'image') {
      out.images.push({ mimeType: c.mimeType, bytes: Buffer.from(c.data, 'base64').length, data: c.data });
    }
  }
  if (saveTo && out.images.length) {
    fs.writeFileSync(saveTo, Buffer.from(out.images[0].data, 'base64'));
    out.savedImage = saveTo;
  }
  for (const im of out.images) delete im.data;
  return out;
}

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pi2x-verify', version: '1.0.0' },
  });
  notify('notifications/initialized', {});

  if (mode === 'list') {
    const r = await rpc('tools/list', {});
    console.log(JSON.stringify({ ok: true, tools: (r.tools || []).map((t) => t.name) }, null, 1));
  } else if (mode === 'call') {
    const args = argsJson ? JSON.parse(argsJson) : {};
    const r = await rpc('tools/call', { name: tool, arguments: args });
    const s = summarise(r);
    console.log(JSON.stringify({ ok: !s.isError, tool, ...s }, null, 1));
    if (s.isError) process.exitCode = 2;
  } else {
    console.error('usage: mcp-call.mjs list | call <tool> \'<json>\' [--save-image path]');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 3;
} finally {
  child.stdin.end();
  setTimeout(() => {
    child.kill('SIGKILL');
    process.exit(process.exitCode || 0);
  }, 300);
}
