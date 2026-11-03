/**
 * QQ Bridge — OneBot11 WebSocket 客户端
 *
 * 连接 NapCat 的 OneBot11 WS 服务器：
 *  - 接收 post_type=message 事件（群聊/私聊）
 *  - 调用 send_group_msg / send_private_msg 等 API
 *  - 断线自动重连（携带真实退出时间戳的指数退避，便于观察）
 */
import { normalizeStyle as styleOut } from "./reply-guard.mjs";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { createLogger } from "./log.mjs";

const logQQ = createLogger("qq");

export class QQBridge extends EventEmitter {
  /** @param {{host:string, port:number, token:string}} opt */
  constructor({ host, port, token }) {
    super();
    this.host = host;
    this.port = port;
    this.token = token;
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = 1000;
    this.pending = new Map(); // echo -> {resolve, reject, timer}
    this._seq = 0;
    this._closing = false;
  }

  /** WS 地址：**不带 token**（凭据走 Authorization 头，避免进 URL） */
  wsUrl() {
    return `ws://${this.host}:${this.port}/`;
  }

  /** WS 连接选项：仅当配置了 token 才带鉴权头（未配置时保持无凭据行为） */
  wsOptions() {
    return this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      // 【为什么不再把 token 拼进 query】
      // 原先用 `?access_token=***`。即便 URL 本身不落日志，它也极易被中间层
      // （反向代理 access log、抓包、报错堆栈里回显的 URL）记下来 —— 凭据一旦
      // 进日志就等于泄露。改走 Authorization: Bearer 头后，URL 里不再有口令。
      // 实测 NapCat 的 OneBot11 WS 服务接受该头部，连接与鉴权都正常。
      const ws = new WebSocket(this.wsUrl(), this.wsOptions());
      this.ws = ws;
      ws.on("open", () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        logQQ.info(`已连接 NapCat OneBot11 @ ${this.host}:${this.port}`);
        resolve();
      });
      ws.on("message", (data) => this._onMessage(data));
      ws.on("close", () => {
        this.connected = false;
        this._rejectAllPending("连接关闭");
        logQQ.warn(`连接断开，${this.reconnectDelay / 1000}s 后重连...`);
        if (!this._closing) {
          setTimeout(() => this.connect().catch(() => {}), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        }
      });
      ws.on("error", (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  /** 调用 OneBot11 API */
  api(action, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) return reject(new Error("未连接 NapCat"));
      const echo = `pi2x_${++this._seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`API ${action} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendGroupMsg(groupId, message, messageId) {
    const params = { group_id: groupId, message: styleOut(message) };
    if (messageId) params.message_id = messageId;
    return this.api("send_group_msg", params);
  }

  sendPrivateMsg(userId, message) {
    return this.api("send_private_msg", { user_id: userId, message: styleOut(message) });
  }

  /** 上传文件到群（file=服务器本地绝对路径） */
  uploadGroupFile(groupId, file, name) {
    return this.api("upload_group_file", { group_id: groupId, file, name });
  }

  /** 上传文件到私聊（file=服务器本地绝对路径） */
  uploadPrivateFile(userId, file, name) {
    return this.api("upload_private_file", { user_id: userId, file, name });
  }

  /** 获取文件本地路径（OneBot11 get_file） */
  getFile(identifier) {
    return this.api("get_file", { file: identifier });
  }

  /** 群成员列表 */
  getGroupMemberList(groupId) {
    return this.api("get_group_member_list", { group_id: groupId });
  }

  /** 单个群成员信息（昵称/权限等） */
  getGroupMemberInfo(groupId, userId) {
    return this.api("get_group_member_info", { group_id: groupId, user_id: userId });
  }

  /** 群最近消息历史（count 条） */
  getGroupMsgHistory(groupId, count = 20) {
    return this.api("get_group_msg_history", { group_id: groupId, count });
  }

  /** 按 message_id 取消息详情 */
  getMsg(messageId) {
    return this.api("get_msg", { message_id: messageId });
  }

  /**
   * 取合并转发消息的正文（get_forward_msg）。
   *
   * OneBot11 里合并转发只给一个 id，正文需要再拉一次。返回结构随实现而异
   * （实测 NapCat 是 { messages: [...] }，部分实现是 { data: {...} }），
   * 调用方用 parseForwardMessages() 统一成 {谁, 什么}[] 更省心。
   */
  getForwardMsg(forwardId) {
    return this.api("get_forward_msg", { message_id: forwardId });
  }

  /** 撤回消息 */
  deleteMsg(messageId) {
    return this.api("delete_msg", { message_id: messageId });
  }

  /** 好友列表 */
  getFriendList() {
    return this.api("get_friend_list");
  }

  /** 群列表 */
  getGroupList() {
    return this.api("get_group_list");
  }

  /** 图片 OCR（file=图片文件标识/路径/url） */
  ocrImage(image) {
    return this.api("ocr_image", { image });
  }

  /** 群文件下载链接（配合 downloadFile 用） */
  getGroupFileUrl(groupId, fileId, busid) {
    return this.api("get_group_file_url", { group_id: groupId, file_id: fileId, busid });
  }

  /** 下载文件到本地（NapCat download_file，线程数可选） */
  downloadFile(url, threadCount = 3, timeoutMs = 60000) {
    return this.api("download_file", { url, thread_count: threadCount }, timeoutMs);
  }

  _onMessage(data) {
    let payload;
    try { payload = JSON.parse(data.toString()); } catch { return; }

    // API 响应（带 echo）
    if (payload.echo && this.pending.has(payload.echo)) {
      const { resolve, reject, timer } = this.pending.get(payload.echo);
      this.pending.delete(payload.echo);
      clearTimeout(timer);
      if (payload.status === "ok" || payload.retcode === 0) resolve(payload.data ?? {});
      else reject(new Error(`API 失败: ${payload.retcode} ${payload.message ?? ""}`));
      return;
    }

    // 事件
    this.emit("event", payload);
  }

  _rejectAllPending(reason) {
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** 从事件消息中提取纯文本 */
  static extractText(message) {
    if (typeof message === "string") return message;
    if (Array.isArray(message)) {
      return message
        .map((seg) => {
          if (seg.type === "text") return seg.data?.text ?? "";
          if (seg.type === "at") return `@${seg.data?.qq ?? "someone"}`;
          if (seg.type === "image") return "[图片]";
          if (seg.type === "face") return "[表情]";
          // 引用/回复段：带出被引用内容（NapCat reply 段 data.text = 被引用消息文本）
          if (seg.type === "reply") {
            const d = seg.data ?? {};
            const ref = typeof d.text === "string" && d.text ? d.text.slice(0, 80) : "";
            const id = d.id && d.id !== 0 ? ` id:${d.id}` : "";
            return ref ? `[引用“${ref}”${id}]` : `[引用${id}]`;
          }
          // 合并转发段：NapCat 只给 id/content，正文要用 get_forward_msg 另取。
          // 这里输出 `[转发 id:xxx]` 作为**取件凭据** —— 上层（bridge）据此把正文取回来。
          // 关键点：不要在这里直接返回 "[forward]" 之类的空标记，否则上层无从知道该拉哪个 id，
          // 内容会永久丢失（改动前的实际行为就是如此：合并转发只留下 [forward]，正文全丢）。
          if (seg.type === "forward") {
            const d = seg.data ?? {};
            const id = d.id ?? d.message_id ?? d.res_id ?? "";
            return id ? `[转发 id:${id}]` : "[转发]";
          }
          // 有些客户端把合并转发塞在 json 段里（app=com.tencent.multimsg），
          // 其 resId 藏在 JSON 字符串中 —— 抠出来同上处理，抠不到则保留 [json]。
          if (seg.type === "json" || seg.type === "xml") {
            const raw = seg.data?.data ?? seg.data?.xml ?? "";
            const m = /"resid"\s*:\s*"([^"]+)"/i.exec(String(raw)) || /resid="([^"]+)"/i.exec(String(raw));
            if (m) return `[转发 id:${m[1]}]`;
            return `[${seg.type}]`;
          }
          return `[${seg.type}]`;
        })
        .join("");
    }
    return String(message ?? "");
  }

  /**
   * 把 get_forward_msg 的返回统一解析成 [{ name, text }]。
   *
   * 【为什么要单独一个函数】各实现返回结构不一致：
   *   NapCat       → { messages: [ { sender:{nickname,card,user_id}, message:[段], time } ] }
   *   部分实现     → { data: { messages: [...] } }
   *   还有直接给数组的 → [ {...} ]
   * 上层不该关心这些差异。
   *
   * @param {unknown} res API 原始返回
   * @param {(m:unknown)=>string} segToText 段转文本（默认用 extractText）
   * @returns {{name:string, text:string}[]}
   */
  static parseForwardMessages(res, segToText = QQBridge.extractText) {
    const raw = res?.messages ?? res?.data?.messages ?? res?.data ?? (Array.isArray(res) ? res : []);
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const m of list) {
      if (!m || typeof m !== "object") continue;
      const sd = m.sender ?? m.data?.sender ?? {};
      const name = String(sd.card || sd.nickname || sd.user_id || m.nickname || "未知").trim();
      const body = m.message ?? m.content ?? m.data?.message ?? "";
      // 嵌套转发只标一层，避免无限递归拉取（真相是：多数客户端也禁止)
      let text = segToText(body);
      if (typeof text !== "string") text = String(text ?? "");
      // 【关键】把这一条里的图也抽出来。之前只拿文本，renderForward 把图渲成
      // 「[图片]」占位符就完事了 —— 模型看到的永远是个占位符，等于看不见图。
      const images = QQBridge.collectImageRefs(body);
      out.push({ name, text: text.trim(), images });
    }
    return out;
  }

  /**
   * 把转发内容渲染成给模型看的文本块（编号 + 可读换行）。
   *
   * 形如：
   *   〔转发消息 共 2 条〕
   *   〔第1条〕昵称: 你好
   *   〔第2条〕昵称: [图片]
   *
   * 【图片处理】如果条目带图，文本里除了 [图片] 占位符，还会附上
   * `<图片序号 N>` 标识（N 在全条转发下递增），与 parseForwardMessages
   * 产出的 images 数组同序 —— 上层据此把图片真正交给模型，而不是让模型
   * 只能看到一个“[图片]”而干瞪眼。
   *
   * @param {{name:string,text:string,images?:object[]}[]} items parseForwardMessages 的结果
   * @param {number} maxChars 总预算（超出截断，避免长转发把上下文撑爆）
   */
  static renderForward(items, maxChars = 2000) {
    if (!items?.length) return "〔转发消息（内容为空或已过期）〕";
    const lines = [`〔转发消息 共 ${items.length} 条〕`];
    let imgNo = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const who = it.name && it.name !== "未知" ? `${it.name}: ` : "";
      const n = it.images?.length ?? 0;
      const tags = n ? " " + Array.from({ length: n }, () => `<图片 ${++imgNo}>`).join(" ") : "";
      lines.push(`〔第${i + 1}条〕${who}${it.text || "（非文本）"}${tags}`);
    }
    let text = lines.join("\n");
    if (text.length > maxChars) text = text.slice(0, maxChars) + "…（转发内容过长，已截断）";
    return text;
  }

  /** 是否 @ 了消息中的 self_id */
  static isMentioned(message, selfId) {
    if (!Array.isArray(message)) return false;
    return message.some(
      (seg) => seg.type === "at" && (seg.data?.qq === String(selfId) || seg.data?.qq === "all"),
    );
  }

  /**
   * 是否 @ 了「全体成员」（NapCat 把 @全体成员 编码成 at 段且 qq==="all"）。
   *
   * 【为什么要单独判】@全体成员 是面向全群的公告，语义上不是「叫 bot」；
   * 但旧的 isMentioned 把 qq==="all" 也算命中，导致公告会把 bot 从潜水里拽醒。
   * 拆出来给上层做屏蔽，避免改动 isMentioned 的既有语义（别处可能依赖）。
   */
  static isAtAll(message) {
    if (!Array.isArray(message)) return false;
    return message.some((seg) => seg.type === "at" && seg.data?.qq === "all");
  }

  /**
   * 是否**单独** @ 了 self_id 本人（不含 @全体成员）。
   *
   * 用途：@全体成员 的消息只有「另外还点名 @ 了 bot」时才该被唤醒 ——
   * 那是明确指向，留作屏蔽逻辑的后门。
   */
  static isAtSelf(message, selfId) {
    if (!Array.isArray(message)) return false;
    return message.some((seg) => seg.type === "at" && seg.data?.qq === String(selfId));
  }

  /**
   * 从**纯文本**里识别「@全体成员 / @all / @所有人」的写法。
   *
   * 【为什么要它】at 段不是唯一来源：有人手打 @all、@全体成员 时 NapCat 不会生成 at 段，
   * 只走文本。两种来源都堵住才算真的屏蔽。
   * 只认**行首**并紧跟空白/结尾 —— 避免正文里顺口提到「@所有人」就被误判成公告。
   */
  static isAtAllText(text) {
    return /^\s*@(all|全体成员|所有人)(?=[\s\u3000]|$)/i.test(String(text ?? ""));
  }

  /**
   * 群聊里这条消息是否应该被当作「@全体成员 公告」整条忽略。
   *
   * 【这两个条件缺一不可】
   *  1. 是 @全体成员（at 段或文本两种来源，见 isAtAll / isAtAllText）
   *  2. **没有另外单独 @ 到 bot 本人** —— 那是明确指向，不能跟着公告一起被吞掉
   *
   * 【为什么不再加一条「文本里喊了 bot 名字就放行」】
   * nameKeywords 里有「2x」这种短词，极易在公告正文里误命中（如「亮度调 2x」），
   * 一加就等于给屏蔽开了洒子。既然用户要的是「屏蔽」，就只留「直接 @ 本人」这一个后门。
   *
   * 抽成纯函数是为了能单测：判定逻辑散在 bridge.mjs 的事件回调里没法直接验。
   *
   * @param {any[]} message  OneBot11 消息段数组
   * @param {string|number} selfId bot 自己的 QQ
   * @param {string} text 已提取的纯文本（用于识别手打的 @all / @全体成员）
   */
  static shouldIgnoreAtAll(message, selfId, text) {
    const atAll = QQBridge.isAtAll(message) || QQBridge.isAtAllText(text);
    if (!atAll) return false;
    if (QQBridge.isAtSelf(message, selfId)) return false;
    return true;
  }

  /** 提取消息中的图片段数据（{file, url, ...}）—— 仅看**顶层**（不含引用/转发内部的图）。
   *  如需连同引用与合并转发里的图一起取，用 collectImageRefs(deep:true)。 */
  static extractImages(message) {
    if (!Array.isArray(message)) return [];
    return message.filter((s) => s.type === "image").map((s) => s.data ?? {});
  }

  /**
   * 深度提取图片引用：顶层 + 内联嵌套（如某些客户端把图片包在子结构里）。
   *
   * 【为什么需要它】旧的 extractImages 只扫顶层 `type === "image"`，于是：
   *   · 引用一条图片消息 → 图的 seg 在 reply 段里，取不到；
   *   · 合开转发里的图 → 正文被 renderForward 渲成「[图片]」占位符，图本身从未入库。
   * 模型只看到一个占位符，就变成了「看不见图」。
   *
   * @param {any} node 消息数组 / 单个段 / 任意嵌套对象
   * @param {number} depth 最大递归层数（防环）
   * @returns {Array<object>}
   */
  static collectImageRefs(node, depth = 0) {
    const out = [];
    if (depth > 6 || node == null) return out;
    if (Array.isArray(node)) {
      for (const x of node) out.push(...QQBridge.collectImageRefs(x, depth + 1));
      return out;
    }
    if (typeof node !== "object") return out;
    if (node.type === "image" && node.data) {
      out.push(node.data);
      return out;
    }
    // 常见嵌套键：message / content / data（只往下走这几类，避免扫到无关字段）
    for (const k of ["message", "content", "data"]) {
      const v = node[k];
      if (v && typeof v === "object") out.push(...QQBridge.collectImageRefs(v, depth + 1));
    }
    return out;
  }

  /** 提取消息中的文件段（{file, name, url, size...}） */
  static extractFiles(message) {
    if (!Array.isArray(message)) return [];
    return message.filter((s) => s.type === "file").map((s) => s.data ?? {});
  }

  close() {
    this._closing = true;
    this.ws?.close();
  }
}