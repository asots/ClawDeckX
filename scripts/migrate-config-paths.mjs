#!/usr/bin/env node
/**
 * migrate-config-paths.mjs — Automated config path migration tool.
 *
 * Reads migration definitions from config-path-migrations.json and scans
 * ClawDeckX source files for stale config paths, then optionally applies
 * replacements.
 *
 * Usage:
 *   node scripts/migrate-config-paths.mjs                  # dry-run (preview)
 *   node scripts/migrate-config-paths.mjs --apply          # apply replacements
 *   node scripts/migrate-config-paths.mjs --version 2026.4.5  # filter by version
 *
 * Migration definitions file: scripts/config-path-migrations.json
 * Format:
 *   {
 *     "2026.4.5": [
 *       { "from": "talk.voiceId", "to": "agents.defaults.talk.voiceId" },
 *       ...
 *     ]
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, relative, extname } from 'path';
import { execSync } from 'child_process';

const ROOT = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), '..');
const MIGRATIONS_FILE = resolve(ROOT, 'scripts', 'config-path-migrations.json');

// Scan directories and file extensions
const SCAN_DIRS = ['web', 'internal'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.go', '.json', '.mjs']);
const EXCLUDE_PATTERNS = [
  'node_modules', 'dist', '.git', 'package-lock.json', 'go.sum',
  'config-snapshots', 'config-path-migrations.json',
];

// ─── CLI args ───
const args = process.argv.slice(2);
const applyMode = args.includes('--apply');
const versionFilter = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;

// ─── Load migrations ───
function loadMigrations() {
  if (!existsSync(MIGRATIONS_FILE)) {
    console.log(`⚠  No migrations file found at ${relative(ROOT, MIGRATIONS_FILE)}`);
    console.log('   Create it with the format: { "version": [{ "from": "old.path", "to": "new.path" }] }');
    process.exit(0);
  }
  const raw = JSON.parse(readFileSync(MIGRATIONS_FILE, 'utf8'));
  const migrations = [];
  for (const [version, entries] of Object.entries(raw)) {
    if (versionFilter && version !== versionFilter) continue;
    for (const entry of entries) {
      migrations.push({ version, from: entry.from, to: entry.to });
    }
  }
  return migrations;
}

// ─── Collect files to scan ───
function collectFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const fullDir = resolve(ROOT, dir);
    if (!existsSync(fullDir)) continue;
    try {
      const output = execSync(`git ls-files --cached --others --exclude-standard "${dir}"`, {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
      });
      for (const line of output.trim().split('\n')) {
        if (!line) continue;
        const ext = extname(line);
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        if (EXCLUDE_PATTERNS.some(p => line.includes(p))) continue;
        files.push(resolve(ROOT, line));
      }
    } catch {
      console.warn(`Warning: could not list files in ${dir}`);
    }
  }
  return files;
}

// ─── Build search patterns for a dotted path ───
// Matches:
//   1. Dotted string: "talk.voiceId" or 'talk.voiceId'
//   2. Array path: ['talk', 'voiceId'] or ["talk", "voiceId"]
//   3. Tooltip key: tip('talk.voiceId')
//   4. Registry key: 'talk.voiceId' in sectionRegistry
function buildPatterns(dottedPath) {
  const parts = dottedPath.split('.');
  const patterns = [];

  // Dotted string (in quotes)
  patterns.push({
    regex: new RegExp(`(['"\`])${escapeRegex(dottedPath)}\\1`, 'g'),
    replacement: (match, quote) => `${quote}${dottedPath}${quote}`,
    type: 'dotted',
  });

  // Array path: ['a', 'b', 'c'] — match the from segments
  if (parts.length >= 2) {
    const arrayPat = parts.map(p => `['"]${escapeRegex(p)}['"]`).join('\\s*,\\s*');
    patterns.push({
      regex: new RegExp(`\\[\\s*${arrayPat}\\s*\\]`, 'g'),
      type: 'array-path',
    });
  }

  return patterns;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Scan and report ───
function scanFile(filePath, migrations) {
  const content = readFileSync(filePath, 'utf8');
  const hits = [];

  for (const mig of migrations) {
    const fromParts = mig.from.split('.');
    const toParts = mig.to.split('.');

    // 1. Search for dotted string occurrences
    const dottedRegex = new RegExp(`(?<=['"\`])${escapeRegex(mig.from)}(?=['"\`])`, 'g');
    let match;
    while ((match = dottedRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      hits.push({
        migration: mig,
        line,
        type: 'dotted',
        matchStart: match.index,
        matchEnd: match.index + match[0].length,
        matchText: match[0],
        replaceWith: mig.to,
      });
    }

    // 2. Search for array path occurrences: ['a', 'b'] patterns
    if (fromParts.length >= 2) {
      const arrayPat = fromParts.map(p => `['"]${escapeRegex(p)}['"]`).join('\\s*,\\s*');
      const arrayRegex = new RegExp(`\\[\\s*${arrayPat}\\s*\\]`, 'g');
      while ((match = arrayRegex.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        // Build replacement array path
        const replacement = '[' + toParts.map(p => `'${p}'`).join(', ') + ']';
        hits.push({
          migration: mig,
          line,
          type: 'array-path',
          matchStart: match.index,
          matchEnd: match.index + match[0].length,
          matchText: match[0],
          replaceWith: replacement,
        });
      }
    }
  }

  return hits;
}

function applyHits(filePath, hits) {
  let content = readFileSync(filePath, 'utf8');
  // Apply in reverse order to preserve offsets
  const sorted = [...hits].sort((a, b) => b.matchStart - a.matchStart);
  for (const hit of sorted) {
    content = content.substring(0, hit.matchStart) + hit.replaceWith + content.substring(hit.matchEnd);
  }
  writeFileSync(filePath, content, 'utf8');
}

// ─── Main ───
function main() {
  const migrations = loadMigrations();
  if (migrations.length === 0) {
    console.log('No migrations to apply.');
    return;
  }

  console.log(`\n📋 Config Path Migrations (${migrations.length} rules):`);
  for (const m of migrations) {
    console.log(`   ${m.version}: ${m.from} → ${m.to}`);
  }
  console.log('');

  const files = collectFiles();
  console.log(`🔍 Scanning ${files.length} files...\n`);

  let totalHits = 0;
  const fileHits = new Map();

  for (const file of files) {
    const hits = scanFile(file, migrations);
    if (hits.length > 0) {
      const relPath = relative(ROOT, file);
      fileHits.set(file, hits);
      totalHits += hits.length;

      console.log(`  ${relPath} (${hits.length} hit${hits.length > 1 ? 's' : ''}):`);
      for (const hit of hits) {
        console.log(`    L${hit.line} [${hit.type}] ${hit.migration.from} → ${hit.migration.to}`);
        if (!applyMode) {
          console.log(`      - ${hit.matchText}`);
          console.log(`      + ${hit.replaceWith}`);
        }
      }
    }
  }

  if (totalHits === 0) {
    console.log('✅ No stale config paths found.');
    return;
  }

  console.log(`\n📊 Total: ${totalHits} occurrence${totalHits > 1 ? 's' : ''} in ${fileHits.size} file${fileHits.size > 1 ? 's' : ''}`);

  if (applyMode) {
    for (const [file, hits] of fileHits) {
      applyHits(file, hits);
      console.log(`  ✏️  Applied ${hits.length} replacement${hits.length > 1 ? 's' : ''} to ${relative(ROOT, file)}`);
    }
    console.log('\n✅ All replacements applied. Review changes with `git diff`.');
  } else {
    console.log('\n💡 Run with --apply to apply replacements.');
  }
}

main();
