#!/usr/bin/env node
// 批量修正 FLUX Tagger 标词的工具（默认 dry-run，加 --apply 才写入）
// 用法：
//   node tags.js <projectId> add 10-30 --tags "door handle=车门把手"
//   node tags.js <projectId> set-view 49-54 --view "right rear 45 view=右后45度视角"
//   node tags.js <projectId> keep 73-82 --tags "white painted=白色涂装,license plate=车牌"
//   node tags.js <projectId> normalize

const fs = require('fs');
const path = require('path');

const VIEWS_EN = [
  'front view', 'left front 45 view', 'right front 45 view', 'side view',
  'left rear 45 view', 'right rear 45 view', 'rear view',
];
const VIEWS_ZH = [
  '正面视角', '左前45度视角', '右前45度视角', '侧视图',
  '左后45度视角', '右后45度视角', '后视图',
];

const rawArgs = process.argv.slice(2);
const apply = rawArgs.includes('--apply');
const opts = {};
const positionals = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--apply') continue;
  if (a.startsWith('--')) { opts[a.slice(2)] = rawArgs[i + 1]; i++; } else positionals.push(a);
}
const [projectId, action, rangeArg] = positionals;
if (!projectId || !action) {
  console.error('用法见文件头注释');
  process.exit(1);
}

// 从脚本位置向上找项目根（同时存在 server.js 和 projects 目录）
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'projects'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const metaPath = path.join(findRoot(__dirname), 'projects', projectId, 'metadata.json');
if (!fs.existsSync(metaPath)) {
  console.error(`找不到项目数据: ${metaPath}`);
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

const split = (s) => String(s || '').replace(/[，、]/g, ',').split(',').map(t => t.trim()).filter(Boolean);
const join = (arr) => arr.filter(Boolean).join(', ');

function parseRanges(arg) {
  const set = new Set();
  String(arg || '').split(',').forEach(part => {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
  });
  return [...set].sort((x, y) => x - y);
}

function parsePairs(arg) {
  return String(arg || '').split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const [en, zh = en] = pair.split('=').map(s => s.trim());
    return { en, zh };
  });
}

// 规范化：去重、视角归位到第 2、中文用词统一、机动车收尾
function normalize(img) {
  if (!img.captionEn) return;
  let en = split(img.captionEn);
  let zh = split(img.captionZh);
  const vEn = en.find(t => VIEWS_EN.includes(t));
  const vZh = zh.find(t => VIEWS_ZH.includes(t));
  en = en.filter(t => !VIEWS_EN.includes(t) && t !== 'motor vehicle');
  zh = zh.filter(t => !VIEWS_ZH.includes(t) && t !== '机动车' && t !== '机动车辆');
  zh = zh.map(t => ({
    '汽车标志': '车标', '铭牌': '车铭牌', '名牌': '车铭牌', '车车铭牌': '车铭牌',
    '前中网': '前格栅', '车车门把手': '车门把手', '车把手': '车门把手', '把手': '车门把手',
    '大灯': '前大灯',
  }[t] || t));
  en = [...new Set(en)];
  zh = [...new Set(zh)];
  const trigger = en.shift() || '';
  const tailEn = trigger ? [trigger, ...(vEn ? [vEn] : []), ...en, 'motor vehicle'] : [...en, 'motor vehicle'];
  const tailZh = trigger ? [trigger, ...(vZh ? [vZh] : []), ...zh.filter(t => t !== trigger), '机动车'] : [...zh, '机动车'];
  img.captionEn = join(tailEn);
  img.captionZh = join(tailZh);
}

// 不给范围时：normalize 处理全部，其他动作必须给范围
const targets = rangeArg ? parseRanges(rangeArg) : action === 'normalize' ? meta.images.map((_, i) => i + 1) : [];
const preview = [];

for (const n of targets) {
  const img = meta.images[n - 1];
  if (!img || !img.captionEn) continue;
  const before = img.captionEn;
  const pairs = parsePairs(opts.tags || opts.view);
  if (pairs.length) {
    const isView = action === 'set-view';
    let en = split(img.captionEn);
    let zh = split(img.captionZh);
    if (isView) {
      en = en.filter(t => !VIEWS_EN.includes(t) && t !== 'motor vehicle');
      zh = zh.filter(t => !VIEWS_ZH.includes(t) && t !== '机动车' && t !== '机动车辆');
    } else if (action === 'keep') {
      en = [];
      zh = [];
    } else {
      en = en.filter(t => t !== 'motor vehicle');
      zh = zh.filter(t => t !== '机动车' && t !== '机动车辆');
    }
    const trigger = split(img.captionEn)[0] || '';
    zh = zh.filter(t => t !== trigger);
    const enOut = action === 'keep' ? [trigger, ...pairs.map(p => p.en)] : [...en, ...pairs.map(p => p.en)];
    const zhOut = action === 'keep' ? [trigger, ...pairs.map(p => p.zh)] : [...zh, ...pairs.map(p => p.zh)];
    img.captionEn = join([...new Set(enOut), 'motor vehicle']);
    img.captionZh = join([...new Set(zhOut), '机动车']);
  }
  normalize(img);
  if (img.captionEn !== before) preview.push(`#${n}: ${before}\n      → ${img.captionEn}\n      ${img.captionZh}`);
}

console.log(preview.length ? preview.join('\n') : '没有需要改动的图片');
console.log(`\n共 ${preview.length} 张${apply ? '，已写入' : '（dry-run，未写入）'}`);

if (apply) {
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}
