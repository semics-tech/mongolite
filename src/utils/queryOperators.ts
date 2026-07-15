/**
 * Shared query-operator registry used by in-memory ($match) filtering. Kept in sync with the
 * operator set `buildComparisonCondition` (src/cursors/findCursor.ts) supports for SQL-generated
 * find() filtering, so the two engines can't silently drift apart on what an operator means —
 * see tests/operator-coverage.test.ts, which runs the same filter through both engines.
 */
export const SUPPORTED_QUERY_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$all',
  '$exists',
  '$not',
  '$regex',
  '$size',
  '$type',
  '$mod',
] as const;

function matchesBsonType(value: unknown, bsonType: string | number): boolean {
  switch (bsonType) {
    case 1:
    case 'double':
    case 'number':
      return typeof value === 'number';
    case 2:
    case 'string':
      return typeof value === 'string';
    case 3:
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
    case 4:
    case 'array':
      return Array.isArray(value);
    case 8:
    case 'bool':
    case 'boolean':
      return typeof value === 'boolean';
    case 9:
    case 'date':
      return value instanceof Date;
    case 10:
    case 'null':
      return value === null;
    case 16:
    case 'int':
    case 18:
    case 'long':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return false;
  }
}

/**
 * Evaluates a single query operator against a document's field value. Used for in-memory
 * filtering (e.g. aggregation `$match`) — the SQL-generating side (`buildComparisonCondition`)
 * emits SQL fragments instead of booleans and stays separate, but should support the same
 * operator set.
 */
export function evaluateOperator(
  op: string,
  docValue: unknown,
  opValue: unknown,
  regexOptions?: unknown
): boolean {
  switch (op) {
    case '$eq':
      return JSON.stringify(docValue) === JSON.stringify(opValue);
    case '$ne':
      return JSON.stringify(docValue) !== JSON.stringify(opValue);
    case '$gt':
      return (docValue as number) > (opValue as number);
    case '$gte':
      return (docValue as number) >= (opValue as number);
    case '$lt':
      return (docValue as number) < (opValue as number);
    case '$lte':
      return (docValue as number) <= (opValue as number);
    case '$in':
      if (!Array.isArray(opValue)) return false;
      if (Array.isArray(docValue)) {
        return docValue.some((el) => opValue.some((v) => JSON.stringify(el) === JSON.stringify(v)));
      }
      return opValue.some((v) => JSON.stringify(v) === JSON.stringify(docValue));
    case '$nin':
      if (!Array.isArray(opValue)) return false;
      if (Array.isArray(docValue)) {
        return !docValue.some((el) => opValue.some((v) => JSON.stringify(el) === JSON.stringify(v)));
      }
      return !opValue.some((v) => JSON.stringify(v) === JSON.stringify(docValue));
    case '$all':
      if (!Array.isArray(opValue) || !Array.isArray(docValue)) return false;
      return opValue.every((item) => docValue.some((el) => JSON.stringify(el) === JSON.stringify(item)));
    case '$exists':
      return opValue ? docValue !== undefined : docValue === undefined;
    case '$not':
      return !evaluateOperators(docValue, opValue as Record<string, unknown>);
    case '$regex': {
      const pattern =
        opValue instanceof RegExp
          ? opValue
          : new RegExp(opValue as string, typeof regexOptions === 'string' ? regexOptions : undefined);
      return pattern.test(String(docValue));
    }
    case '$size':
      return Array.isArray(docValue) && docValue.length === (opValue as number);
    case '$type': {
      const types = Array.isArray(opValue) ? opValue : [opValue];
      return types.some((t) => matchesBsonType(docValue, t as string | number));
    }
    case '$mod': {
      if (!Array.isArray(opValue) || opValue.length !== 2 || typeof docValue !== 'number') return false;
      const [divisor, remainder] = opValue as [number, number];
      return Math.trunc(docValue) % divisor === remainder;
    }
    case '$options':
      return true; // consumed alongside $regex, not an independent predicate
    default:
      return false; // unsupported operator — conservative: never matches, rather than silently no-op
  }
}

/** Evaluates every operator in `ops` against `docValue`, ANDing the results together. */
export function evaluateOperators(docValue: unknown, ops: Record<string, unknown>): boolean {
  const regexOptions = ops['$options'];
  for (const [op, opValue] of Object.entries(ops)) {
    if (op === '$options') continue;
    if (!evaluateOperator(op, docValue, opValue, regexOptions)) return false;
  }
  return true;
}
