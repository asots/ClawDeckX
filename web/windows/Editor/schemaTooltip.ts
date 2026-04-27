import { Language } from '../../types';
import { getTooltip } from '../../locales/tooltips';
import defaultsMap from '../../defaults-map.json';

/**
 * Resolve a schema node by dotted config path.
 * e.g. "agents.defaults.maxConcurrent" → walk schema.properties.agents.properties.defaults.properties.maxConcurrent
 */
function resolveSchemaNode(schema: Record<string, any> | null | undefined, dottedPath: string): Record<string, any> | null {
  if (!schema) return null;
  const root = schema.schema || schema;
  const parts = dottedPath.split('.');
  let node = root;
  for (const p of parts) {
    node = node?.properties?.[p];
    if (!node) return null;
  }
  return node;
}

/**
 * Build a range/enum suffix string from a schema node.
 * Examples:
 *   { minimum: 1, maximum: 64 }          → " [1–64]"
 *   { minimum: 0 }                        → " [≥0]"
 *   { maximum: 100 }                      → " [≤100]"
 *   { enum: ["off","on","ask"] }           → " (off | on | ask)"
 *   { type: "boolean" }                    → "" (no suffix needed)
 */
function schemaConstraintSuffix(node: Record<string, any>): string {
  const parts: string[] = [];

  // enum values
  if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.length <= 12) {
    parts.push(`(${node.enum.join(' | ')})`);
  }

  // numeric range
  const min = node.minimum;
  const max = node.maximum;
  if (min != null && max != null) {
    parts.push(`[${min}–${max}]`);
  } else if (min != null) {
    parts.push(`[≥${min}]`);
  } else if (max != null) {
    parts.push(`[≤${max}]`);
  }

  // default value
  if (node.default !== undefined && node.default !== null && node.default !== '') {
    const def = typeof node.default === 'object' ? JSON.stringify(node.default) : String(node.default);
    if (def.length <= 30) {
      parts.push(`Default: ${def}`);
    }
  }

  return parts.length > 0 ? '\n' + parts.join('  ') : '';
}

/**
 * Schema-aware tooltip resolver.
 *
 * Priority:
 * 1. Hand-written locale tooltip (from tooltips.json)
 * 2. Schema description fallback (from OpenClaw config schema)
 * 3. Schema title fallback (from OpenClaw config schema)
 *
 * In all cases, range/enum info from schema is appended.
 */
export function schemaTooltip(
  key: string,
  language: Language,
  schema?: Record<string, any> | null,
): string {
  const handWritten = getTooltip(key, language);
  const node = resolveSchemaNode(schema, key);
  const suffix = node ? schemaConstraintSuffix(node) : '';

  if (handWritten) {
    return handWritten + suffix;
  }

  // Fallback to schema description
  if (node?.description) {
    return node.description + suffix;
  }

  // Fallback to schema title
  if (node?.title) {
    return node.title + suffix;
  }

  return '';
}

/**
 * Extract the schema default value for a config key as a string suitable for placeholder display.
 *
 * Priority:
 * 1. Explicit JSON Schema `default` field (rare in OpenClaw schema)
 * 2. Parsed from description text patterns like "(default: 1200)" or "default: true"
 *
 * Returns empty string when no default can be determined.
 */
export function schemaDefault(
  key: string,
  schema?: Record<string, any> | null,
): string {
  const node = resolveSchemaNode(schema, key);
  if (!node) return '';
  // 1. Explicit schema default
  if (node.default != null) {
    if (typeof node.default === 'object') return JSON.stringify(node.default);
    return String(node.default);
  }
  // 2. Parse from description: "(default: X)", "default: X", "(default X)"
  const desc = node.description;
  if (typeof desc === 'string') {
    const m = desc.match(/\(?default[:\s]\s*([^).]+)\)?/i);
    if (m) return m[1].trim();
  }
  // 3. Fallback to pre-scanned defaults map (generated from OpenClaw source)
  return (defaultsMap as Record<string, string>)[key] || '';
}

export function schemaLabel(
  key: string,
  schema?: Record<string, any> | null,
): string {
  const node = resolveSchemaNode(schema, key);
  if (node?.title) return node.title;
  // Humanize the last segment: "maxConcurrent" → "Max Concurrent"
  const leaf = key.split('.').pop() || key;
  return leaf
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/^./, s => s.toUpperCase());
}
