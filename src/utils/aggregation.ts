/**
 * In-memory aggregation expression evaluation, shared by $addFields, $project, $group,
 * $replaceRoot and $match/$expr.
 */

type Doc = Record<string, unknown>;

/** Safely reads a dotted path from a value. Returns undefined when any segment is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (/^\d+$/.test(key)) {
        current = current[Number(key)];
        continue;
      }
      // Mongo maps the remaining path over array elements
      return current.map((el) => getPath(el, key)).filter((v) => v !== undefined);
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Doc)[key];
  }
  return current;
}

function isPlainObject(v: unknown): v is Doc {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** True if `v` is an expression operator object such as `{ $add: [...] }`. */
export function isOperatorExpression(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0].startsWith('$');
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return JSON.stringify(a) === JSON.stringify(b);
}

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const x = a as number;
  const y = b as number;
  return x < y ? -1 : x > y ? 1 : 0;
}

function truthy(v: unknown): boolean {
  return !(v === false || v === null || v === undefined || v === 0);
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

/**
 * Evaluates an aggregation expression against a document.
 * Supports field paths ("$a.b"), $$ROOT/$$CURRENT, literals, arrays, nested objects and a
 * common subset of operators. Unsupported operators throw.
 */
export function evaluateExpression(doc: Doc, expr: unknown): unknown {
  if (typeof expr === 'string') {
    if (expr === '$$ROOT' || expr === '$$CURRENT') return doc;
    if (expr.startsWith('$$')) throw new Error(`Unsupported aggregation variable: ${expr}`);
    if (expr.startsWith('$')) return getPath(doc, expr.slice(1));
    return expr;
  }
  if (Array.isArray(expr)) return expr.map((e) => evaluateExpression(doc, e));
  if (expr instanceof Date || !isPlainObject(expr)) return expr;

  const keys = Object.keys(expr);
  if (keys.length === 1 && keys[0].startsWith('$')) {
    return evaluateOperator(doc, keys[0], expr[keys[0]]);
  }
  const out: Doc = {};
  for (const [k, v] of Object.entries(expr)) {
    if (k.startsWith('$')) {
      throw new Error(`An object representing an expression must have exactly one field: ${k}`);
    }
    const val = evaluateExpression(doc, v);
    if (val !== undefined) out[k] = val;
  }
  return out;
}

function args(doc: Doc, raw: unknown): unknown[] {
  return (Array.isArray(raw) ? raw : [raw]).map((a) => evaluateExpression(doc, a));
}

function evaluateOperator(doc: Doc, op: string, raw: unknown): unknown {
  switch (op) {
    case '$literal':
      return raw;
    case '$add': {
      const vals = args(doc, raw);
      if (vals.some((v) => v === null || v === undefined)) return null;
      if (vals.some((v) => v instanceof Date)) {
        return new Date(
          vals.reduce<number>((s, v) => s + (v instanceof Date ? v.getTime() : (v as number)), 0)
        );
      }
      return vals.reduce<number>((s, v) => s + (v as number), 0);
    }
    case '$subtract': {
      const [a, b] = args(doc, raw);
      if (a === null || a === undefined || b === null || b === undefined) return null;
      if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
      if (a instanceof Date) return new Date(a.getTime() - (b as number));
      return (a as number) - (b as number);
    }
    case '$multiply': {
      const vals = args(doc, raw);
      if (vals.some((v) => num(v) === null)) return null;
      return vals.reduce<number>((s, v) => s * (v as number), 1);
    }
    case '$divide': {
      const [a, b] = args(doc, raw);
      if (num(a) === null || num(b) === null) return null;
      return (a as number) / (b as number);
    }
    case '$mod': {
      const [a, b] = args(doc, raw);
      if (num(a) === null || num(b) === null) return null;
      return (a as number) % (b as number);
    }
    case '$concat': {
      const vals = args(doc, raw);
      if (vals.some((v) => v === null || v === undefined)) return null;
      return vals.join('');
    }
    case '$toUpper': {
      const [v] = args(doc, raw);
      return v === null || v === undefined ? '' : String(v).toUpperCase();
    }
    case '$toLower': {
      const [v] = args(doc, raw);
      return v === null || v === undefined ? '' : String(v).toLowerCase();
    }
    case '$eq': {
      const [a, b] = args(doc, raw);
      return eq(a, b);
    }
    case '$ne': {
      const [a, b] = args(doc, raw);
      return !eq(a, b);
    }
    case '$gt': {
      const [a, b] = args(doc, raw);
      return cmp(a, b) > 0;
    }
    case '$gte': {
      const [a, b] = args(doc, raw);
      return cmp(a, b) >= 0;
    }
    case '$lt': {
      const [a, b] = args(doc, raw);
      return cmp(a, b) < 0;
    }
    case '$lte': {
      const [a, b] = args(doc, raw);
      return cmp(a, b) <= 0;
    }
    case '$and':
      return (Array.isArray(raw) ? raw : [raw]).every((e) => truthy(evaluateExpression(doc, e)));
    case '$or':
      return (Array.isArray(raw) ? raw : [raw]).some((e) => truthy(evaluateExpression(doc, e)));
    case '$not': {
      const [v] = args(doc, raw);
      return !truthy(v);
    }
    case '$cond': {
      let cond: unknown, thenE: unknown, elseE: unknown;
      if (Array.isArray(raw)) [cond, thenE, elseE] = raw;
      else {
        const o = raw as Doc;
        cond = o['if'];
        thenE = o['then'];
        elseE = o['else'];
      }
      return evaluateExpression(doc, truthy(evaluateExpression(doc, cond)) ? thenE : elseE);
    }
    case '$ifNull': {
      const vals = Array.isArray(raw) ? raw : [raw];
      for (let i = 0; i < vals.length - 1; i++) {
        const v = evaluateExpression(doc, vals[i]);
        if (v !== null && v !== undefined) return v;
      }
      return evaluateExpression(doc, vals[vals.length - 1]);
    }
    case '$size': {
      const [v] = args(doc, raw);
      if (!Array.isArray(v)) throw new Error('The argument to $size must be an array');
      return v.length;
    }
    case '$arrayElemAt': {
      const [arr, idx] = args(doc, raw);
      if (!Array.isArray(arr) || typeof idx !== 'number') return null;
      const i = idx < 0 ? arr.length + idx : idx;
      return arr[i];
    }
    case '$first': {
      const [arr] = args(doc, raw);
      return Array.isArray(arr) ? arr[0] : null;
    }
    case '$last': {
      const [arr] = args(doc, raw);
      return Array.isArray(arr) ? arr[arr.length - 1] : null;
    }
    default:
      throw new Error(`Unsupported aggregation expression operator: ${op}`);
  }
}

/** Evaluates a $match `$expr` value to a boolean. */
export function evaluateExprFilter(doc: Doc, expr: unknown): boolean {
  return truthy(evaluateExpression(doc, expr));
}

/** True if a $match filter uses $expr anywhere in its logical tree. */
export function filterUsesExpr(filter: unknown): boolean {
  if (!isPlainObject(filter)) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$expr') return true;
    if ((k === '$and' || k === '$or' || k === '$nor') && Array.isArray(v) && v.some(filterUsesExpr))
      return true;
  }
  return false;
}

export const SUPPORTED_STAGES = [
  '$match',
  '$project',
  '$addFields',
  '$set',
  '$sort',
  '$limit',
  '$skip',
  '$count',
  '$group',
  '$unwind',
  '$lookup',
  '$replaceRoot',
  '$replaceWith',
] as const;

export const SUPPORTED_ACCUMULATORS = [
  '$sum',
  '$avg',
  '$min',
  '$max',
  '$push',
  '$addToSet',
  '$first',
  '$last',
  '$count',
] as const;
