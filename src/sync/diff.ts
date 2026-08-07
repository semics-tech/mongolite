/**
 * Field-level diffing between the last-known server state and the local document.
 *
 * Replication used to push whole documents, which meant a local edit to one field
 * rewrote every other field too — including fields another writer had just changed,
 * and including fields whose BSON type the local store cannot represent. Diffing
 * narrows each push to `$set`/`$unset` of what genuinely changed, so everything else
 * upstream is left exactly as it was.
 */

/** A minimal update expressed as dotted-path assignments and removals. */
export interface DocumentDiff {
  /** Dotted path → new value. */
  set: Record<string, unknown>;
  /** Dotted paths to remove. */
  unset: string[];
}

/**
 * True when `value` is a genuine plain object worth recursing into.
 *
 * Class instances are deliberately excluded. A `Date`, `ObjectId` or `Binary` is
 * `typeof 'object'`, and treating one as a bag of fields would copy it into a plain
 * object — destroying exactly the BSON types the shadow exists to preserve.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality, insensitive to key order.
 *
 * `JSON.stringify` comparison would report `{a:1,b:2}` and `{b:2,a:1}` as different and
 * push a spurious update on every sync.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // NaN is the one primitive that isn't equal to itself.
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);

  // Two equal instants are separate objects; without this every sync would rewrite
  // any date-valued field.
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key])
    );
  }

  return false;
}

/**
 * Computes the minimal update that turns `base` into `local`.
 *
 * `base` must be the **lossy JSON projection** of the server document — the same shape
 * the local store would have produced for it (see `projectToLocalShape` in `shadow.ts`).
 * That is what makes type preservation work: a server `Date` projects to the same ISO
 * string the local store holds, compares equal, and so never appears in the diff — the
 * upstream `Date` survives untouched.
 *
 * Nested objects recurse into dotted paths, so two writers editing different sub-fields
 * of the same document do not collide.
 *
 * **Arrays are atomic.** Any change to an array replaces the whole array. Positional
 * diffing of arrays is famously error-prone once elements are inserted or reordered, and
 * a wrong answer here silently corrupts data — so this deliberately does not attempt it.
 *
 * @param base The last-known server state, projected to local shape. `null` if the
 * document has never been upstream, in which case every field is new.
 * @param local The current local document.
 */
export function computeDiff(
  base: Record<string, unknown> | null,
  local: Record<string, unknown>
): DocumentDiff {
  const diff: DocumentDiff = { set: {}, unset: [] };
  collect(base ?? {}, local, '', diff);
  return diff;
}

function collect(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  prefix: string,
  diff: DocumentDiff
): void {
  const keys = new Set([...Object.keys(base), ...Object.keys(local)]);

  for (const key of keys) {
    // `_id` is the identity, never part of the update.
    if (prefix === '' && key === '_id') continue;

    const path = prefix === '' ? key : `${prefix}.${key}`;
    const inLocal = Object.prototype.hasOwnProperty.call(local, key);
    const inBase = Object.prototype.hasOwnProperty.call(base, key);

    if (!inLocal) {
      diff.unset.push(path);
      continue;
    }

    const localValue = local[key];
    const baseValue = base[key];

    if (!inBase) {
      diff.set[path] = localValue;
      continue;
    }

    // Recurse only when both sides are objects; otherwise the shapes differ and the
    // whole subtree is replaced.
    if (isPlainObject(baseValue) && isPlainObject(localValue)) {
      collect(baseValue, localValue, path, diff);
      continue;
    }

    if (!deepEqual(baseValue, localValue)) {
      diff.set[path] = localValue;
    }
  }
}

/** True when the diff would change nothing upstream. */
export function isEmptyDiff(diff: DocumentDiff): boolean {
  return Object.keys(diff.set).length === 0 && diff.unset.length === 0;
}

/**
 * Applies a diff to a copy of `document`, mirroring what the upstream `$set`/`$unset`
 * does.
 *
 * Used to roll the shadow forward after a successful push without a second round trip.
 * Because it edits the *server* document in place, fields the diff never mentions keep
 * their original BSON values — which is the whole point of diffing in the first place.
 */
export function applyDiff(
  document: Record<string, unknown>,
  diff: DocumentDiff
): Record<string, unknown> {
  const result = clone(document) as Record<string, unknown>;

  for (const [path, value] of Object.entries(diff.set)) {
    setPath(result, path.split('.'), value);
  }
  for (const path of diff.unset) {
    unsetPath(result, path.split('.'));
  }

  return result;
}

/**
 * Structured clone that leaves class instances (BSON `Date`, `ObjectId`, `Binary`, …)
 * by reference. Copying them field-by-field would destroy exactly the types the shadow
 * exists to preserve.
 */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
}

function setPath(target: Record<string, unknown>, segments: string[], value: unknown): void {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const next = target[head];
  // Mirror MongoDB: a dotted path creates intermediate objects as needed.
  const container = isPlainObject(next) ? next : {};
  target[head] = container;
  setPath(container, rest, value);
}

function unsetPath(target: Record<string, unknown>, segments: string[]): void {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    delete target[head];
    return;
  }
  const next = target[head];
  if (isPlainObject(next)) unsetPath(next, rest);
}
