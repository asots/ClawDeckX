#!/usr/bin/env node
/**
 * track-openclaw-upgrade.mjs — Unified OpenClaw Upgrade Tracker
 *
 * One-command pipeline that:
 *   1. Syncs the local openclaw repo (git fetch + pull)
 *   2. Detects version changes (current compat → latest tag)
 *   3. Parses CHANGELOG.md for new versions since last tracked
 *   4. Takes a config field snapshot and diffs against the previous one
 *   5. Runs the full audit suite (schema, fields, UI coverage, compat)
 *   6. Generates a structured upgrade report with prioritized action items
 *   7. Optionally generates missing docs/openclaw_update/{version}.md stubs
 *
 * Usage:
 *   node scripts/track-openclaw-upgrade.mjs                    # full pipeline
 *   node scripts/track-openclaw-upgrade.mjs --skip-pull        # skip git pull
 *   node scripts/track-openclaw-upgrade.mjs --skip-audit       # skip audit suite
 *   node scripts/track-openclaw-upgrade.mjs --generate-docs    # also generate update docs
 *   node scripts/track-openclaw-upgrade.mjs --json             # JSON output
 */
import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const OPENCLAW_PATH = path.resolve(REPO_ROOT, '..', 'openclaw');
const SNAPSHOTS_DIR = path.join(REPO_ROOT, 'docs', 'config-snapshots');
const UPDATE_DOCS_DIR = path.join(REPO_ROOT, 'docs', 'openclaw_update');
const PKG_JSON = path.join(REPO_ROOT, 'web', 'package.json');

// ── CLI args ──
const args = process.argv.slice(2);
const FLAG = {
  skipPull: args.includes('--skip-pull'),
  skipAudit: args.includes('--skip-audit'),
  generateDocs: args.includes('--generate-docs'),
  json: args.includes('--json'),
  verbose: args.includes('--verbose') || args.includes('-v'),
};

// ── Helpers ──
const CYAN = '\x1b[36m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m';
const DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

function log(msg, color = '') { if (!FLAG.json) console.log(`${color}${msg}${RESET}`); }
function logStep(n, msg) { log(`\n${'━'.repeat(60)}`, DIM); log(`  Step ${n}: ${msg}`, BOLD + CYAN); log(`${'━'.repeat(60)}`, DIM); }
function logOk(msg) { log(`  ✅ ${msg}`, GREEN); }
function logWarn(msg) { log(`  ⚠️  ${msg}`, YELLOW); }
function logErr(msg) { log(`  ❌ ${msg}`, RED); }
function logInfo(msg) { log(`  ${msg}`); }

function run(cmd, cwd = REPO_ROOT) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return e.stdout?.trim() || '';
  }
}

function runSpawn(cmd, args, cwd = REPO_ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return { stdout: r.stdout?.trim() || '', stderr: r.stderr?.trim() || '', code: r.status };
}

function fileExists(p) { return fs.existsSync(p); }

// ── Collect report data ──
const report = {
  timestamp: new Date().toISOString(),
  currentCompat: '',
  latestVersion: '',
  newVersions: [],
  configDiff: null,
  auditResults: null,
  changelog: [],
  actionItems: [],
};

// ════════════════════════════════════════════════════════════════
// Step 1: Sync openclaw repo
// ════════════════════════════════════════════════════════════════
logStep(1, 'Sync OpenClaw Repository');

if (!fileExists(OPENCLAW_PATH)) {
  logErr(`OpenClaw repo not found at ${OPENCLAW_PATH}`);
  process.exit(1);
}

if (FLAG.skipPull) {
  logWarn('Skipping git pull (--skip-pull)');
} else {
  logInfo('Fetching latest...');
  run('git fetch --all --tags --prune', OPENCLAW_PATH);
  const pullResult = runSpawn('git', ['pull', '--ff-only', 'origin', 'main'], OPENCLAW_PATH);
  if (pullResult.code === 0) {
    logOk('Repository synced');
    if (pullResult.stdout && pullResult.stdout !== 'Already up to date.') {
      logInfo(pullResult.stdout.split('\n').slice(0, 3).join('\n  '));
    }
  } else {
    logWarn('Fast-forward pull failed (may have local changes), fetch-only completed');
  }
}

// ════════════════════════════════════════════════════════════════
// Step 2: Detect versions
// ════════════════════════════════════════════════════════════════
logStep(2, 'Detect Version Changes');

// Current ClawDeckX compat version
const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
const currentCompat = (pkg.openclawCompat || '').replace(/^>=/, '');
report.currentCompat = currentCompat;
logInfo(`ClawDeckX compat version : ${currentCompat}`);

// OpenClaw package.json version
const ocPkg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_PATH, 'package.json'), 'utf8'));
const ocVersion = ocPkg.version;
logInfo(`OpenClaw source version  : ${ocVersion}`);

// Latest git tag
const tagsRaw = run('git tag --sort=-version:refname -l "v*"', OPENCLAW_PATH);
const allTags = tagsRaw.split('\n').filter(Boolean);
const latestTag = allTags[0] || `v${ocVersion}`;
report.latestVersion = latestTag.replace(/^v/, '');
logInfo(`Latest git tag           : ${latestTag}`);

// Find versions between current compat and latest
const compatTag = `v${currentCompat}`;
const newTags = [];
for (const tag of allTags) {
  if (tag === compatTag) break;
  newTags.push(tag);
}
report.newVersions = newTags.map(t => t.replace(/^v/, ''));

if (newTags.length === 0) {
  logOk('Already tracking the latest version!');
} else {
  logWarn(`${newTags.length} new version(s) since ${compatTag}: ${newTags.join(', ')}`);
}

// ════════════════════════════════════════════════════════════════
// Step 3: Parse CHANGELOG
// ════════════════════════════════════════════════════════════════
logStep(3, 'Parse CHANGELOG');

const changelogPath = path.join(OPENCLAW_PATH, 'CHANGELOG.md');
const changelogContent = fs.readFileSync(changelogPath, 'utf8');

// Parse sections by version header: ## 2026.x.y or ## Unreleased
const versionSections = [];
const sectionRegex = /^## (.+)$/gm;
let match;
const sectionStarts = [];
while ((match = sectionRegex.exec(changelogContent)) !== null) {
  sectionStarts.push({ version: match[1].trim(), index: match.index });
}

for (let i = 0; i < sectionStarts.length; i++) {
  const start = sectionStarts[i].index;
  const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : changelogContent.length;
  const body = changelogContent.slice(start, end).trim();
  versionSections.push({ version: sectionStarts[i].version, body });
}

// Filter to versions newer than current compat (including Unreleased)
const BREAKING_KEYWORDS = ['breaking', 'removed', 'deprecated', 'renamed', 'restructured', 'migration', 'incompatible'];
const CLAWDECKX_KEYWORDS = ['config', 'gateway', 'session', 'channel', 'plugin', 'hook', 'cron', 'agent', 'rpc', 'json-rpc', 'websocket', 'protocol', 'schema', 'browser', 'tool', 'memory', 'auth', 'model', 'exec'];

for (const section of versionSections) {
  const isUnreleased = section.version.toLowerCase() === 'unreleased';
  const isNew = isUnreleased || report.newVersions.some(v => section.version.includes(v));

  if (!isNew && section.version !== currentCompat) continue;

  // Extract breaking changes
  const breaking = [];
  const relevant = [];
  const lines = section.body.split('\n');
  let inBreaking = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith('### breaking')) { inBreaking = true; continue; }
    if (lower.startsWith('### ')) { inBreaking = false; }

    if (inBreaking && line.startsWith('- ')) {
      breaking.push(line.replace(/^- /, '').trim());
    }

    // Check for ClawDeckX-relevant changes
    if (line.startsWith('- ')) {
      const matchedKw = CLAWDECKX_KEYWORDS.filter(kw => lower.includes(kw));
      if (matchedKw.length > 0) {
        relevant.push({ text: line.replace(/^- /, '').trim(), keywords: matchedKw });
      }
    }
  }

  const entry = { version: section.version, breaking, relevant, totalLines: lines.length };
  report.changelog.push(entry);

  if (isUnreleased && (breaking.length > 0 || relevant.length > 0)) {
    logWarn(`Unreleased: ${breaking.length} breaking, ${relevant.length} relevant changes`);
  } else if (isNew) {
    logInfo(`${section.version}: ${breaking.length} breaking, ${relevant.length} relevant`);
  }
}

if (report.changelog.length === 0) {
  logOk('No new changelog entries found');
} else {
  const totalBreaking = report.changelog.reduce((s, c) => s + c.breaking.length, 0);
  const totalRelevant = report.changelog.reduce((s, c) => s + c.relevant.length, 0);
  logInfo(`Total: ${totalBreaking} breaking changes, ${totalRelevant} relevant changes`);
}

// ════════════════════════════════════════════════════════════════
// Step 4: Config Field Snapshot & Diff
// ════════════════════════════════════════════════════════════════
logStep(4, 'Config Field Snapshot & Diff');

// Take snapshot of current version
const snapshotScript = path.join(__dirname, 'snapshot-config-fields.mjs');
if (fileExists(snapshotScript)) {
  const snapshotFile = path.join(SNAPSHOTS_DIR, `v${ocVersion}.json`);
  const hadSnapshot = fileExists(snapshotFile);

  logInfo(`Taking snapshot for v${ocVersion}...`);
  const snapResult = runSpawn('node', [snapshotScript, '--version', ocVersion, '--openclaw-path', OPENCLAW_PATH], REPO_ROOT);
  if (snapResult.code === 0) {
    logOk(hadSnapshot ? `Snapshot updated: v${ocVersion}.json` : `New snapshot: v${ocVersion}.json`);
  } else {
    logWarn('Snapshot generation failed');
    if (FLAG.verbose) logInfo(snapResult.stderr);
  }

  // Auto-generate baseline snapshot from compat version tag if missing
  const compatSnapshotFile = path.join(SNAPSHOTS_DIR, `v${currentCompat}.json`);
  if (!fileExists(compatSnapshotFile) && currentCompat !== ocVersion) {
    const compatTagName = `v${currentCompat}`;
    logInfo(`Generating baseline snapshot for ${compatTagName} from git history...`);
    const baseResult = runSpawn('node', [
      snapshotScript, '--version', currentCompat,
      '--openclaw-path', OPENCLAW_PATH,
      '--from-tag', compatTagName,
    ], REPO_ROOT);
    if (baseResult.code === 0) {
      logOk(`Baseline snapshot generated: v${currentCompat}.json`);
    } else {
      logWarn(`Could not generate baseline snapshot for ${compatTagName}`);
    }
  }

  // Find previous snapshot to diff against
  const snapshots = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith('v') && f.endsWith('.json'))
    .map(f => ({ file: f, ver: f.replace(/^v/, '').replace(/\.json$/, '') }))
    .sort((a, b) => a.ver.localeCompare(b.ver));

  if (snapshots.length >= 2) {
    const prev = snapshots[snapshots.length - 2];
    const curr = snapshots[snapshots.length - 1];

    logInfo(`Diffing: v${prev.ver} → v${curr.ver}`);

    const prevData = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, prev.file), 'utf8'));
    const currData = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, curr.file), 'utf8'));

    const prevFields = prevData.fields || {};
    const currFields = currData.fields || {};
    const added = [], removed = [], changed = [];

    for (const k of Object.keys(currFields)) {
      if (!(k in prevFields)) added.push({ key: k, label: currFields[k] });
      else if (prevFields[k] !== currFields[k]) changed.push({ key: k, from: prevFields[k], to: currFields[k] });
    }
    for (const k of Object.keys(prevFields)) {
      if (!(k in currFields)) removed.push({ key: k, label: prevFields[k] });
    }

    report.configDiff = {
      from: prev.ver, to: curr.ver,
      fromTotal: prevData.totalFields, toTotal: currData.totalFields,
      added, removed, changed,
    };

    if (added.length || removed.length || changed.length) {
      logWarn(`Config fields changed: +${added.length} added, -${removed.length} removed, ~${changed.length} label changes`);
      if (added.length > 0 && added.length <= 20) {
        for (const a of added) logInfo(`  + ${a.key}: ${a.label}`);
      }
      if (removed.length > 0 && removed.length <= 10) {
        for (const r of removed) logInfo(`  - ${r.key}: ${r.label}`);
      }
    } else {
      logOk('No config field changes detected');
    }
  } else {
    logInfo('Only one snapshot available — no diff possible yet');
  }
} else {
  logWarn('snapshot-config-fields.mjs not found — skipping');
}

// ════════════════════════════════════════════════════════════════
// Step 5: Run Audit Suite
// ════════════════════════════════════════════════════════════════
logStep(5, 'Audit Suite');

if (FLAG.skipAudit) {
  logWarn('Skipping audit suite (--skip-audit)');
} else {
  const audits = [
    { name: 'Gateway RPC Schema', script: 'audit-openclaw-schema.mjs' },
    { name: 'Config Fields Coverage', script: 'audit-config-fields.mjs' },
    { name: 'Config UI Coverage', script: 'audit-config-ui-coverage.mjs' },
    { name: 'Runtime Compatibility', script: 'audit-compat-check.mjs' },
  ];

  report.auditResults = {};

  for (const audit of audits) {
    const scriptPath = path.join(__dirname, audit.script);
    if (!fileExists(scriptPath)) {
      logWarn(`${audit.name}: script not found, skipping`);
      report.auditResults[audit.name] = { status: 'skipped' };
      continue;
    }

    logInfo(`Running: ${audit.name}...`);
    const start = Date.now();
    const result = runSpawn('node', [scriptPath, OPENCLAW_PATH], REPO_ROOT);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (result.code === 0) {
      logOk(`${audit.name} — PASS (${elapsed}s)`);
      report.auditResults[audit.name] = { status: 'pass', elapsed };
    } else {
      logErr(`${audit.name} — FAIL (${elapsed}s)`);
      report.auditResults[audit.name] = { status: 'fail', elapsed, output: result.stdout.slice(-500) };
    }
  }
}

// ════════════════════════════════════════════════════════════════
// Step 5.5: Stale Path Detector
// ════════════════════════════════════════════════════════════════
logStep('5.5', 'Stale Path Detector');

const removedPaths = report.configDiff?.removed || [];
report.stalePaths = [];

if (removedPaths.length === 0) {
  logOk('No removed config fields — nothing to scan');
} else {
  logInfo(`Scanning ClawDeckX codebase for ${removedPaths.length} removed config paths...`);

  // Directories to scan
  const scanDirs = [
    path.join(REPO_ROOT, 'web'),
    path.join(REPO_ROOT, 'internal'),
  ];
  const scanExts = ['.ts', '.tsx', '.go', '.json'];

  function scanDir(dir, exts) {
    const results = [];
    if (!fileExists(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git', 'public'].includes(entry.name)) continue;
        results.push(...scanDir(full, exts));
      } else if (exts.some(e => entry.name.endsWith(e))) {
        results.push(full);
      }
    }
    return results;
  }

  const files = scanDirs.flatMap(d => scanDir(d, scanExts));
  const staleFindings = [];

  for (const removedField of removedPaths) {
    // Build search patterns from the dotted key
    // e.g. "talk.voiceId" → look for "talk.voiceId", "talk', 'voiceId", ['talk', 'voiceId']
    const key = removedField.key;
    const parts = key.replace(/\[\]/g, '').split('.');
    const patterns = [
      key,                                           // dotted path string
      parts.join("', '"),                            // array path: 'talk', 'voiceId'
      parts.join("', \""),                           // mixed quotes
      parts.join('", "'),                            // double-quoted array
      parts[parts.length - 1],                       // leaf key alone (less precise)
    ];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const relPath = path.relative(REPO_ROOT, filePath);

      // Skip snapshot/report/audit files
      if (relPath.includes('config-snapshots') || relPath.includes('openclaw_update')) continue;
      if (relPath.includes('audit-')) continue;

      // Check for the dotted path or array path form (skip leaf-only, too noisy)
      for (let pi = 0; pi < patterns.length - 1; pi++) {
        const pattern = patterns[pi];
        if (content.includes(pattern)) {
          const lineNum = content.slice(0, content.indexOf(pattern)).split('\n').length;
          staleFindings.push({
            removedKey: key,
            file: relPath,
            line: lineNum,
            pattern,
          });
          break; // one hit per file per key is enough
        }
      }
    }
  }

  report.stalePaths = staleFindings;

  if (staleFindings.length === 0) {
    logOk('No stale config path references found in ClawDeckX code');
  } else {
    logErr(`Found ${staleFindings.length} stale config path reference(s):`);
    for (const f of staleFindings) {
      logInfo(`  ⚠️  ${f.file}:${f.line} → "${f.removedKey}" (matched: "${f.pattern}")`);
    }
  }
}

// ════════════════════════════════════════════════════════════════
// Step 6: Check upgrade doc coverage
// ════════════════════════════════════════════════════════════════
logStep(6, 'Upgrade Documentation');

const existingDocs = fs.readdirSync(UPDATE_DOCS_DIR)
  .filter(f => f.endsWith('.md') && f !== 'README.md')
  .map(f => f.replace('.md', ''));

const missingDocs = report.newVersions.filter(v => !existingDocs.includes(v));

if (missingDocs.length === 0) {
  logOk('All versions have upgrade docs');
} else {
  logWarn(`Missing upgrade docs for: ${missingDocs.join(', ')}`);

  if (FLAG.generateDocs) {
    for (const ver of missingDocs) {
      const section = versionSections.find(s => s.version.includes(ver));
      const docPath = path.join(UPDATE_DOCS_DIR, `${ver}.md`);
      const changelogEntry = report.changelog.find(c => c.version === ver);

      const lines = [
        `# OpenClaw ${ver} 升级检查稿`,
        '',
        `> 自动生成于 ${new Date().toISOString().slice(0, 10)}`,
        `> 来源：\`openclaw/CHANGELOG.md\` 中 \`## ${ver}\``,
        '',
      ];

      // ── Breaking changes (auto-extracted) ──
      const breaking = changelogEntry?.breaking || [];
      lines.push('## 破坏性变更', '');
      if (breaking.length > 0) {
        for (const b of breaking) lines.push(`- ${b}`);
      } else {
        lines.push('无破坏性变更。');
      }
      lines.push('');

      // ── Classify CHANGELOG items into categories ──
      const sectionBody = section?.body || '';
      const clItems = sectionBody.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'));

      const categories = {
        config: { title: '配置相关变更', icon: '⚙️', items: [] },
        gateway: { title: '网关/协议变更', icon: '🌐', items: [] },
        channel: { title: '频道/消息变更', icon: '💬', items: [] },
        plugin: { title: '插件/扩展变更', icon: '🧩', items: [] },
        tool: { title: '工具/执行变更', icon: '🔧', items: [] },
        agent: { title: 'Agent/会话变更', icon: '🤖', items: [] },
        auth: { title: '认证/安全变更', icon: '🔒', items: [] },
        ui: { title: 'UI/浏览器变更', icon: '🖥️', items: [] },
        other: { title: '其他变更', icon: '📝', items: [] },
      };

      const categoryKeywords = {
        config: ['config', 'schema', 'legacy', 'migration', 'renamed', 'deprecated', 'removed'],
        gateway: ['gateway', 'rpc', 'json-rpc', 'websocket', 'protocol', 'discovery', 'tls', 'remote'],
        channel: ['channel', 'telegram', 'whatsapp', 'discord', 'slack', 'signal', 'message', 'broadcast'],
        plugin: ['plugin', 'extension', 'skill', 'hook', 'cron', 'mcp'],
        tool: ['tool', 'exec', 'sandbox', 'browser', 'media', 'web_search', 'pdf', 'canvas'],
        agent: ['agent', 'session', 'memory', 'compaction', 'subagent', 'thinking', 'model'],
        auth: ['auth', 'credential', 'api-key', 'oauth', 'token', 'secret'],
        ui: ['ui', 'browser', 'control-ui', 'webchat', 'viewport'],
      };

      for (const item of clItems) {
        const lower = item.toLowerCase();
        let matched = false;
        for (const [cat, keywords] of Object.entries(categoryKeywords)) {
          if (keywords.some(kw => lower.includes(kw))) {
            categories[cat].items.push(item.trim().replace(/^[-*]\s*/, ''));
            matched = true;
            break;
          }
        }
        if (!matched) categories.other.items.push(item.trim().replace(/^[-*]\s*/, ''));
      }

      // ── Write classified sections ──
      lines.push('## 变更分类', '');
      for (const [, cat] of Object.entries(categories)) {
        if (cat.items.length === 0) continue;
        lines.push(`### ${cat.icon} ${cat.title}`, '');
        for (const item of cat.items) lines.push(`- ${item}`);
        lines.push('');
      }

      // ── Relevant items for ClawDeckX (auto-detected) ──
      const relevant = changelogEntry?.relevant || [];
      lines.push('## 需要 ClawDeckX 关注的变更', '');
      if (relevant.length > 0) {
        for (const r of relevant) lines.push(`- ${r}`);
      } else {
        lines.push('无直接相关的变更。');
      }
      lines.push('');

      // ── Config diff section (auto-generated from snapshot comparison) ──
      const configDiff = report.configDiff;
      if (configDiff && (configDiff.added.length > 0 || configDiff.removed.length > 0 || configDiff.changed.length > 0)) {
        lines.push('## 配置字段变更', '');
        if (configDiff.added.length > 0) {
          lines.push(`### 新增字段 (${configDiff.added.length})`, '');
          lines.push('| 字段路径 | 标签 |', '|---|---|');
          for (const a of configDiff.added) lines.push(`| \`${a.key}\` | ${a.label} |`);
          lines.push('');
        }
        if (configDiff.removed.length > 0) {
          lines.push(`### 移除字段 (${configDiff.removed.length})`, '');
          lines.push('| 字段路径 | 标签 |', '|---|---|');
          for (const r of configDiff.removed) lines.push(`| \`${r.key}\` | ${r.label} |`);
          lines.push('');
        }
        if (configDiff.changed.length > 0) {
          lines.push(`### 标签变更 (${configDiff.changed.length})`, '');
          lines.push('| 字段路径 | 旧标签 | 新标签 |', '|---|---|---|');
          for (const c of configDiff.changed) lines.push(`| \`${c.key}\` | ${c.from} | ${c.to} |`);
          lines.push('');
        }
      }

      // ── Stale path warnings ──
      const stalePaths = (report.stalePaths || []).filter(sp => true);
      if (stalePaths.length > 0) {
        lines.push('## ⚠️ 过期路径引用', '');
        for (const sp of stalePaths) {
          lines.push(`- \`${sp.file}:${sp.line}\` 引用了已移除的 \`${sp.removedKey}\``);
        }
        lines.push('');
      }

      // ── Impact analysis with priorities ──
      const versionActions = actions.filter(a => a.version === ver || a.version === '');
      lines.push('## 对 ClawDeckX 的影响', '');

      const p0 = versionActions.filter(a => a.priority === 'P0');
      const p1 = versionActions.filter(a => a.priority === 'P1');
      const p2 = versionActions.filter(a => a.priority === 'P2');

      if (p0.length > 0) {
        lines.push('### 🔴 高优先级', '');
        for (let i = 0; i < p0.length; i++) lines.push(`${i + 1}. **${p0[i].category}**：${p0[i].description}`);
        lines.push('');
      }
      if (p1.length > 0) {
        lines.push('### 🟡 中优先级', '');
        for (let i = 0; i < p1.length; i++) lines.push(`${i + 1}. **${p1[i].category}**：${p1[i].description}`);
        lines.push('');
      }
      if (p2.length > 0) {
        lines.push('### 🔵 低优先级', '');
        for (let i = 0; i < p2.length; i++) lines.push(`${i + 1}. **${p2[i].category}**：${p2[i].description}`);
        lines.push('');
      }
      if (p0.length === 0 && p1.length === 0 && p2.length === 0) {
        lines.push('无需额外操作。', '');
      }

      // ── Verification checklist ──
      lines.push(
        '## 验证清单',
        '',
        '- [ ] 配置编辑器字段覆盖检查（运行 `node scripts/audit-config-ui-coverage.mjs`）',
        '- [ ] RPC Schema 兼容性检查（运行 `node scripts/audit-openclaw-schema.mjs`）',
        '- [ ] i18n 翻译完整性检查（运行 `node web/locales/check-i18n.mjs`）',
        '- [ ] 过期路径修复（运行 `node scripts/migrate-config-paths.mjs`）',
        '- [ ] TypeScript 编译通过（`cd web && npx tsc --noEmit`）',
        '- [ ] 测试通过（`cd web && npx vitest run`）',
        '- [ ] 构建验证通过（`cd web && npm run build`）',
        '',
      );

      // ── Raw changelog at the end ──
      if (section) {
        lines.push('## 原始变更日志', '', '```', section.body, '```', '');
      }

      fs.writeFileSync(docPath, lines.join('\n'), 'utf8');
      logOk(`Generated doc: ${ver}.md (auto-classified)`);
    }
  } else {
    logInfo('Use --generate-docs to generate stubs');
  }
}

// ════════════════════════════════════════════════════════════════
// Step 7: Generate Action Items & Final Report
// ════════════════════════════════════════════════════════════════
logStep(7, 'Action Items & Summary');

// Priority: P0 = immediate, P1 = important, P2 = nice to have
const actions = [];

// Breaking changes → P0
for (const entry of report.changelog) {
  for (const b of entry.breaking) {
    actions.push({
      priority: 'P0',
      category: 'BREAKING',
      version: entry.version,
      description: b.length > 120 ? b.slice(0, 120) + '...' : b,
    });
  }
}

// Config field additions → P1
if (report.configDiff?.added?.length > 0) {
  // Group by top-level section
  const groups = {};
  for (const a of report.configDiff.added) {
    const sec = a.key.split('.')[0];
    if (!groups[sec]) groups[sec] = [];
    groups[sec].push(a.key);
  }
  for (const [sec, keys] of Object.entries(groups)) {
    actions.push({
      priority: 'P1',
      category: 'CONFIG_ADDED',
      version: report.configDiff.to,
      description: `${keys.length} new config fields in [${sec}]: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` (+${keys.length - 3} more)` : ''}`,
    });
  }
}

// Config field removals → P1
if (report.configDiff?.removed?.length > 0) {
  actions.push({
    priority: 'P1',
    category: 'CONFIG_REMOVED',
    version: report.configDiff.to,
    description: `${report.configDiff.removed.length} config fields removed — check UI for stale controls`,
  });
}

// Audit failures → P1
if (report.auditResults) {
  for (const [name, result] of Object.entries(report.auditResults)) {
    if (result.status === 'fail') {
      actions.push({
        priority: 'P1',
        category: 'AUDIT_FAIL',
        version: report.latestVersion,
        description: `Audit "${name}" failed — investigate and fix`,
      });
    }
  }
}

// Stale path references → P0
if (report.stalePaths?.length > 0) {
  for (const sp of report.stalePaths) {
    actions.push({
      priority: 'P0',
      category: 'STALE_PATH',
      version: report.configDiff?.to || '',
      description: `${sp.file}:${sp.line} still references removed "${sp.removedKey}"`,
    });
  }
}

// Missing docs → P2
if (missingDocs.length > 0 && !FLAG.generateDocs) {
  actions.push({
    priority: 'P2',
    category: 'DOCS_MISSING',
    version: '',
    description: `${missingDocs.length} version(s) missing upgrade docs: ${missingDocs.join(', ')}`,
  });
}

// Relevant CHANGELOG items → P2
const relevantCount = report.changelog.reduce((s, c) => s + c.relevant.length, 0);
if (relevantCount > 0) {
  actions.push({
    priority: 'P2',
    category: 'REVIEW',
    version: '',
    description: `${relevantCount} relevant CHANGELOG items to review (config/gateway/channel/plugin/etc.)`,
  });
}

// Version mismatch → P1
if (report.newVersions.length > 0) {
  actions.push({
    priority: 'P1',
    category: 'VERSION_SYNC',
    version: report.latestVersion,
    description: `Update openclawCompat from >=${currentCompat} to >=${report.latestVersion} in web/package.json`,
  });
}

report.actionItems = actions;

// ── Print final report ──
if (FLAG.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  log(`\n${'═'.repeat(60)}`, BOLD + CYAN);
  log(`  OpenClaw Upgrade Tracker — Summary Report`, BOLD + CYAN);
  log(`${'═'.repeat(60)}`, BOLD + CYAN);
  log('');
  log(`  ClawDeckX compat  : >=${currentCompat}`);
  log(`  OpenClaw latest   : v${report.latestVersion}`);
  log(`  New versions      : ${report.newVersions.length > 0 ? report.newVersions.join(', ') : '(up to date)'}`);

  if (report.configDiff) {
    log('');
    log(`  Config fields     : ${report.configDiff.fromTotal} → ${report.configDiff.toTotal}`);
    log(`    Added           : ${report.configDiff.added.length}`);
    log(`    Removed         : ${report.configDiff.removed.length}`);
    log(`    Label changed   : ${report.configDiff.changed.length}`);
  }

  if (report.stalePaths?.length > 0) {
    log('');
    log(`  ⚠️  Stale paths   : ${report.stalePaths.length} reference(s) to removed config fields found in code`, BOLD + RED);
  }

  if (report.auditResults) {
    log('');
    log(`  Audit results:`, BOLD);
    for (const [name, r] of Object.entries(report.auditResults)) {
      const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭️';
      log(`    ${icon} ${name.padEnd(28)} ${r.status.padEnd(6)} ${r.elapsed || ''}s`);
    }
  }

  if (actions.length > 0) {
    log('');
    log(`  ${'─'.repeat(56)}`, DIM);
    log(`  Action Items (${actions.length}):`, BOLD + YELLOW);
    log('');

    const byPriority = { P0: [], P1: [], P2: [] };
    for (const a of actions) (byPriority[a.priority] || byPriority.P2).push(a);

    const priorityLabels = { P0: '🔴 CRITICAL', P1: '🟡 IMPORTANT', P2: '🔵 REVIEW' };
    for (const [p, items] of Object.entries(byPriority)) {
      if (items.length === 0) continue;
      log(`  ${priorityLabels[p]}:`, BOLD);
      for (const item of items) {
        const tag = item.category.padEnd(16);
        const ver = item.version ? `[${item.version}] ` : '';
        log(`    ${tag} ${ver}${item.description}`);
      }
      log('');
    }
  } else {
    log('');
    logOk('No action items — ClawDeckX is in sync!');
  }

  log(`${'═'.repeat(60)}`, DIM);
  log(`  Report generated: ${report.timestamp}`, DIM);
  log('');

  // Save report
  const reportDir = path.join(REPO_ROOT, 'docs', 'openclaw_update');
  const reportFile = path.join(reportDir, `tracker-report-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  logInfo(`Full report saved: ${path.relative(REPO_ROOT, reportFile)}`);
}
