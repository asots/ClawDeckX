# Contributing Knowledge Content

> **[中文版](./CONTRIBUTING.zh.md)**

This guide explains how to add new content to the ClawDeckX Knowledge Hub — recipes, tips, config snippets, and FAQs.

## Content Types

| Type | Purpose | Key Fields |
|------|---------|------------|
| `recipe` | Step-by-step guides (visual UI operations) | `body`, `steps[]` |
| `tip` | Quick knowledge cards | `body` |
| `snippet` | Copy-paste config references | `snippet`, `snippetLanguage` |
| `faq` | Question & answer | `question`, `answer` |

## File Structure

```
templates/official/knowledge/
├── index.json          # Registry of all items
├── recipes/
│   └── my-recipe.json
├── tips/
│   └── my-tip.json
├── snippets/
│   └── my-snippet.json
└── faq/
    └── my-faq.json
```

## Step-by-Step: Adding a New Item

### 1. Create the JSON file

Place it in the appropriate subdirectory. The file must conform to `templates/schema/template.schema.json`.

**Common fields (all types):**

```json
{
  "id": "my-unique-id",
  "type": "tip",
  "version": "1.0.0",
  "metadata": {
    "name": "Human-readable Title",
    "description": "One-line summary",
    "category": "tips",
    "difficulty": "easy",
    "icon": "lightbulb",
    "tags": ["soul", "beginner"],
    "author": "Your Name",
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

> **Note**: The default `name`/`description` should be in Chinese. Add an `i18n.en` block for the English translation.

### 2. Register in index.json

Add the relative path to `templates/official/knowledge/index.json`:

```json
{
  "category": "knowledge",
  "version": "1.1.0",
  "templates": [
    "tips/my-tip.json"
  ]
}
```

### 3. Validate

Run the schema validation script:

```bash
node templates/scripts/validate-templates.mjs
```

## Examples by Type

### Recipe

Recipes should describe **ClawDeckX visual UI steps**, not CLI commands.

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
    "body": "Connect a messaging channel to your AI agent through the ClawDeckX visual interface.",
    "steps": [
      {
        "title": "Open Config Center",
        "description": "Go to Config Center → Channels from the desktop or dock."
      },
      {
        "title": "Add Channel",
        "description": "Click 'Add Channel', select the channel type (Telegram, Discord, etc.), and fill in the Bot Token."
      },
      {
        "title": "Verify",
        "description": "Open the Doctor (Health Center) and run diagnostics to confirm the channel is connected."
      }
    ]
  }
}
```

### Tip

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
    "body": "## 1. Be Specific\n\nDon't say \"be helpful\". Say \"when the user asks about code, provide a working example first, then explain\".\n\n## 2. Use First Person\n\nWrite as if the agent is describing itself: \"I am a...\" not \"The agent should...\"\n\n> **Tip**: Edit SOUL.md in **Config Center → Identity** using the visual editor."
  }
}
```

### Config Snippet

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
    "snippet": "# HEARTBEAT.md\n\n## Daily Digest\n\n```cron\n0 8 * * *\n```\n\nEvery morning at 8:00 AM, summarize:\n- Unread messages from all channels\n- Calendar events for today\n- Pending tasks from the task tracker\n\n# Configure in: Config Center → Automation → Heartbeat",
    "snippetLanguage": "markdown"
  }
}
```

### FAQ

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
    "question": "Why is my agent not responding to messages?",
    "answer": "## Common Causes\n\n1. **Gateway not running** — Open the Dashboard and click 'Start Gateway'\n2. **API key expired** — Go to Config Center → Models and verify your API key\n3. **Channel disconnected** — Check Config Center → Channels\n\n## Quick Fix\n\nOpen **Doctor (Health Center)** from the desktop and click **Fix All** to auto-resolve common issues.",
    "relatedDoctorChecks": ["gateway.status", "api.key", "channel.connected"]
  }
}
```

## Metadata Guidelines

- **`id`**: lowercase, hyphens only, unique across all knowledge items
- **`difficulty`**: `easy` (beginner-friendly), `medium` (some experience needed), `hard` (advanced users)
- **`featured`**: set `true` only for essential/recommended items (max ~3 per subcategory)
- **`lastUpdated`**: ISO 8601 format, update whenever content changes
- **`tags`**: 2-5 relevant tags, lowercase
- **`relatedTemplates`**: array of other knowledge item IDs for cross-linking

## i18n (Translations)

Knowledge items support inline i18n via the `metadata.i18n` field:

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

Rules:
1. Default `name`/`description` should be in **Chinese** (primary language)
2. Add `i18n.en` for English translations
3. Code snippets, file paths, and technical terms should generally NOT be translated
4. The `content` field uses the default language; add i18n overrides only when needed

## Validation

All JSON files are validated against the schema in CI. Run locally:

```bash
node templates/scripts/validate-templates.mjs
```

This checks:
- JSON syntax
- Schema conformance (`template.schema.json`)
- Unique IDs across all items
- Index completeness (all files in index, no orphans)
