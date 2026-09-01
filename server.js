const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

const BASE_DIR = __dirname;
const PROJECTS_DIR = path.join(BASE_DIR, 'projects');
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');
const AUTH_FILE = path.join(BASE_DIR, 'auth.json');

// 确保目录存在
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// ============ 认证 ============
const DEFAULT_AUTH = {
  adminUser: 'admin',
  adminPassword: 'admin123',
  accessPassword: 'flux2026',
};

// 会话存储（内存，重启失效但数据仍在磁盘）
const sessions = new Map(); // token -> { role, userId, username, createdAt }

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return { ...DEFAULT_AUTH, ...JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')) };
    }
  } catch (e) {
    console.error('读取认证配置失败:', e.message);
  }
  return { ...DEFAULT_AUTH };
}

function saveAuth(auth) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

// 首次运行生成默认 auth.json
if (!fs.existsSync(AUTH_FILE)) {
  saveAuth(DEFAULT_AUTH);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  });
  return cookies;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies['ft_session'];
  return token ? sessions.get(token) : null;
}

// 认证中间件：保护所有 /api 接口（login/check/logout 除外，它们在注册顺序上更靠前）
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  req.session = session;
  next();
}

// 加载项目并校验当前用户是否有权访问（无权限或不存在时返回 null 并已写响应）
function getAccessibleProject(req, res) {
  const meta = loadProjectMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: '项目不存在' });
    return null;
  }
  if (req.session.role !== 'admin' && meta.ownerId !== req.session.userId) {
    res.status(403).json({ error: '无权访问该项目' });
    return null;
  }
  return meta;
}

// 默认设置
const DEFAULT_SETTINGS = {
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
  cropMode: 'attention', // attention | center | contain
  captionStyle: 'natural', // natural | tags
  language: 'bilingual', // bilingual | en | zh
};

// 汽车打标预设（视角/颜色/部件标签体系）
const GLC_CAR_PRESETS = {
  views: {
    'front view': '正面视角',
    'left front 45 view': '左前45度视角',
    'right front 45 view': '右前45度视角',
    'side view': '侧视图',
    'left rear 45 view': '左后45度视角',
    'right rear 45 view': '右后45度视角',
    'rear view': '后视图',
    // 更细的角度（按用户实际数据补充）
    'left rear 24 view': '左后24度视角',
    'right rear 24 view': '右后24度视角',
    'left front 24 view': '左前24度视角',
    'right front 24 view': '右前24度视角',
  },
  colors: {
    'black painted': '黑色涂装',
    'blue painted': '蓝色涂装',
    'silver painted': '银色涂装',
    'white painted': '白色涂装',
  },
  parts: {
    'license plate': '车牌',
    'headlight': '日行灯',
    'through daytime running light': '贯穿式日行灯',
    'through taillight': '贯穿式尾灯',
    'car logo': '车标',
    'nameplate': '车铭牌',
    'door handle': '车门把手',
    'front bumper air vent': '前保险杠进气口',
    'wheel': '车轮',
    'front wheel': '前车轮',
    'rear wheel': '后车轮',
    'rearview mirror': '后视镜',
    'front grille': '前中网',
    'motor vehicle': '机动车',
  },
};

// 预设打标模板
const CAPTION_TEMPLATES = {
  general: {
    name: '通用模板',
    description: '通用自然语言描述，适用于人物、风景、艺术作品等',
    promptStyle: 'natural',
  },
  'glc-car': {
    name: '汽车标签模板',
    description: '汽车车型LoRA训练专用，输出标签式标语，严格遵循打标规范',
    promptStyle: 'tags',
    triggerWord: 'GLC',
  },
};

// 读取设置
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
    }
  } catch (e) {
    console.error('读取设置失败:', e.message);
  }
  return { ...DEFAULT_SETTINGS };
}

// 保存设置
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// 读取项目元数据
function loadProjectMeta(projectId) {
  const metaPath = path.join(PROJECTS_DIR, projectId, 'metadata.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

// 保存项目元数据
function saveProjectMeta(projectId, meta) {
  const metaPath = path.join(PROJECTS_DIR, projectId, 'metadata.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// 生成唯一ID
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(BASE_DIR, 'public')));

// ============ 认证 API ============

// 登录：admin 账号用管理员密码；普通用户用用户名 + 访问密码
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: '请输入密码' });
  }
  const auth = loadAuth();
  const isAdmin = username === auth.adminUser && password === auth.adminPassword;
  const guestName = (username || '').trim();
  const isGuest = !isAdmin && password === auth.accessPassword && guestName;

  if (!isAdmin && !isGuest) {
    return res.status(401).json({ error: '密码错误，或普通用户需填写用户名' });
  }

  const userId = isAdmin ? auth.adminUser : guestName;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    role: isAdmin ? 'admin' : 'user',
    userId,
    username: isAdmin ? auth.adminUser : guestName,
    createdAt: Date.now(),
  });
  res.setHeader('Set-Cookie', `ft_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
  res.json({ role: isAdmin ? 'admin' : 'user', username: userId, userId });
});

// 检查当前登录状态
app.get('/api/auth/check', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '未登录' });
  res.json({ role: session.role, username: session.username, userId: session.userId });
});

// 登出
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['ft_session'];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'ft_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ success: true });
});

// 保护其余所有 /api 接口（上面的 login/check/logout 已先注册，不受影响）
app.use('/api', requireAuth);

// ============ 设置 API ============

app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  // 隐藏 API Key 的中间部分
  const safeSettings = { ...settings };
  const hasKey = !!settings.apiKey;
  if (settings.apiKey && settings.apiKey.length > 8) {
    safeSettings.apiKey = settings.apiKey.slice(0, 4) + '****' + settings.apiKey.slice(-4);
  }
  safeSettings.apiKeyConfigured = hasKey;
  res.json(safeSettings);
});

app.put('/api/settings', (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可修改全局设置' });
  }
  const current = loadSettings();
  const updates = req.body;
  // 如果 apiKey 是掩码格式（包含****），保持原值
  if (updates.apiKey && updates.apiKey.includes('****')) {
    delete updates.apiKey;
  }
  const newSettings = { ...current, ...updates };
  saveSettings(newSettings);
  res.json({ success: true });
});

// ============ 项目 API ============

// 获取所有项目（管理员看全部，普通用户只看自己的）
app.get('/api/projects', (req, res) => {
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
      return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory();
    });
    const isAdmin = req.session.role === 'admin';
    const projects = dirs.map(id => {
      const meta = loadProjectMeta(id);
      if (!meta) return null;
      if (!isAdmin && meta.ownerId !== req.session.userId) return null;
      return {
        id: meta.id,
        name: meta.name,
        description: meta.description,
        createdAt: meta.createdAt,
        imageCount: meta.images ? meta.images.length : 0,
        triggerWord: meta.triggerWord || '',
        cropMode: meta.cropMode || 'attention',
        captionTemplate: meta.captionTemplate || 'general',
        ownerId: meta.ownerId || '',
      };
    }).filter(Boolean);
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 创建项目
app.post('/api/projects', (req, res) => {
  try {
    const { name, description, triggerWord, cropMode, captionTemplate } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '项目名称不能为空' });
    }
    const id = generateId();
    const projectDir = path.join(PROJECTS_DIR, id);
    fs.mkdirSync(path.join(projectDir, 'originals'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'cropped'), { recursive: true });

    // 如果使用 GLC 模板但未设置触发词，默认用 GLC
    let tw = triggerWord || '';
    if (captionTemplate === 'glc-car' && !tw) {
      tw = 'GLC';
    }

    const meta = {
      id,
      name: name.trim(),
      description: description || '',
      triggerWord: tw,
      cropMode: cropMode || 'attention',
      captionTemplate: captionTemplate || 'general',
      createdAt: new Date().toISOString(),
      ownerId: req.session.userId,
      images: [],
    };
    saveProjectMeta(id, meta);
    res.status(201).json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取项目详情
app.get('/api/projects/:id', (req, res) => {
  const meta = getAccessibleProject(req, res);
  if (!meta) return;
  res.json(meta);
});

// 删除项目
app.delete('/api/projects/:id', (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;
    const projectDir = path.join(PROJECTS_DIR, req.params.id);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新项目设置
app.put('/api/projects/:id', (req, res) => {
  const meta = getAccessibleProject(req, res);
  if (!meta) return;
  const { name, description, triggerWord, cropMode, captionTemplate } = req.body;
  if (name !== undefined) meta.name = name;
  if (description !== undefined) meta.description = description;
  if (triggerWord !== undefined) meta.triggerWord = triggerWord;
  if (cropMode !== undefined) meta.cropMode = cropMode;
  if (captionTemplate !== undefined) meta.captionTemplate = captionTemplate;
  saveProjectMeta(req.params.id, meta);
  res.json(meta);
});

// ============ 预设 API ============

// 获取所有打标预设（模板 + GLC汽车标签）
app.get('/api/presets', (req, res) => {
  res.json({
    templates: CAPTION_TEMPLATES,
    glcCarPresets: GLC_CAR_PRESETS,
  });
});

// ============ 图片上传 API ============

// Multer 配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const projectDir = path.join(PROJECTS_DIR, req.params.id, 'originals');
    fs.mkdirSync(projectDir, { recursive: true });
    cb(null, projectDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, generateId() + ext);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的图片格式: ' + ext));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// 上传图片并自动裁剪
app.post('/api/projects/:id/images', upload.array('images', 100), async (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;

    const cropMode = meta.cropMode || 'attention';
    const results = [];

    for (const file of req.files) {
      const imageId = generateId();
      const ext = path.extname(file.filename);
      const croppedFilename = imageId + '.jpg';
      const croppedPath = path.join(PROJECTS_DIR, req.params.id, 'cropped', croppedFilename);

      // 裁剪到 1024×1024
      try {
        let pipeline = sharp(file.path);

        if (cropMode === 'contain') {
          // 包含模式：缩放到适合 1024×1024 内，然后填充背景
          pipeline = pipeline.resize(1024, 1024, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 1 },
          });
        } else if (cropMode === 'center') {
          // 中心裁剪
          pipeline = pipeline.resize(1024, 1024, {
            fit: 'cover',
            position: 'center',
          });
        } else {
          // attention 模式：智能裁剪（基于显著性）
          pipeline = pipeline.resize(1024, 1024, {
            fit: 'cover',
            position: 'attention',
          });
        }

        pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
        await pipeline.toFile(croppedPath);
      } catch (e) {
        console.error('裁剪失败:', file.filename, e.message);
        // 如果 attention 失败，回退到 center
        try {
          await sharp(file.path)
            .resize(1024, 1024, { fit: 'cover', position: 'center' })
            .jpeg({ quality: 95 })
            .toFile(croppedPath);
        } catch (e2) {
          console.error('回退裁剪也失败:', e2.message);
          continue;
        }
      }

      // 获取原始图片尺寸
      const metadata = await sharp(file.path).metadata();

      const imageInfo = {
        id: imageId,
        originalName: file.originalname,
        originalPath: path.join('originals', file.filename),
        croppedPath: path.join('cropped', croppedFilename),
        originalSize: { width: metadata.width, height: metadata.height },
        fileSize: file.size,
        captionEn: '',
        captionZh: '',
        verificationStatus: 'pending', // pending | verified | uncertain | error
        verificationConfidence: 0,
        verificationNote: '',
        uploadedAt: new Date().toISOString(),
      };

      meta.images.push(imageInfo);
      results.push(imageInfo);
    }

    saveProjectMeta(req.params.id, meta);
    res.status(201).json(results);
  } catch (e) {
    console.error('上传错误:', e);
    res.status(500).json({ error: e.message });
  }
});

// 获取裁剪后的图片
app.get('/api/projects/:id/images/:imageId/file', (req, res) => {
  const meta = getAccessibleProject(req, res);
  if (!meta) return;
  const img = meta.images.find(i => i.id === req.params.imageId);
  if (!img) {
    return res.status(404).json({ error: '图片不存在' });
  }
  const filePath = path.join(PROJECTS_DIR, req.params.id, img.croppedPath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  res.sendFile(filePath);
});

// 获取原始图片
app.get('/api/projects/:id/images/:imageId/original', (req, res) => {
  const meta = getAccessibleProject(req, res);
  if (!meta) return;
  const img = meta.images.find(i => i.id === req.params.imageId);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  const filePath = path.join(PROJECTS_DIR, req.params.id, img.originalPath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(filePath);
});

// 删除图片
app.delete('/api/projects/:id/images/:imageId', (req, res) => {
  const meta = getAccessibleProject(req, res);
  if (!meta) return;
  const idx = meta.images.findIndex(i => i.id === req.params.imageId);
  if (idx === -1) return res.status(404).json({ error: '图片不存在' });

  const img = meta.images[idx];
  // 删除文件
  const croppedFile = path.join(PROJECTS_DIR, req.params.id, img.croppedPath);
  const originalFile = path.join(PROJECTS_DIR, req.params.id, img.originalPath);
  try { fs.unlinkSync(croppedFile); } catch (e) {}
  try { fs.unlinkSync(originalFile); } catch (e) {}

  meta.images.splice(idx, 1);
  saveProjectMeta(req.params.id, meta);
  res.json({ success: true });
});

// ============ AI 打标 API ============

// 调用 AI 视觉模型生成图片描述
async function callVisionAPI(imagePath, prompt, settings) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64Image}`;

  const response = await fetch(`${settings.apiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      max_tokens: 1000,
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// 根据项目模板生成打标 Prompt
function buildCaptionPrompt(template, triggerWord) {
  if (template === 'glc-car') {
    const tw = triggerWord || 'GLC';
    return `You are an expert image tagger for car LoRA training (FLUX.1 diffusion model).
You are tagging images of a ${tw} car for LoRA training. Be DETAILED about every visible car part.

STRICT RULES (打标规范):
1. First tag: trigger word "${tw}" — always at the very start.
2. Always include "motor vehicle" near the END (second-to-last or last position).
3. If the image shows the whole car:
   - Use ONE view angle + ONE color painted, then ADD any visible car parts.
   - Example: "${tw}, front view, silver painted, headlight, through daytime running light, car logo, front grille, motor vehicle"
4. If the image is a closeup of a part:
   - Use color painted + the part(s).
   - Example: "${tw}, silver painted, wheel, motor vehicle"

VIEW ANGLES (use ONLY these exact strings):
- front view, left front 45 view, right front 45 view
- side view, left rear 45 view, right rear 45 view, rear view
- left rear 24 view, right rear 24 view, left front 24 view, right front 24 view

COLORS (use ONLY these exact strings with "painted" suffix):
- black painted, blue painted, silver painted, white painted

CAR PARTS — IMPORTANT: tag every part that is CLEARLY VISIBLE in the image, not just closeups!
- license plate, headlight, through daytime running light
- through taillight, car logo, nameplate, door handle
- front bumper air vent, wheel, front wheel, rear wheel
- rearview mirror
- front grille

LIGHTING/PART DETECTION RULES (this is the most important section):
- Front-facing car (front view) → MUST tag "headlight" (and "through daytime running light" if it has the full-width LED strip). MUST tag "front grille" and "car logo" if visible. ALSO tag "rearview mirror" — for this LoRA training, mirror is included on every angle to make the model learn to associate it with the car even from front view.
- Rear-facing car (rear view) → MUST tag "through taillight" (if it has the full-width LED strip). MUST tag "rearview mirror" (per training rule, mirror is always tagged).
- Side or 3/4 view (left front 45, right front 45, left rear 45, right rear 45, side view) → these views ALWAYS show the side of the car, so you MUST tag at minimum:
    • "rearview mirror" — ALWAYS (this is a strict rule)
    • "wheel" — ALWAYS visible from any side or 3/4 view
    • "car logo" — tag if the side emblem is visible
    • "door handle" — tag if visible
  Front-facing 3/4 views (left/right front 45): ALSO tag "headlight", "front grille" because front is partly visible.
  Rear-facing 3/4 views (left/right rear 45): ALSO tag "through taillight" if visible.
- WHEEL RULES:
    * In a CLOSEUP of one wheel, determine if it's a front wheel (closer to the headlight/hood direction) or rear wheel, and tag exactly ONE of: "front wheel" or "rear wheel".
    * In a WHOLE CAR view, NEVER use "front wheel" or "rear wheel" — use the generic "wheel" instead.
- Closeup of a single part → only tag that part (no view angle).

REARVIEW MIRROR RULE FOR THIS LORA TRAINING (1-25 series, common angle practice):
- Tag "rearview mirror" on EVERY car image that is not a single-part closeup.
- This includes front view, rear view, side views, all 45-degree views, and all 24-degree views.
- The reason: this car model has rearview mirrors as a defining feature, so we want the LoRA to learn this association regardless of camera angle.
- Only skip "rearview mirror" on actual closeup shots of OTHER parts (wheel closeup, headlight closeup, etc.).

DO NOT add any tag that you cannot confirm is visible. It is better to have FEWER but ACCURATE tags than many guessed ones.

OTHER RULES:
- Keep caption as a comma-separated list (no sentences).
- Do NOT describe background, lighting, weather, environment, or driver.
- DISTINGUISHING car logo vs nameplate:
  * "car logo" = the manufacturer's emblem/badge on the front (e.g. round or stylized brand mark)
  * "nameplate" = a small text/letter badge on the rear or side that displays the model name/version (e.g. "GT"). These are separate from the front logo.
  * Tag both if visible. A car can have a car logo AND a nameplate on the same image.
- Do NOT repeat the same tag twice.
- Judge view angle by where the car's FRONT is facing (车头朝向哪边，那一边就是前):
  * Front faces you directly → front view
  * Front pointing to your LEFT (车头朝左) → left front 45 view (front-left side is visible)
  * Front pointing to your RIGHT (车头朝右) → right front 45 view (front-right side is visible)
  * Pure side view (车头方向与画面垂直) → side view
  * Rear visible with front pointing slightly left → left rear 45 view (rear-left side visible)
  * Rear visible with front pointing slightly right → right rear 45 view (rear-right side visible)
  * Rear faces you directly → rear view
  * If the angle is shallower (24 degrees) instead of 45 → use the 24 view variant

After tagging, provide a Chinese translation of each tag for human verification.

Respond ONLY in this exact JSON format, no other text, no markdown:
{"english": "tag1, tag2, tag3", "chinese": "标签1, 标签2, 标签3"}`;
  }

  // 默认通用模板
  return `You are an expert image captioner for FLUX.1 diffusion model training data preparation.

Analyze this image carefully and provide:
1. A detailed English caption describing the image in natural language. Include:
   - Main subject(s): person, object, animal, scene
   - Pose, expression, action, gesture
   - Clothing, accessories, hairstyle
   - Background and environment details
   - Lighting, color, atmosphere
   - Art style, medium, or quality tags if applicable
   Keep it 1-3 sentences, natural and descriptive (NOT comma-separated tags).

2. A Chinese translation (中文翻译) of the same caption.

Respond ONLY in this exact JSON format, no other text:
{"english": "your english caption here", "chinese": "中文翻译在这里"}`;
}

// 单张图片打标
app.post('/api/projects/:id/images/:imageId/caption', async (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;
    const img = meta.images.find(i => i.id === req.params.imageId);
    if (!img) return res.status(404).json({ error: '图片不存在' });

    const settings = loadSettings();
    if (!settings.apiKey || settings.apiKey.includes('****')) {
      return res.status(400).json({ error: '请先在设置中配置 API Key' });
    }

    const imagePath = path.join(PROJECTS_DIR, req.params.id, img.croppedPath);
    const prompt = buildCaptionPrompt(meta.captionTemplate || 'general', meta.triggerWord || '');

    const rawResponse = await callVisionAPI(imagePath, prompt, settings);

    // 解析 JSON 响应
    let captions;
    try {
      // 尝试提取 JSON
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        captions = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('无法解析 AI 响应');
      }
    } catch (e) {
      // 如果无法解析为 JSON，使用原始文本
      captions = { english: rawResponse, chinese: rawResponse };
    }

    img.captionEn = captions.english || '';
    img.captionZh = captions.chinese || '';
    img.verificationStatus = 'pending';

    saveProjectMeta(req.params.id, meta);
    res.json(img);
  } catch (e) {
    console.error('打标失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// 批量打标
app.post('/api/projects/:id/auto-caption-all', async (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;

    const settings = loadSettings();
    if (!settings.apiKey || settings.apiKey.includes('****')) {
      return res.status(400).json({ error: '请先在设置中配置 API Key' });
    }

    const pendingImages = meta.images.filter(i => !i.captionEn);
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < pendingImages.length; i++) {
      const img = pendingImages[i];
      try {
        const imagePath = path.join(PROJECTS_DIR, req.params.id, img.croppedPath);

        const prompt = `You are an expert image captioner for FLUX.1 diffusion model training data preparation.

Analyze this image carefully and provide:
1. A detailed English caption describing the image in natural language. Include:
   - Main subject(s): person, object, animal, scene
   - Pose, expression, action, gesture
   - Clothing, accessories, hairstyle
   - Background and environment details
   - Lighting, color, atmosphere
   - Art style, medium, or quality tags if applicable
   Keep it 1-3 sentences, natural and descriptive (NOT comma-separated tags).

2. A Chinese translation (中文翻译) of the same caption.

Respond ONLY in this exact JSON format, no other text:
{"english": "your english caption here", "chinese": "中文翻译在这里"}`;

        const rawResponse = await callVisionAPI(imagePath, prompt, settings);

        let captions;
        try {
          const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            captions = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('无法解析');
          }
        } catch (e) {
          captions = { english: rawResponse, chinese: rawResponse };
        }

        img.captionEn = captions.english || '';
        img.captionZh = captions.chinese || '';
        img.verificationStatus = 'pending';
        results.push({ id: img.id, status: 'success', image: img });
        successCount++;
      } catch (e) {
        results.push({ id: img.id, status: 'error', error: e.message });
        failCount++;
      }
      // 每次处理后保存
      saveProjectMeta(req.params.id, meta);
    }

    res.json({ successCount, failCount, total: pendingImages.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新单张图片标语
app.put('/api/projects/:id/images/:imageId/caption', (req, res) => {
  const meta = getAccessibleProject(req, res);
  if (!meta) return;
  const img = meta.images.find(i => i.id === req.params.imageId);
  if (!img) return res.status(404).json({ error: '图片不存在' });

  const { captionEn, captionZh } = req.body;
  if (captionEn !== undefined) img.captionEn = captionEn;
  if (captionZh !== undefined) img.captionZh = captionZh;
  img.verificationStatus = 'pending';
  img.verificationNote = '';

  saveProjectMeta(req.params.id, meta);
  res.json(img);
});

// ============ 验证 API ============

// 单张图片验证
app.post('/api/projects/:id/images/:imageId/verify', async (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;
    const img = meta.images.find(i => i.id === req.params.imageId);
    if (!img) return res.status(404).json({ error: '图片不存在' });

    if (!img.captionEn) {
      return res.status(400).json({ error: '该图片尚未打标，请先生成标语' });
    }

    const settings = loadSettings();
    if (!settings.apiKey || settings.apiKey.includes('****')) {
      return res.status(400).json({ error: '请先在设置中配置 API Key' });
    }

    const imagePath = path.join(PROJECTS_DIR, req.params.id, img.croppedPath);

    const prompt = `You are a quality assurance reviewer for AI training image captions.

Please carefully examine this image and compare it with the following caption:

English caption: "${img.captionEn}"
Chinese caption: "${img.captionZh}"

Check the following:
1. Does the caption accurately describe the main subject(s) in the image?
2. Are there any factual errors (e.g., wrong colors, wrong objects, wrong actions described)?
3. Are there important visual elements in the image that are missing from the caption?
4. Is there anything in the caption that contradicts what is actually shown in the image?
5. Does the Chinese translation accurately match the English caption?

Respond ONLY in this exact JSON format:
{
  "status": "verified" | "uncertain" | "error",
  "confidence": <0-100>,
  "issues": ["specific issue 1", "specific issue 2"],
  "suggestion": "corrected caption or improvement suggestion"
}

- "verified": Caption is accurate and comprehensive (confidence 80-100)
- "uncertain": Caption is mostly correct but has minor issues or missing details (confidence 50-79)
- "error": Caption has significant errors or major mismatches with the image (confidence 0-49)`;

    const rawResponse = await callVisionAPI(imagePath, prompt, settings);

    let verification;
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        verification = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('无法解析验证结果');
      }
    } catch (e) {
      verification = {
        status: 'uncertain',
        confidence: 50,
        issues: ['AI 响应解析失败，请手动核查'],
        suggestion: '',
      };
    }

    img.verificationStatus = verification.status || 'uncertain';
    img.verificationConfidence = verification.confidence || 0;
    img.verificationNote = JSON.stringify({
      issues: verification.issues || [],
      suggestion: verification.suggestion || '',
    });
    img.verifiedAt = new Date().toISOString();

    saveProjectMeta(req.params.id, meta);
    res.json(img);
  } catch (e) {
    console.error('验证失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// 批量验证
app.post('/api/projects/:id/verify-all', async (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;

    const settings = loadSettings();
    if (!settings.apiKey || settings.apiKey.includes('****')) {
      return res.status(400).json({ error: '请先在设置中配置 API Key' });
    }

    const toVerify = meta.images.filter(i => i.captionEn);
    const results = [];
    let verifiedCount = 0;
    let uncertainCount = 0;
    let errorCount = 0;

    for (const img of toVerify) {
      try {
        const imagePath = path.join(PROJECTS_DIR, req.params.id, img.croppedPath);

        const prompt = `You are a quality assurance reviewer for AI training image captions.

Please carefully examine this image and compare it with the following caption:

English caption: "${img.captionEn}"
Chinese caption: "${img.captionZh}"

Check the following:
1. Does the caption accurately describe the main subject(s) in the image?
2. Are there any factual errors?
3. Are there important visual elements missing from the caption?
4. Is there anything in the caption that contradicts the image?
5. Does the Chinese translation accurately match the English caption?

Respond ONLY in this exact JSON format:
{
  "status": "verified" | "uncertain" | "error",
  "confidence": <0-100>,
  "issues": ["specific issue 1"],
  "suggestion": "corrected caption or improvement suggestion"
}`;

        const rawResponse = await callVisionAPI(imagePath, prompt, settings);

        let verification;
        try {
          const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            verification = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('parse error');
          }
        } catch (e) {
          verification = {
            status: 'uncertain',
            confidence: 50,
            issues: ['AI 响应解析失败'],
            suggestion: '',
          };
        }

        img.verificationStatus = verification.status || 'uncertain';
        img.verificationConfidence = verification.confidence || 0;
        img.verificationNote = JSON.stringify({
          issues: verification.issues || [],
          suggestion: verification.suggestion || '',
        });
        img.verifiedAt = new Date().toISOString();

        if (img.verificationStatus === 'verified') verifiedCount++;
        else if (img.verificationStatus === 'uncertain') uncertainCount++;
        else errorCount++;

        results.push({ id: img.id, status: img.verificationStatus, image: img });
      } catch (e) {
        results.push({ id: img.id, status: 'error', error: e.message });
        errorCount++;
      }
      saveProjectMeta(req.params.id, meta);
    }

    res.json({
      verifiedCount,
      uncertainCount,
      errorCount,
      total: toVerify.length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 导出 API ============

// 导出项目为 ZIP
app.get('/api/projects/:id/export', (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;

    const projectName = meta.name.replace(/[^\w\u4e00-\u9fa5\-_]/g, '_');
    const zipFileName = `${projectName}_flux_training_data.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipFileName)}`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('导出错误:', err);
      res.status(500).json({ error: err.message });
    });
    archive.pipe(res);

    const projectDir = path.join(PROJECTS_DIR, req.params.id);
    const triggerWord = meta.triggerWord || '';

    // 添加每张图片和对应的标语文件
    for (const img of meta.images) {
      const croppedFile = path.join(projectDir, img.croppedPath);
      if (fs.existsSync(croppedFile)) {
        const baseName = path.basename(img.croppedPath, path.extname(img.croppedPath));
        const ext = path.extname(img.croppedPath);

        // 添加图片
        archive.file(croppedFile, { name: `${baseName}${ext}` });

        // 添加英文标语文件（FLUX 训练用）
        let caption = img.captionEn || '';
        if (triggerWord) {
          caption = triggerWord + ' ' + caption;
        }
        archive.append(caption, { name: `${baseName}.txt` });
      }
    }

    // 添加汇总 JSON（包含中英文对照）
    const summary = meta.images.map(img => ({
      filename: path.basename(img.croppedPath),
      captionEn: img.captionEn,
      captionZh: img.captionZh,
      verificationStatus: img.verificationStatus,
      verificationConfidence: img.verificationConfidence,
      verificationNote: img.verificationNote ? JSON.parse(img.verificationNote) : null,
    }));
    archive.append(JSON.stringify({
      project: meta.name,
      exportDate: new Date().toISOString(),
      triggerWord: triggerWord,
      totalImages: meta.images.length,
      images: summary,
    }, null, 2), { name: 'caption_summary.json' });

    // 添加中英文对照 CSV
    let csvContent = '\uFEFFfilename,english_caption,chinese_caption,verification_status,confidence,issues\n';
    for (const img of meta.images) {
      const filename = path.basename(img.croppedPath);
      const en = (img.captionEn || '').replace(/"/g, '""');
      const zh = (img.captionZh || '').replace(/"/g, '""');
      let issues = '';
      if (img.verificationNote) {
        try {
          const note = JSON.parse(img.verificationNote);
          issues = (note.issues || []).join('; ').replace(/"/g, '""');
        } catch (e) {}
      }
      csvContent += `"${filename}","${en}","${zh}","${img.verificationStatus}","${img.verificationConfidence}","${issues}"\n`;
    }
    archive.append(csvContent, { name: 'caption_bilingual.csv' });

    archive.finalize();
  } catch (e) {
    console.error('导出错误:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ 重新裁剪 API ============

app.post('/api/projects/:id/images/:imageId/recrop', async (req, res) => {
  try {
    const meta = getAccessibleProject(req, res);
    if (!meta) return;
    const img = meta.images.find(i => i.id === req.params.imageId);
    if (!img) return res.status(404).json({ error: '图片不存在' });

    const cropMode = req.body.cropMode || meta.cropMode || 'attention';
    const projectDir = path.join(PROJECTS_DIR, req.params.id);
    const originalFile = path.join(projectDir, img.originalPath);
    const croppedFile = path.join(projectDir, img.croppedPath);

    let pipeline = sharp(originalFile);
    if (cropMode === 'contain') {
      pipeline = pipeline.resize(1024, 1024, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      });
    } else if (cropMode === 'center') {
      pipeline = pipeline.resize(1024, 1024, { fit: 'cover', position: 'center' });
    } else {
      pipeline = pipeline.resize(1024, 1024, { fit: 'cover', position: 'attention' });
    }
    pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
    await pipeline.toFile(croppedFile);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  FLUX Tagger 已启动`);
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
