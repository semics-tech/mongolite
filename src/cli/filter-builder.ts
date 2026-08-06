/**
 * Turns plain-English choices into MongoLite filters.
 *
 * The point of this module is that a user should never have to know that
 * `{ age: { $gte: 30 } }` is the way to ask for "age is at least 30". Each
 * inferred field type offers a menu of conditions phrased as English, and the
 * chosen condition compiles down to a normal MongoLite filter — which the CLI
 * can also show them, so the syntax is learnable rather than hidden.
 */
import type { FieldType, InferredField } from './schema.js';

/** How many values a condition needs from the user. */
export type Arity = 'none' | 'one' | 'two' | 'many';

export interface ConditionOperator {
  id: string;
  /** Plain-English phrasing shown in the menu. */
  label: string;
  arity: Arity;
  /** Prompt shown when asking for the value(s). */
  valuePrompt?: string;
  secondValuePrompt?: string;
  /** Set when the operator only makes sense for particular field types. */
  hint?: string;
}

const EXISTENCE: ConditionOperator[] = [
  { id: 'exists', label: 'has a value', arity: 'none' },
  { id: 'notExists', label: 'is missing or empty', arity: 'none' },
];

const STRING_OPERATORS: ConditionOperator[] = [
  { id: 'eq', label: 'is', arity: 'one', valuePrompt: 'Value' },
  { id: 'ne', label: 'is not', arity: 'one', valuePrompt: 'Value' },
  { id: 'contains', label: 'contains the text', arity: 'one', valuePrompt: 'Text' },
  { id: 'startsWith', label: 'starts with', arity: 'one', valuePrompt: 'Prefix' },
  { id: 'endsWith', label: 'ends with', arity: 'one', valuePrompt: 'Suffix' },
  { id: 'in', label: 'is one of', arity: 'many', valuePrompt: 'Values (comma separated)' },
  { id: 'nin', label: 'is none of', arity: 'many', valuePrompt: 'Values (comma separated)' },
  {
    id: 'regex',
    label: 'matches a regular expression',
    arity: 'one',
    valuePrompt: 'Pattern',
    hint: 'advanced',
  },
];

const NUMBER_OPERATORS: ConditionOperator[] = [
  { id: 'eq', label: 'equals', arity: 'one', valuePrompt: 'Number' },
  { id: 'ne', label: 'does not equal', arity: 'one', valuePrompt: 'Number' },
  { id: 'gt', label: 'is greater than', arity: 'one', valuePrompt: 'Number' },
  { id: 'gte', label: 'is at least', arity: 'one', valuePrompt: 'Number' },
  { id: 'lt', label: 'is less than', arity: 'one', valuePrompt: 'Number' },
  { id: 'lte', label: 'is at most', arity: 'one', valuePrompt: 'Number' },
  {
    id: 'between',
    label: 'is between',
    arity: 'two',
    valuePrompt: 'From (inclusive)',
    secondValuePrompt: 'To (inclusive)',
  },
  { id: 'in', label: 'is one of', arity: 'many', valuePrompt: 'Numbers (comma separated)' },
];

const DATE_OPERATORS: ConditionOperator[] = [
  { id: 'eq', label: 'is exactly', arity: 'one', valuePrompt: 'Date (e.g. 2024-01-31)' },
  { id: 'gt', label: 'is after', arity: 'one', valuePrompt: 'Date (e.g. 2024-01-31)' },
  { id: 'gte', label: 'is on or after', arity: 'one', valuePrompt: 'Date' },
  { id: 'lt', label: 'is before', arity: 'one', valuePrompt: 'Date' },
  { id: 'lte', label: 'is on or before', arity: 'one', valuePrompt: 'Date' },
  {
    id: 'between',
    label: 'is between',
    arity: 'two',
    valuePrompt: 'From date',
    secondValuePrompt: 'To date',
  },
];

const BOOLEAN_OPERATORS: ConditionOperator[] = [
  { id: 'isTrue', label: 'is true', arity: 'none' },
  { id: 'isFalse', label: 'is false', arity: 'none' },
];

const ARRAY_OPERATORS: ConditionOperator[] = [
  { id: 'arrayContains', label: 'contains', arity: 'one', valuePrompt: 'Value' },
  {
    id: 'arrayContainsAny',
    label: 'contains any of',
    arity: 'many',
    valuePrompt: 'Values (comma separated)',
  },
  {
    id: 'arrayContainsAll',
    label: 'contains all of',
    arity: 'many',
    valuePrompt: 'Values (comma separated)',
  },
  { id: 'size', label: 'has exactly N items', arity: 'one', valuePrompt: 'Number of items' },
];

const OBJECT_OPERATORS: ConditionOperator[] = [
  { id: 'jsonEquals', label: 'equals this JSON', arity: 'one', valuePrompt: 'JSON value' },
];

/** The conditions worth offering for a given field. */
export function operatorsFor(
  field: Pick<InferredField, 'primaryType' | 'types'>
): ConditionOperator[] {
  const byType: Record<FieldType, ConditionOperator[]> = {
    string: STRING_OPERATORS,
    number: NUMBER_OPERATORS,
    date: DATE_OPERATORS,
    boolean: BOOLEAN_OPERATORS,
    array: ARRAY_OPERATORS,
    object: OBJECT_OPERATORS,
    null: STRING_OPERATORS,
  };

  const primary = byType[field.primaryType] ?? STRING_OPERATORS;
  // Mixed-type fields also get the string operators, which are the most forgiving.
  const mixed =
    field.types.length > 1 && field.primaryType !== 'string'
      ? STRING_OPERATORS.filter((op) => !primary.some((existing) => existing.id === op.id))
      : [];

  return [...primary, ...mixed, ...EXISTENCE];
}

/** Escape a literal string so it can be embedded in a regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Coerce user-typed text into the type the field appears to hold.
 * Throws a message suitable for showing straight back to the user.
 */
export function parseValue(input: string, type: FieldType): unknown {
  const trimmed = input.trim();

  switch (type) {
    case 'number': {
      const parsed = Number(trimmed);
      if (trimmed === '' || Number.isNaN(parsed)) {
        throw new Error(`"${input}" is not a number.`);
      }
      return parsed;
    }
    case 'boolean': {
      const lowered = trimmed.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(lowered)) return true;
      if (['false', 'no', 'n', '0'].includes(lowered)) return false;
      throw new Error(`"${input}" is not true or false.`);
    }
    case 'date': {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`"${input}" is not a date I can read. Try 2024-01-31.`);
      }
      // Documents store dates as ISO strings, so compare as ISO strings.
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? `${trimmed}T00:00:00.000Z`
        : parsed.toISOString();
    }
    case 'object':
    case 'array': {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed; // Fall back to a plain scalar - useful for "array contains".
      }
    }
    default: {
      // Strings stay strings, but "true"/"42" typed against a mixed field are
      // usually meant literally, so no coercion here.
      return trimmed;
    }
  }
}

/** Split a comma-separated list, parsing each entry as `type`. */
export function parseValueList(input: string, type: FieldType): unknown[] {
  const parts = input
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) throw new Error('Enter at least one value.');
  return parts.map((part) => parseValue(part, type));
}

export interface Condition {
  field: string;
  operator: string;
  values: unknown[];
  /** The type the values were parsed as - kept for redisplay. */
  fieldType: FieldType;
}

/** Compile one condition into the equivalent MongoLite filter fragment. */
export function compileCondition(condition: Condition): Record<string, unknown> {
  const { field, operator, values } = condition;
  const [first, second] = values;

  switch (operator) {
    case 'eq':
      return { [field]: { $eq: first } };
    case 'ne':
      return { [field]: { $ne: first } };
    case 'gt':
      return { [field]: { $gt: first } };
    case 'gte':
      return { [field]: { $gte: first } };
    case 'lt':
      return { [field]: { $lt: first } };
    case 'lte':
      return { [field]: { $lte: first } };
    case 'between':
      return { [field]: { $gte: first, $lte: second } };
    case 'in':
      return { [field]: { $in: values } };
    case 'nin':
      return { [field]: { $nin: values } };
    case 'contains':
      return { [field]: { $regex: escapeRegex(String(first)), $options: 'i' } };
    case 'startsWith':
      return { [field]: { $regex: `^${escapeRegex(String(first))}`, $options: 'i' } };
    case 'endsWith':
      return { [field]: { $regex: `${escapeRegex(String(first))}$`, $options: 'i' } };
    case 'regex':
      return { [field]: { $regex: String(first) } };
    case 'isTrue':
      return { [field]: { $eq: true } };
    case 'isFalse':
      return { [field]: { $eq: false } };
    case 'exists':
      return { [field]: { $exists: true } };
    case 'notExists':
      return { [field]: { $exists: false } };
    // `$in` compiles to a json_each() containment check, which is what makes
    // these work element-wise on array fields.
    case 'arrayContains':
      return { [field]: { $in: [first] } };
    case 'arrayContainsAny':
      return { [field]: { $in: values } };
    case 'arrayContainsAll':
      return { [field]: { $all: values } };
    case 'size':
      return { [field]: { $size: Number(first) } };
    case 'jsonEquals':
      return { [field]: first };
    default:
      throw new Error(`Unknown condition: ${operator}`);
  }
}

/**
 * Combine conditions into one filter.
 * "All" merges into a flat object when the fields are distinct (the filter a
 * person would have written by hand) and falls back to `$and` when a field is
 * constrained more than once.
 */
export function combineConditions(
  conditions: Condition[],
  mode: 'all' | 'any' = 'all'
): Record<string, unknown> {
  if (conditions.length === 0) return {};
  const compiled = conditions.map(compileCondition);
  if (compiled.length === 1 && mode === 'all') return compiled[0];

  if (mode === 'any') return { $or: compiled };

  const fields = conditions.map((condition) => condition.field);
  const hasDuplicateField = new Set(fields).size !== fields.length;
  if (hasDuplicateField) return { $and: compiled };

  return Object.assign({}, ...compiled) as Record<string, unknown>;
}

/**
 * Every operator across every type, for label lookups.
 * A condition's `fieldType` is the type of its *values* — the element type for
 * array fields — so looking a label up by that type alone would miss the array
 * operators.
 */
const ALL_OPERATORS: ConditionOperator[] = [
  ...STRING_OPERATORS,
  ...NUMBER_OPERATORS,
  ...DATE_OPERATORS,
  ...BOOLEAN_OPERATORS,
  ...ARRAY_OPERATORS,
  ...OBJECT_OPERATORS,
  ...EXISTENCE,
];

/** Render a condition the way it was phrased in the menu, for review lists. */
export function describeCondition(
  condition: Condition,
  operators = operatorsFor({
    primaryType: condition.fieldType,
    types: [condition.fieldType],
  })
): string {
  const operator =
    operators.find((candidate) => candidate.id === condition.operator) ??
    ALL_OPERATORS.find((candidate) => candidate.id === condition.operator);
  const label = operator?.label ?? condition.operator;
  if (condition.values.length === 0) return `${condition.field} ${label}`;
  if (condition.values.length === 2 && condition.operator === 'between') {
    return `${condition.field} ${label} ${format(condition.values[0])} and ${format(condition.values[1])}`;
  }
  return `${condition.field} ${label} ${condition.values.map(format).join(', ')}`;
}

function format(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
