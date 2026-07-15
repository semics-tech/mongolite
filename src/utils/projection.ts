import { DocumentWithId, Projection } from '../types.js';

export type ProjectionMode = 'include' | 'exclude';

/**
 * Determines whether a projection is an inclusion or exclusion projection, matching MongoDB's
 * rule: any explicit non-`_id` inclusion (1/true) puts it in inclusion mode; otherwise any
 * explicit non-`_id` exclusion (0/false) puts it in exclusion mode; with only `_id` specified
 * (or nothing), `_id: 0`/`false` means exclusion, everything else defaults to inclusion.
 */
export function resolveProjectionMode<T>(projection: Projection<T>): ProjectionMode {
  let hasExplicitInclusion = false;
  let hasExplicitExclusion = false;

  for (const key of Object.keys(projection)) {
    if (key === '_id') continue;
    const value = projection[key as keyof T];
    if (value === 1 || value === true) {
      hasExplicitInclusion = true;
      break;
    }
    if (value === 0 || value === false) {
      hasExplicitExclusion = true;
    }
  }

  if (hasExplicitInclusion) return 'include';
  if (hasExplicitExclusion) return 'exclude';
  return projection._id === 0 || projection._id === false ? 'exclude' : 'include';
}

/**
 * Applies a MongoDB-style projection to a single document, matching real MongoDB find()
 * projection semantics: an empty/missing projection means no restriction, inclusion mode
 * copies only listed fields (plus `_id` unless explicitly excluded), and exclusion mode copies
 * everything except the listed fields. Supports dot-notation nested paths in both modes.
 */
export function applyProjectionToDocument<T extends DocumentWithId>(
  doc: T,
  projection: Projection<T> | null | undefined
): T {
  if (!projection || Object.keys(projection).length === 0) return doc;

  const mode = resolveProjectionMode(projection);
  const projectedDoc: Partial<T> = {};

  if (mode === 'include') {
    for (const key in projection) {
      const value = projection[key as keyof T];
      if (value !== 1 && value !== true) continue;

      if (key.includes('.')) {
        const path = key.split('.');
        let current = doc as Record<string, unknown>;
        let target = projectedDoc as Record<string, unknown>;

        for (let i = 0; i < path.length - 1; i++) {
          const segment = path[i];
          if (current[segment] === undefined || current[segment] === null) break;

          if (target[segment] === undefined) {
            target[segment] = {};
          }

          current = current[segment] as Record<string, unknown>;
          target = target[segment] as Record<string, unknown>;
        }

        const lastSegment = path[path.length - 1];
        if (current && current[lastSegment] !== undefined) {
          target[lastSegment] = current[lastSegment];
        }
      } else if (key in doc) {
        projectedDoc[key as keyof T] = doc[key as keyof T];
      }
    }
    if (projection._id !== 0 && projection._id !== false && '_id' in doc) {
      projectedDoc._id = doc._id;
    }
  } else {
    Object.assign(projectedDoc, doc);
    for (const key in projection) {
      const value = projection[key as keyof T];
      if (value !== 0 && value !== false) continue;

      if (key.includes('.')) {
        const path = key.split('.');
        let current = projectedDoc as Record<string, unknown>;

        for (let i = 0; i < path.length - 1; i++) {
          const segment = path[i];
          if (current[segment] === undefined) break;
          current = current[segment] as Record<string, unknown>;
        }

        const lastSegment = path[path.length - 1];
        if (current && current[lastSegment] !== undefined) {
          delete current[lastSegment];
        }
      } else {
        delete projectedDoc[key as keyof T];
      }
    }
  }

  return projectedDoc as T;
}
