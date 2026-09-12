/**
 * napcat-api.mjs —— NapCat OneBot11 API 风险分级表 + 审核
 *
 * 级别：
 *   GREEN  查询类（只读，无副作用）→ 直接放行
 *   YELLOW 操作类（发送/点赞/上传等，有影响但非破坏性）→ 放行并记录日志
 *   RED    管理/破坏/凭证/程序控制类 → 拒绝（除非显式 allow 覆盖，默认不允许）
 *   （未收录 / 规则外　→ RED，安全默认）
 *
 * 【新增 API】只需在对应列表加名字即可；with 前缀规则自动兜底。
 */
export const RISK = {
  // ── 高风险（拒绝）：管理破坏 / 凭证 / 程序控制 ──
  RED: [
    // 群管理
    "set_group_kick", "set_group_ban", "set_group_whole_ban", "set_group_admin",
    "set_group_leave", "set_group_name", "set_group_card", "set_group_portrait",
    "set_group_special_title", "set_group_remark", "set_group_sign",
    // 好友/消息破坏
    "delete_friend", "delete_msg", "delete_group_file", "delete_group_folder",
    "delete_essence_msg", "_del_group_notice", "clean_cache",
    // 账号/资料
    "bot_exit", "set_self_longnick", "set_qq_profile", "set_qq_avatar",
    "set_diy_online_status", "set_online_status",
    // 凭证/高级
    "get_cookies", "get_csrf_token", "get_credentials", "get_clientkey", "get_rkey",
    "send_packet", "click_inline_keyboard_button", "send_group_ai_record",
  ],
  // ── 中风险（放行+记录）：发送 / 交互 ──
  YELLOW: [
    "send_private_msg", "send_group_msg", "send_msg",
    "send_like", "friend_poke", "group_poke", "send_poke",
    "upload_private_file", "upload_group_file", "download_file",
    "ocr_image", ".ocr_image", "translate_en2zh", "check_url_safely",
    "send_group_forward_msg", "send_private_forward_msg", "send_forward_msg",
    "forward_friend_single_msg", "forward_group_single_msg",
    "set_essence_msg", "_send_group_notice",
    "mark_private_msg_as_read", "mark_group_msg_as_read", "mark_msg_as_read", "_mark_all_as_read",
    "set_friend_remark", "set_friend_add_request", "set_group_add_request",
    "send_group_sign", "set_msg_emoji_like", "get_ai_record", "set_group_sign",
    "set_input_status", "create_collection", "get_group_file_url", "get_private_file_url",
  ],
};

const RED = new Set(RISK.RED);
const YELLOW = new Set(RISK.YELLOW);

/** 判定某 API 的风险级别 */
export function riskOf(api) {
  const name = String(api ?? "").trim();
  if (RED.has(name)) return "red";
  if (YELLOW.has(name)) return "yellow";
  if (/^get_/.test(name) || name.startsWith(".get_") || /^can_send_/.test(name)) return "green";
  return "red"; // 未知/规则外：拒绝
}

/** 审核结论（工具用） */
export function audit(api) {
  const level = riskOf(api);
  const reasons = {
    red: "高风险或未收录 API（管理破坏/凭证/程序控制类），已拒绝。如需使用请人工在 lib/napcat-api.mjs 的 RED 名单中显式放行。",
    green: "低风险查询类，放行。",
    yellow: "操作类（发送/交互），放行并记录。",
  };
  return { level, allowed: level !== "red", reason: reasons[level] };
}

/** 统计（/status 用） */
export function riskStats() {
  return { red: RED.size, yellow: YELLOW.size, total: RED.size + YELLOW.size + 60 };
}