/**
 * dialog 沙盒的出口代理：只放行公网，拦掉内网/本机/云元数据
 *
 * 背景：dialog 沙盒被放进独立 netns（veth + 不转发），只能连到本代理；
 * 因此「能不能上网」完全由这里的目的地过滤决定。
 *
 * 支持的协议：
 *   - HTTP CONNECT（https / 任意 TCP 隧道）
 *   - 普通 HTTP 代理（GET http://host/...）
 *   - SOCKS5（CONNECT 命令，供 all_proxy=socks5h:// 使用）
 *
 * 过滤规则（拒绝）：回环、RFC1918、CGNAT(100.64/10)、链路本地(169.254，含云元数据
 *   169.254.169.254)、组播/保留、IPv6 的 ::1 / fe80:: / fc00:: / ff00::
 * 域名先解析再判断，连的是解析出来的 IP（防止解析后再变）。
 */
import net from "node:net";
import dns from "node:dns";
import http from "node:http";

const LISTEN_HOST = process.env.DLG_PROXY_HOST || "10.200.200.1";
const LISTEN_PORT = Number(process.env.DLG_PROXY_PORT || 3128);

function ipToLong(ip) {
  return ip.split(".").reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0;
}
const BLOCKS4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([b, m]) => [ipToLong(b), m]);

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const v = ipToLong(ip);
    return BLOCKS4.some(([base, mask]) => {
      const m = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
      return (v & m) >>> 0 === (base & m) >>> 0;
    });
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("ff")) return true;
    if (s.startsWith("::ffff:")) return isBlockedIp(s.slice(7));
    return false;
  }
  return true; // 不是合法 IP，一律拒绝
}

function resolvePublic(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err || !addrs?.length) return resolve(null);
      const ok = addrs.find((a) => !isBlockedIp(a.address));
      resolve(ok ? ok.address : null);
    });
  });
}

process.on("uncaughtException", (e) => log("UNCAUGHT", e?.message ?? String(e)));
process.on("unhandledRejection", (e) => log("UNHANDLED", e?.message ?? String(e)));

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

const server = http.createServer(async (req, res) => {
  // 普通 HTTP 代理
  let u;
  try {
    u = new URL(req.url);
  } catch {
    res.writeHead(400).end("bad url");
    return;
  }
  const ip = await resolvePublic(u.hostname);
  if (!ip) {
    log("DENY", u.hostname);
    res.writeHead(403).end("blocked destination");
    return;
  }
  const p = new URL(req.url);
  const plainPort = parsePort(p.port, 80);
  if (plainPort === null) {
    log("BAD-REQ", "plain", req.url.slice(0, 80));
    res.writeHead(400).end("bad port");
    return;
  }
  const up = http.request(
    { host: ip, port: plainPort, path: p.pathname + p.search, method: req.method, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    log("ERR", u.hostname, e.message);
    res.writeHead(502).end("upstream error");
  });
  req.pipe(up);
});

/** 严格端口解析：只接受 1..65535 的整数，其余一律 400（strix 扫出的 HIGH：
 *  `CONNECT host:abc` 会让 Number("abc")=NaN 一路走到 net.connect 抛 RangeError，
 *  未捕获 → 整个代理进程退出，所有访客一起断网）。 */
function parsePort(p, dflt = 443) {
  const s = String(p ?? "").trim();
  if (s === "") return dflt;
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

server.on("connect", async (req, socket, head) => {
  const idx = String(req.url).lastIndexOf(":");
  const host = idx > 0 ? String(req.url).slice(0, idx) : String(req.url);
  const port = parsePort(idx > 0 ? String(req.url).slice(idx + 1) : "");
  if (!host || port === null) {
    log("BAD-REQ", String(req.url).slice(0, 80));
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const ip = await resolvePublic(host);
  if (!ip) {
    log("DENY", host);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const up = net.connect({ host: ip, port }, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", (e) => {
    log("ERR", host, e.message);
    socket.destroy();
  });
  socket.on("error", () => up.destroy());
});

// SOCKS5（最小实现：只支持 CONNECT，无认证）
server.on("connection", (sock) => {
  sock.once("data", async (buf) => {
    if (buf[0] !== 0x05) return; // 非 SOCKS5，交给 http 处理器（已在上面挂过）
    sock.write(Buffer.from([0x05, 0x00])); // 无需认证
    sock.once("data", async (req2) => {
      const atyp = req2[3];
      let host = "";
      let off = 4;
      if (atyp === 0x01) {
        host = `${req2[4]}.${req2[5]}.${req2[6]}.${req2[7]}`;
        off = 8;
      } else if (atyp === 0x03) {
        const len = req2[4];
        host = req2.slice(5, 5 + len).toString("utf8");
        off = 5 + len;
      } else if (atyp === 0x04) {
        sock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      } else {
        sock.end();
        return;
      }
      const port = req2.readUInt16BE(off);
      if (!(port >= 1 && port <= 65535)) {
        sock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const ip = await resolvePublic(host);
      if (!ip) {
        log("DENY", host);
        sock.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const up = net.connect({ host: ip, port }, () => {
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        sock.pipe(up).pipe(sock);
      });
      up.on("error", () => sock.destroy());
      sock.on("error", () => up.destroy());
    });
  });
});

server.on("error", (e) => {
  log("LISTEN-FAIL", e.message);
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`dlg-proxy listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
