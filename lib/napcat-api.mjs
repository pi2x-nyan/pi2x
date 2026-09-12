/**
 * napcat-api.mjs —— NapCat OneBot11 API 风险分级表（**只是判定表，不做拦截**）
 *
 * 【先看清本文件是什么】它只提供「某个接口名属于哪一级」的纯判定：
 *     riskOf(api) → "green" | "yellow" | "red"
 * 它**不发送请求，也拦不住任何调用**。真正的拦截在调用方。
 *
 * 级别含义（由调用方决定如何处置）：
 *   GREEN  查询类（只读，无副作用）
 *   YELLOW 操作类（发送/点赞/上传等，有影响但非破坏性）
 *   RED    管理/破坏/凭证/程序控制类
 *   （未收录 / 规则外 → RED，安全默认）
 *
 * 【谁必须用它】任何把**动态接口名**透传给 OneBot 的入口，都必须先过 riskOf()。
 * 当前共两处：
 *   1) scripts/qq-cli.mjs 的 napcat 分支（用户可指定任意 action，非 admin 拦 RED）
 *   2) lib/piagent.mjs 的 _consumeRedConfirm（RED 接口需用户二次确认后执行）
 * 其余调用（lib/qqbridge.mjs 里那一批封装方法）接口名写死，天然安全。
 *
 * 【为什么这段说明要改写】文件头原先自称「风险分级表 + 审核」，还附带
 * audit() / riskStats() 两个**无人调用**的函数，让人（和模型）以为这里内建了
 * 风险审核，于是放心地透传接口名。而拦截实际只在 qq-cli 的那句判据里 ——
 * 那句当时还是坏的（levelOf 未导入 → 守卫失效，可读到 QQ 凭据）。
 * 死函数已删，并把「本文件不拦截、调用方负责」写清楚。
 *
 * 【新增 API】在对应列表加名字即可；get_/can_send_ 前缀自动兜底。
 * 回归测试：test/napcat-api-guard.test.mjs（扫描所有动态透传点，防新增入口漏审）。
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
