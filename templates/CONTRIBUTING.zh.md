# 知识库内容贡献指南

> **[English Version](./CONTRIBUTING.md)**

本指南说明如何向 ClawDeckX 知识中心添加新内容 — 包括配方指南、技巧、配置片段和常见问题。

## 内容类型

| 类型 | 用途 | 关键字段 |
|------|------|----------|
| `recipe` | 分步配置指南（可视化操作步骤） | `body`, `steps[]` |
| `tip` | 快捷知识卡片 | `body` |
| `snippet` | 可复制的配置参考 | `snippet`, `snippetLanguage` |
| `faq` | 常见问答 | `question`, `answer` |

## 文件结构

```
templates/official/knowledge/
├── index.json          # 所有条目的注册表
├── recipes/
│   └── my-recipe.json
├── tips/
│   └── my-tip.json
├── snippets/
│   └── my-snippet.json
└── faq/
    └── my-faq.json
```

## 添加新条目的步骤

### 1. 创建 JSON 文件

将文件放入对应子目录。文件必须符合 `templates/schema/template.schema.json` 的规范。

**通用字段（所有类型）：**

```json
{
  "id": "my-unique-id",
  "type": "tip",
  "version": "1.0.0",
  "metadata": {
    "name": "中文标题",
    "description": "一句话摘要",
    "category": "tips",
    "difficulty": "easy",
    "icon": "lightbulb",
    "tags": ["soul", "beginner"],
    "author": "你的名字",
    "featured": false,
    "lastUpdated": "2026-03-07T00:00:00Z",
    "i18n": {
      "en": {
        "name": "English Title",
        "description": "English description"
      }
    }
  },
  "content": { ... }
}
```

> **注意**：默认的 `name`/`description` 使用中文。通过 `i18n.en` 字段添加英文翻译。

### 2. 注册到 index.json

将相对路径添加到 `templates/official/knowledge/index.json`：

```json
{
  "category": "knowledge",
  "version": "1.1.0",
  "templates": [
    "tips/my-tip.json"
  ]
}
```

### 3. 验证

运行 schema 校验脚本：

```bash
node templates/scripts/validate-templates.mjs
```

## 各类型示例

### 配方指南（Recipe）

配方指南应描述 **ClawDeckX 可视化界面操作步骤**，而非 CLI 命令。

```json
{
  "id": "recipe-add-channel",
  "type": "recipe",
  "version": "1.0.0",
  "metadata": {
    "name": "添加消息频道",
    "description": "通过配置中心添加 Telegram/Discord 等消息频道",
    "category": "recipes",
    "difficulty": "easy",
    "icon": "menu_book",
    "tags": ["channel", "setup", "beginner"],
    "author": "ClawDeckX Team",
    "lastUpdated": "2026-03-07T00:00:00Z",
    "i18n": {
      "en": {
        "name": "Add a Messaging Channel",
        "description": "Add Telegram/Discord channels via Config Center"
      }
    }
  },
  "content": {
    "body": "通过 ClawDeckX 可视化界面为你的 AI 代理连接消息频道。",
    "steps": [
      {
        "title": "打开配置中心",
        "description": "从桌面或 Dock 栏进入「配置中心 → 频道」。"
      },
      {
        "title": "添加频道",
        "description": "点击「添加频道」，选择频道类型（Telegram、Discord 等），填入 Bot Token。"
      },
      {
        "title": "验证",
        "description": "打开「健康中心」运行诊断，确认频道已成功连接。"
      }
    ]
  }
}
```

### 技巧（Tip）

```json
{
  "id": "tip-soul-writing",
  "type": "tip",
  "version": "1.0.0",
  "metadata": {
    "name": "SOUL.md 编写技巧",
    "description": "让你的 AI 代理个性更鲜明",
    "category": "tips",
    "difficulty": "easy",
    "icon": "lightbulb",
    "tags": ["soul", "writing", "beginner"],
    "author": "ClawDeckX Team",
    "lastUpdated": "2026-03-07T00:00:00Z",
    "i18n": {
      "en": {
        "name": "SOUL.md Writing Tips",
        "description": "Make your AI agent's personality shine"
      }
    }
  },
  "content": {
    "body": "## 1. 具体明确\n\n不要说"要有帮助"。要说"当用户询问代码时，先提供一个可运行的示例，然后再解释"。\n\n## 2. 使用第一人称\n\n以代理自我描述的方式编写：\"我是一个...\" 而不是 \"代理应该...\"\n\n> **提示**：在 **配置中心 → 身份** 中使用可视化编辑器编辑 SOUL.md。"
  }
}
```

### 配置片段（Snippet）

```json
{
  "id": "snippet-cron-digest",
  "type": "snippet",
  "version": "1.0.0",
  "metadata": {
    "name": "定时摘要任务",
    "description": "每天早上 8 点自动发送消息摘要",
    "category": "snippets",
    "difficulty": "medium",
    "icon": "code",
    "tags": ["cron", "heartbeat", "automation"],
    "author": "ClawDeckX Team",
    "lastUpdated": "2026-03-07T00:00:00Z",
    "i18n": {
      "en": {
        "name": "Daily Digest Cron Job",
        "description": "Send a daily summary every morning at 8am"
      }
    }
  },
  "content": {
    "snippet": "# HEARTBEAT.md\n\n## 每日摘要\n\n```cron\n0 8 * * *\n```\n\n每天早上 8:00 自动汇总：\n- 所有频道的未读消息\n- 今日日历事件\n- 待办任务列表\n\n# 配置路径：配置中心 → 自动化 → 心跳任务",
    "snippetLanguage": "markdown"
  }
}
```

### 常见问答（FAQ）

```json
{
  "id": "faq-agent-not-responding",
  "type": "faq",
  "version": "1.0.0",
  "metadata": {
    "name": "代理无响应",
    "description": "排查 AI 代理停止回复的问题",
    "category": "faq",
    "difficulty": "easy",
    "icon": "help",
    "tags": ["troubleshooting", "gateway", "connection"],
    "author": "ClawDeckX Team",
    "lastUpdated": "2026-03-07T00:00:00Z",
    "i18n": {
      "en": {
        "name": "Agent Not Responding",
        "description": "Troubleshoot when your agent stops replying"
      }
    }
  },
  "content": {
    "question": "AI 代理不回复消息怎么办？",
    "answer": "## 常见原因\n\n1. **网关未运行** — 打开仪表盘，点击「启动网关」\n2. **API Key 过期** — 前往「配置中心 → 模型」检查 API Key\n3. **频道断开** — 检查「配置中心 → 频道」的连接状态\n\n## 快速修复\n\n打开桌面上的 **健康中心**，点击 **一键修复** 自动解决常见问题。",
    "relatedDoctorChecks": ["gateway.status", "api.key", "channel.connected"]
  }
}
```

## 元数据规范

- **`id`**：小写字母加连字符，全局唯一
- **`difficulty`**：`easy`（入门级）、`medium`（需要一定经验）、`hard`（高级用户）
- **`featured`**：仅对必读/推荐条目设为 `true`（每个子类别最多 3 个）
- **`lastUpdated`**：ISO 8601 格式，内容变更时更新
- **`tags`**：2-5 个相关标签，小写
- **`relatedTemplates`**：关联的其他知识条目 ID，用于交叉链接

## 多语言（i18n）

知识条目通过 `metadata.i18n` 字段支持内联多语言：

```json
{
  "metadata": {
    "name": "默认中文标题",
    "description": "默认中文描述",
    "i18n": {
      "en": {
        "name": "English Title",
        "description": "English description"
      }
    }
  }
}
```

规则：
1. 默认 `name`/`description` 使用**中文**（主语言）
2. 通过 `i18n.en` 添加英文翻译
3. 代码片段、文件路径和技术术语通常**不翻译**
4. `content` 字段使用默认语言；仅在需要时添加 i18n 覆盖

## 校验

所有 JSON 文件在 CI 中会自动校验。本地运行：

```bash
node templates/scripts/validate-templates.mjs
```

校验内容：
- JSON 语法
- Schema 规范（`template.schema.json`）
- 全局 ID 唯一性
- 索引完整性（所有文件已注册，无孤立文件）
