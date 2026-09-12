import fs from "node:fs";

/**
 * Whitelist —— 本地权限白名单（预设 + 用户映射，热加载 5s）
 *
 * 结构:
 * {
 *   "presets": { "dialog": [], "friend": [...], "operator": [...], "admin": [...] },
 *   "users": { "<QQ号>": "预设名" | ["预设名"|"权限串", ...] }
 * }
 * 无条目用户 = dialog（最低权限：纯对话 + 被动注入，无任何工具）
 */
export class Whitelist {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.mtime = 0;
    this.lastCheck = 0;
  }

  /** 缓存读取 + 5s mtime 热检查 */
  load(force = false) {
    const now = Date.now();
    if (!force && this.cache && now - this.lastCheck < 5000) return this.cache;
    const stat = fs.statSync(this.file, { throwIfNoEntry: false });
    if (!stat) return this.cache ?? null;
    if (force || stat.mtimeMs !== this.mtime || !this.cache) {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.mtime = stat.mtimeMs;
    }
    this.lastCheck = now;
    return this.cache;
  }

  /** 解析用户最终权限集合（组 → 预设 → 权限串 逐级展开，防环） */
  perms(userId) {
    const wl = this.load();
    if (!wl) return new Set();
    const u = wl.users?.[String(userId)];
    if (u === undefined || u === null) return new Set(); // dialog：最低权限
    const items = Array.isArray(u) ? u : [u];
    const out = new Set();
    for (const item of items) this._expand(item, out, wl, 0);
    return out;
  }

  /** 递归展开一个引用项（组名/预设名 → 权限串） */
  _expand(term, out, wl, depth) {
    if (depth > 4 || term == null) return; // 防循环引用
    const group = wl.groups?.[term];
    if (Array.isArray(group)) {
      for (const sub of group) this._expand(sub, out, wl, depth + 1);
      return;
    }
    const preset = wl.presets?.[term];
    if (Array.isArray(preset)) {
      for (const sub of preset) this._expand(sub, out, wl, depth + 1);
      return;
    }
    out.add(term); // 叶子：权限串
  }

  has(userId, perm) {
    return this.perms(userId).has(perm);
  }

  /** 按预设名显示归属（user 的配置；无条目 → dialog；数组 → 组/预设名并集） */
  presetOf(userId) {
    const wl = this.load();
    const u = wl?.users?.[String(userId)];
    if (u === undefined || u === null) return "dialog";
    if (Array.isArray(u)) {
      const names = u.filter((x) => typeof x === "string" && (wl.presets?.[x] !== undefined || wl.groups?.[x] !== undefined));
      return names.length ? names.join("+") : "自定义";
    }
    return String(u);
  }

  /** 用户最终权限列表（已解析，用于日志/审计） */
  list(userId) {
    return [...this.perms(userId)];
  }

  /** 用户所属的“组”（预设/直接引用到的 wl.groups 名）。用于按组展示工具白名单。
   * @returns {string[]} 组名 */
  groupsOf(userId) {
    const wl = this.load();
    const u = wl?.users?.[String(userId)];
    if (u === undefined || u === null) return [];
    const items = Array.isArray(u) ? u : [u];
    const out = new Set();
    const visit = (term, depth) => {
      if (depth > 4 || term == null) return;
      if (Array.isArray(wl.groups?.[term])) { out.add(term); return; } // 是组
      const preset = wl.presets?.[term];
      if (Array.isArray(preset)) {
        for (const sub of preset) visit(sub, depth + 1);
      }
    };
    for (const item of items) visit(String(item), 0);
    return [...out];
  }
}

export function createWhitelist(file) {
  return new Whitelist(file);
}