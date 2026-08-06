/**
 * Schema inference for the guided CLI.
 *
 * MongoLite stores documents as JSON, so there is no declared schema to read.
 * We sample documents and derive the field paths, their types, how often they
 * appear and a handful of example values. That is enough to offer the user a
 * list of "columns" to filter and sort on without them knowing anything about
 * the shape of the data up front.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'null';

export interface InferredField {
  /** Dotted path, e.g. `address.city`. */
  path: string;
  /** Every type observed at this path, most frequent first. */
  types: FieldType[];
  /** The most frequently observed type - what the UI builds prompts around. */
  primaryType: FieldType;
  /** Number of sampled documents that contain this path. */
  count: number;
  /** Fraction of sampled documents containing this path (0-1). */
  presence: number;
  /** Up to `MAX_SAMPLES` distinct example values, in first-seen order. */
  examples: unknown[];
  /** For arrays: the types seen inside the array. */
  elementTypes?: FieldType[];
  /** For arrays of objects: the field paths found on the elements. */
  elementFields?: string[];
  /** True when every observed value at this path was one of a small set. */
  lowCardinality: boolean;
  /** Distinct values seen, when there were few enough to be worth offering. */
  distinctValues?: unknown[];
}

export interface InferredSchema {
  /** Number of documents inspected. */
  sampled: number;
  fields: InferredField[];
}

const MAX_SAMPLES = 5;
const MAX_DISTINCT = 25;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Classify a single JSON value into one of our display types. */
export function valueType(value: unknown): FieldType {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return ISO_DATE.test(value) ? 'date' : 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'string';
}

interface Accumulator {
  path: string;
  typeCounts: Map<FieldType, number>;
  count: number;
  examples: unknown[];
  distinct: Map<string, unknown>;
  distinctOverflow: boolean;
  elementTypes: Set<FieldType>;
  elementFields: Set<string>;
}

function accumulator(path: string): Accumulator {
  return {
    path,
    typeCounts: new Map(),
    count: 0,
    examples: [],
    distinct: new Map(),
    distinctOverflow: false,
    elementTypes: new Set(),
    elementFields: new Set(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function recordValue(acc: Accumulator, value: unknown): void {
  const type = valueType(value);
  acc.count += 1;
  acc.typeCounts.set(type, (acc.typeCounts.get(type) ?? 0) + 1);

  if (acc.examples.length < MAX_SAMPLES && value !== null && value !== undefined) {
    const alreadySeen = acc.examples.some((existing) => stableKey(existing) === stableKey(value));
    if (!alreadySeen) acc.examples.push(value);
  }

  // Track distinct values for scalars only - object/array equality is not worth
  // the noise, and a "pick a value" prompt only makes sense for scalars.
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'date') {
    if (!acc.distinctOverflow) {
      const key = stableKey(value);
      if (!acc.distinct.has(key)) {
        if (acc.distinct.size >= MAX_DISTINCT) {
          acc.distinctOverflow = true;
          acc.distinct.clear();
        } else {
          acc.distinct.set(key, value);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      acc.elementTypes.add(valueType(element));
      if (isPlainObject(element)) {
        for (const key of Object.keys(element)) acc.elementFields.add(key);
      }
    }
  }
}

function stableKey(value: unknown): string {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === 'object' && value !== null) return `json:${JSON.stringify(value)}`;
  return `${typeof value}:${String(value)}`;
}

function walk(
  doc: Record<string, unknown>,
  prefix: string,
  depth: number,
  maxDepth: number,
  fields: Map<string, Accumulator>
): void {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    let acc = fields.get(path);
    if (!acc) {
      acc = accumulator(path);
      fields.set(path, acc);
    }
    recordValue(acc, value);

    if (isPlainObject(value) && depth < maxDepth) {
      walk(value, path, depth + 1, maxDepth, fields);
    }
  }
}

export interface InferOptions {
  /** How deep to descend into nested objects. Default 3. */
  maxDepth?: number;
}

/**
 * Infer a schema from a sample of documents.
 * Fields are ordered by how commonly they appear, then alphabetically, with
 * `_id` pinned first so result tables always lead with the identifier.
 */
export function inferSchema(
  docs: Record<string, unknown>[],
  options: InferOptions = {}
): InferredSchema {
  const maxDepth = options.maxDepth ?? 3;
  const fields = new Map<string, Accumulator>();

  for (const doc of docs) {
    if (!isPlainObject(doc)) continue;
    walk(doc, '', 1, maxDepth, fields);
  }

  const total = docs.length || 1;
  const inferred: InferredField[] = [...fields.values()].map((acc) => {
    const types = [...acc.typeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
    // Prefer a concrete type over `null` when a field is sometimes empty.
    const primaryType = types.find((t) => t !== 'null') ?? types[0] ?? 'null';
    const distinctValues = acc.distinctOverflow ? undefined : [...acc.distinct.values()];

    return {
      path: acc.path,
      types,
      primaryType,
      count: acc.count,
      presence: acc.count / total,
      examples: acc.examples,
      elementTypes: acc.elementTypes.size ? [...acc.elementTypes] : undefined,
      elementFields: acc.elementFields.size ? [...acc.elementFields].sort() : undefined,
      lowCardinality: Boolean(
        distinctValues && distinctValues.length > 0 && distinctValues.length <= 12
      ),
      distinctValues,
    };
  });

  inferred.sort((a, b) => {
    if (a.path === '_id') return -1;
    if (b.path === '_id') return 1;
    const depthDiff = a.path.split('.').length - b.path.split('.').length;
    if (depthDiff !== 0) return depthDiff;
    if (b.count !== a.count) return b.count - a.count;
    return a.path.localeCompare(b.path);
  });

  return { sampled: docs.length, fields: inferred };
}

/**
 * Pick a sensible default set of columns for a results table: shallow, common,
 * scalar-ish fields, leading with `_id`.
 */
export function defaultColumns(schema: InferredSchema, max = 6): string[] {
  const scalarish: FieldType[] = ['string', 'number', 'boolean', 'date'];
  const candidates = schema.fields.filter(
    (field) =>
      field.path !== '_id' &&
      !field.path.includes('.') &&
      field.presence >= 0.5 &&
      scalarish.includes(field.primaryType)
  );

  const columns = candidates.slice(0, max - 1).map((field) => field.path);
  const hasId = schema.fields.some((field) => field.path === '_id');

  if (columns.length === 0) {
    // Nothing scalar and shallow - fall back to whatever we do have.
    const fallback = schema.fields
      .filter((field) => field.path !== '_id' && !field.path.includes('.'))
      .slice(0, max - 1)
      .map((field) => field.path);
    return hasId ? ['_id', ...fallback] : fallback;
  }

  return hasId ? ['_id', ...columns] : columns;
}

/** Read a dotted path out of a document, descending through objects. */
export function getPath(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === 'object') return (current as Record<string, unknown>)[segment];
    return undefined;
  }, doc);
}

/** Human-readable one-line summary of a field, used as a menu hint. */
export function describeField(field: InferredField): string {
  const parts: string[] = [];
  const type =
    field.primaryType === 'array' && field.elementTypes?.length
      ? `array of ${field.elementTypes.filter((t) => t !== 'null').join('/') || 'values'}`
      : field.primaryType;
  parts.push(type);

  if (field.presence < 0.999) {
    parts.push(`in ${Math.round(field.presence * 100)}% of docs`);
  }
  if (field.examples.length > 0) {
    const example = field.examples[0];
    const rendered =
      example instanceof Date
        ? example.toISOString()
        : typeof example === 'object'
          ? JSON.stringify(example)
          : String(example);
    parts.push(`e.g. ${rendered.length > 30 ? `${rendered.slice(0, 29)}…` : rendered}`);
  }
  return `— ${parts.join(', ')}`;
}
