import { ObjectId } from 'mongodb';

function isObjectId(value: unknown): value is ObjectId {
  return value instanceof ObjectId || (typeof value === 'object' && value !== null && '_bsontype' in value && (value as { _bsontype: unknown })._bsontype === 'ObjectId');
}

export function normalizeValue(value: unknown): unknown {
  if (isObjectId(value)) {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = normalizeValue(v);
    }
    return result;
  }
  return value;
}

export function normalizeDoc(doc: Record<string, unknown>): Record<string, unknown> {
  return normalizeValue(doc) as Record<string, unknown>;
}

export function normalizeResultSet(
  docs: Record<string, unknown>[],
  opts: { orderMatters?: boolean } = {}
): unknown[] {
  const normalized = docs.map(normalizeDoc);
  if (opts.orderMatters) return normalized;
  return [...normalized].sort((a, b) => String(a._id).localeCompare(String(b._id)));
}
