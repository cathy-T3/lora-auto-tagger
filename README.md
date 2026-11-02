# FLUX Tagger — 汽车 LoRA 训练数据自动打标工具

为不同车型 AI 生成模型 LoRA 训练提供标准化图像标注方案。基于多张实拍车辆素材建立完整打标词库与标签编排规范，统一视角、车身涂装、车身部件标签体系，输出严格一一对应的中英双语标注结果，产出可直接用于模型训练的数据集。

## 功能特性

- **图片上传与自动裁剪**：支持 JPG / PNG / WebP / BMP / TIFF，自动裁剪为 1024×1024（智能 / 中心 / 包含三种模式）

- **AI 视觉打标**：调用 OpenAI 兼容视觉模型，输出中英双语标签，严格一一对应

- **汽车标签预设**：内置视角（正面 / 左前 45° / 右后 45° 等 11 种）、车身涂装、车身部件标签体系，快捷插入

- **智能验证核查**：AI 自动比对图片与标签，标记不确定 / 错误项，辅助人工修正

- **批量处理**：一键全部打标、全部验证，实时进度反馈

- **一键导出训练集**：打包图片 + 英文标签 txt + 中英对照 CSV + JSON 汇总

- **多用户隔离**：登录认证 + 项目数据按用户隔离，互不干扰

## 环境要求

- Node.js 18+

- 一个支持图片输入的视觉模型 API（OpenAI、MiniMax、Qwen-VL 等 OpenAI 兼容接口均可）

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/cathy-T3/lora-auto-tagger.git
cd lora-auto-tagger

# 2. 安装依赖
npm install

# 3. 配置 API Key（二选一）
#    方式一：复制示例配置后手动填写
cp settings.example.json settings.json
#    方式二：启动后在网页右上角「设置」里填写

# 4. 启动
npm start
```

打开浏览器访问 <http://localhost:3000>

## 配置 API Key

工具本身**不内置任何密钥**，需要你填写自己的 API Key。`settings.json` 结构如下：

```json
{
  "apiBaseUrl": "https://api.openai.com/v1",
  "apiKey": "在这里填入你自己的 API Key",
  "model": "gpt-4o",
  "cropMode": "attention",
  "captionStyle": "natural",
  "language": "bilingual"
}
```

- `apiBaseUrl`：OpenAI 兼容接口地址（各家厂商不同，如 `https://api.minimaxi.com/v1`）

- `apiKey`：你的 API 密钥

- `model`：支持图片输入的视觉模型名称

> ⚠️ 不要把含真实密钥的 `settings.json` 提交到 Git 仓库。

## 登录认证与多用户

工具默认启用登录认证，支持两种角色：

| 角色   | 登录方式                | 权限            |
| ---- | ------------------- | ------------- |
| 管理员  | 用户名 `admin` + 管理员密码 | 查看所有项目、修改全局设置 |
| 普通用户 | 任意用户名 + 访问密码        | 仅查看自己的项目      |

默认密码（首次启动自动生成，建议修改）：

- 管理员：`admin` / `admin123`

- 普通用户访问密码：`flux2026`

密码配置保存在 `auth.json`（已 gitignore，不会上传）。可参考 `auth.example.json` 修改。

## 使用流程

1. 登录后点击「新建项目」，填写项目名称、触发词、选择打标模板
2. 上传车辆图片，工具自动裁剪
3. 点击「全部打标」，AI 生成中英双语标签
4. 在图片详情中核对 / 修正标签（可快捷插入汽车标签）
5. 点击「全部验证」，AI 核查标注质量
6. 点击「导出」下载训练数据集

## 目录结构

```
.
├── server.js               # 后端服务（Express）
├── package.json
├── public/                 # 前端页面
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── settings.example.json   # API 配置模板（复制为 settings.json 使用）
├── auth.example.json       # 认证配置模板（复制为 auth.json 使用）
└── projects/               # 项目数据（本地生成，不提交）
```

## 隐私与安全

以下文件/目录已加入 `.gitignore`，**不会被提交到仓库**，请注意不要手动强制提交：

- `settings.json` —— 含你的 API Key

- `auth.json` —— 含你的登录密码

- `projects/` —— 你的项目图片与标注数据

## 技术栈

- Node.js + Express

- sharp（图片裁剪）

- multer（文件上传）

- archiver（ZIP 导出）

- 原生前端（无框架）

