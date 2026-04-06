#!/usr/bin/env node
/**
 * ci-compat-gate.mjs — CI compatibility gate for OpenClaw upgrades.
 *
 * Reads a JSON report from track-openclaw-upgrade.mjs and exits with
 * a non-zero code if there are critical (P0) action items.
 *
 * Usage:
 *   node scripts/track-openclaw-upgrade.mjs --skip-pull --json > report.json
 *   node scripts/ci-compat-gate.mjs report.json
 *   node scripts/ci-compat-gate.mjs report.json --local  # local mode (warnings only)
 *
 * Exit codes:
 *   0 = all clear
 *   1 = P0 action items found (CI should fail)
 *   2 = report file not found or parse error
 */

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const reportPath = args.find(a => !a.startsWith('-'));
const localMode = args.includes('--local');

if (!reportPath) {
  console.error('Usage: ci-compat-gate.mjs <report.json> [--local]');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`Failed to read/parse report: ${e.message}`);
  process.exit(2);
}

const actions = report.actionItems || [];
const p0 = actions.filter(a => a.priority === 'P0');
const p1 = actions.filter(a => a.priority === 'P1');
const p2 = actions.filter(a => a.priority === 'P2');

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  ClawDeckX Compatibility Gate');
console.log('═══════════════════════════════════════════');
console.log('');

if (report.latestVersion) {
  console.log(`  OpenClaw latest: v${report.latestVersion}`);
}
if (report.newVersions?.length > 0) {
  console.log(`  New versions: ${report.newVersions.join(', ')}`);
}

console.log(`  Action items: ${p0.length} P0, ${p1.length} P1, ${p2.length} P2`);
console.log('');

if (p0.length > 0) {
  console.log('🔴 CRITICAL issues found:');
  for (const item of p0) {
    console.log(`  - [${item.category}] ${item.description}`);
  }
  console.log('');
}

if (p1.length > 0) {
  console.log('🟡 IMPORTANT items:');
  for (const item of p1) {
    console.log(`  - [${item.category}] ${item.description}`);
  }
  console.log('');
}

if (p2.length > 0) {
  console.log('🔵 Review items:');
  for (const item of p2) {
    console.log(`  - [${item.category}] ${item.description}`);
  }
  console.log('');
}

// Stale paths summary
if (report.stalePaths?.length > 0) {
  console.log(`⚠️  ${report.stalePaths.length} stale config path reference(s) found:`);
  for (const sp of report.stalePaths) {
    console.log(`  - ${sp.file}:${sp.line} → "${sp.removedKey}"`);
  }
  console.log('');
}

// Config diff summary
if (report.configDiff) {
  const { added, removed, changed } = report.configDiff;
  if (added?.length > 0 || removed?.length > 0) {
    console.log(`📊 Config diff: +${added?.length || 0} added, -${removed?.length || 0} removed, ~${changed?.length || 0} changed`);
    console.log('');
  }
}

console.log('═══════════════════════════════════════════');

if (p0.length > 0) {
  if (localMode) {
    console.log('⚠️  P0 issues found (local mode — warning only)');
    console.log('   Fix before pushing to CI.');
    process.exit(0);
  } else {
    console.log('❌ GATE FAILED — P0 issues must be resolved');
    process.exit(1);
  }
} else if (p1.length > 0) {
  console.log('⚠️  GATE PASSED with warnings (P1 items pending)');
  process.exit(0);
} else {
  console.log('✅ GATE PASSED — ClawDeckX is compatible');
  process.exit(0);
}
