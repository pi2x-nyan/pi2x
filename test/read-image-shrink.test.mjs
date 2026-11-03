/**
 * read 工具「大图压缩」回归测试。
 *
 * 【被锁定的设计决策】
 * 图片只要进了会话历史，**之后每一轮请求都要重传一遍**。pi 内置 read 的
 * autoResizeImages 只限**边长**（2000px）且保持无损 PNG，实测一张 2560x1440 的
 * 游戏截图缩到 2000px 后仍是 2.09MB（base64 2.79MB）——两条就把私聊会话撑到
 * 6.6MB、单次请求 5.6MB，超过上游 ~1M tokens（≈3~4.5MB 文本）的处理上限，
 * 上游在 HTTP 200 的流里回 `{"type":"error",...,"message":"Bad Request"}`，
 * 代理转成空流，bot 看到 0 个 delta 就回「模型返回了空内容」。
 * 表现为「bot 突然不说话」，排查成本极高（2026-09-24 实际事故）。
 *
 * 因此 PI2X 在 read 之后加了一道**按字节**的闸：超 1MB 就转 JPEG。
 * 这两条测试分别守住「接线」与「行为」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIAGENT = path.join(ROOT, "lib", "piagent.mjs");

test("read 工具接线：必须排除内置 read 并挂上会压图的版本", () => {
  const src = fs.readFileSync(PIAGENT, "utf8");
  assert.match(src, /READ_IMAGE_MAX_BYTES\s*=\s*[\d_]+/, "找不到图片字节阈值常量");
  // 关键接线：挂上压缩版 **且** 排除内置 read。
  // 只挂不排除 = 内置 read 仍生效，压图形同虚设（这是很容易犯的错）。
  // 以“挂载点”为锚往前看，避免依赖注释行数与空格格式。
  const mount = src.indexOf("createReadToolShrinkingImages(opts.cwd)");
  assert.ok(mount > 0, "hasFilesFull 分支没挂压缩版 read");
  const near = src.slice(Math.max(0, mount - 600), mount);
  assert.match(near, /excludedToolNames\s*=\s*\["read"\]/, "没有排除内置 read —— 压图不会生效");
});

test("read 工具行为：>1MB 图片压成 JPEG 且落到 1MB 以下，小图不动", async () => {
  // 复制一份并注入 export（PiAgent 类未导出，这里只需模块内的压缩函数）
  const tmpMod = path.join(ROOT, "lib", "__read_image_shrink_test.mjs");
  const src = fs.readFileSync(PIAGENT, "utf8").replace(
    "async function shrinkLargeImages(result) {",
    "export async function shrinkLargeImages(result) {",
  );
  assert.ok(src.includes("export async function shrinkLargeImages"), "注入 export 失败（函数签名变了？）");
  fs.writeFileSync(tmpMod, src);
  try {
    const { shrinkLargeImages } = await import(tmpMod);
    const sharp = (await import("sharp")).default;
    // 造一张**真随机**噪点的图，保证 PNG 体积足够大。
    // （先用“(i*常数)%256”这类规律图案试过：PNG 的滤波能把它压到 32KB，
    //   根本覆盖不到 1MB 阈值 —— 测试数据必须真随机。）
    const noise = randomBytes(1400 * 900 * 3);
    const bigPng = await sharp(noise, { raw: { width: 1400, height: 900, channels: 3 } }).png().toBuffer();
    assert.ok(bigPng.length > 1048576, `测试图不够大（${bigPng.length} 字节），无法覆盖阈值`);

    const res = await shrinkLargeImages({
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: bigPng.toString("base64"), mimeType: "image/png" },
      ],
    });
    const img = res.content.find((p) => p.type === "image");
    const bytes = Math.floor((img.data.length * 3) / 4);
    assert.equal(img.mimeType, "image/jpeg", "大图没有转成 JPEG");
    assert.ok(bytes < 1048576, `压缩后仍超 1MB：${bytes} 字节`);
    assert.ok(bytes < bigPng.length / 2, `压缩比不足：${bigPng.length} → ${bytes}`);
    assert.ok(
      res.content.some((p) => typeof p.text === "string" && p.text.includes("已压缩")),
      "缺少压缩提示文本（模型需要知道细节要看原图）",
    );

    // 小图必须原样返回（不做无谓的有损转换）
    const smallPng = await sharp(noise, { raw: { width: 200, height: 150, channels: 3 } }).png().toBuffer();
    const res2 = await shrinkLargeImages({ content: [{ type: "image", data: smallPng.toString("base64"), mimeType: "image/png" }] });
    assert.equal(res2.content.length, 1, "小图被追加了内容");
    assert.equal(res2.content[0].mimeType, "image/png", "小图被改写成了别的格式");
  } finally {
    fs.rmSync(tmpMod, { force: true });
  }
});
