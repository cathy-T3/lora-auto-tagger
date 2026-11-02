---
name: flux-auto-tagger
description: Operate the local FLUX Tagger (port 3000) to caption and export car LoRA datasets. Use when the user asks to start the tagger, upload car images or zip packs, crop, auto-caption, bulk-fix captions by image number, or export images and captions. Do not use for generic image editing.
---

# FLUX Tagger 自动打标

本地 Express 服务（`server.js`，端口 3000），数据在 `projects/<id>/metadata.json`。

## 启动与登录

```bash
cd "<项目根>" && node server.js   # http://localhost:3000
```

- 登录 `admin` / `admin123`；普通用户填用户名 + 访问密码
- 改 `server.js` 后必须重启才生效；只改 `public/*` 刷新页面即可
- 接口调试先取 Cookie：

```bash
curl -s -c /tmp/ft.jar -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' http://localhost:3000/api/login
```

## 新建项目

- 触发词必须与项目名一致（如 `LS6`），汽车模板未填时自动取车名/项目名
- 汽车项目选「汽车标签模板」；`carName` 填车型
- 项目级规则：涂装（本批 `white painted`）、视角集合

## 上传（懒裁剪）

- 拖到页面任意位置即可；支持多图或 `*.zip`（递归解压、跳过 `._`）
- 上传只存原图，`cropStatus=uncropped`，不立即裁剪
- 需要裁剪时用「批量裁剪」(只裁未裁过的) 或「✂ 手动裁剪」

## 裁剪

- 模式：`attention`（智能）/ `center` / `learned`（学习我的裁剪）
- 学习裁剪取最近样本中位数：`size`（边长/短边）、`cx`、`cy`；竖图生效，横图回落 attention
- 手动裁剪写 `cropSamples`，每次保存都会自动更新规则
- 输出固定 1024×1024、JPEG q95、72 DPI
- 裁剪审核：通过 / 重裁，别把构图不对的图导出

## 打标

- 「批量打标」是前端串行请求，每张 4–6 秒；**中途重启服务会导致后续全部失败**，重启后重跑会自动跳过已打标的
- 打标前会按需补裁，无需手动先裁
- 「智能筛图」判断可用性并区分整车/特写；「验证」检查标语规范

## 按序号批量改标词

用户说「第几张」时，序号 = `metadata.json` 中的 `images` 顺序（1 起），与页面卡片 `#N` 一致。

标签规则：`<触发词>, <视角>, <颜色>, <部件...>, motor vehicle`；中文同序，末位「机动车」。视角只允许 7 种（`front view`、`left/right front 45 view`、`side view`、`left/right rear 45 view`、`rear view`），**24 度视角禁用**。

用 `scripts/tags.js` 批量改（默认 dry-run，加 `--apply` 落盘）：

```bash
node scripts/tags.js <projectId> add 10-30 --tags "door handle=车门把手" --apply
node scripts/tags.js <projectId> set-view 49-54 --view "right rear 45 view=右后45度视角" --apply
node scripts/tags.js <projectId> keep 73-82 --tags "white painted=白色涂装,license plate=车牌" --apply
node scripts/tags.js <projectId> normalize --apply
```

改完先抽查 1–2 张英文与中文，再向用户汇报命中率（如 `6/6`）。

## 导出

- 导出全部：图片 + 同名 `.txt` + `caption_bilingual.csv` + `caption_summary.json`
- 只导图片：`?type=images`
- 只导标词：`?type=captions`
- 图片与 txt 同名配对，可直接用于 kohya / diffusers

## 常见坑

1. 触发词重复：标语已以触发词开头时不要再拼 `LS6 LS6, ...`
2. 涂装不一致：Prompt 硬规则 + `normalizeCarColors()` 兜底，中文同步「白色涂装」
3. 中文用词：`前格栅`、`车门把手`、`车铭牌`、`车标`、`机动车`；避免「车车门把手」
4. 视角标签必须在第 2 位，改词后要重排
5. 前端曾用 `apiKey.includes('****')` 判断未配置导致不打标，判断请用后端 `apiKeyConfigured`
6. 拖拽不生效时先刷新页面，再检查是否落在 window 级 drop 监听内
