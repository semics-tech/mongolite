import test from 'node:test';
import { expect } from 'expect';
import { Binary, Decimal128, ObjectId } from 'bson';
import { applyDiff, computeDiff, isEmptyDiff } from '../src/index.js';
import { projectToLocalShape } from '../src/sync/shadow.js';

test('Diff - only changed fields appear', () => {
  const diff = computeDiff(
    { _id: 'u1', name: 'Alice', age: 30, city: 'London' },
    { _id: 'u1', name: 'Alice', age: 31, city: 'London' }
  );

  expect(diff.set).toEqual({ age: 31 });
  expect(diff.unset).toEqual([]);
});

test('Diff - an unchanged document produces nothing to write', () => {
  const document = { _id: 'u1', name: 'Alice', tags: ['a', 'b'], nested: { x: 1 } };
  const diff = computeDiff({ ...document }, { ...document });

  expect(isEmptyDiff(diff)).toBe(true);
});

test('Diff - key order is not a change', () => {
  const diff = computeDiff(
    { a: 1, b: 2, nested: { x: 1, y: 2 } },
    { nested: { y: 2, x: 1 }, b: 2, a: 1 }
  );

  // Comparing serialised forms would report a spurious update on every single sync.
  expect(isEmptyDiff(diff)).toBe(true);
});

test('Diff - nested edits become dotted paths, not whole-object replacements', () => {
  const diff = computeDiff(
    { profile: { city: 'London', country: 'UK', postcode: 'E1' } },
    { profile: { city: 'Bristol', country: 'UK', postcode: 'E1' } }
  );

  // Dotted paths are what let two writers edit different sub-fields without collision.
  expect(diff.set).toEqual({ 'profile.city': 'Bristol' });
  expect(diff.unset).toEqual([]);
});

test('Diff - removed fields become unset, including nested ones', () => {
  const diff = computeDiff(
    { name: 'Alice', nickname: 'Al', profile: { city: 'London', phone: '123' } },
    { name: 'Alice', profile: { city: 'London' } }
  );

  expect(diff.set).toEqual({});
  expect(diff.unset.sort()).toEqual(['nickname', 'profile.phone']);
});

test('Diff - a new field is set, at any depth', () => {
  const diff = computeDiff(
    { profile: { city: 'London' } },
    { profile: { city: 'London', postcode: 'E1' }, active: true }
  );

  expect(diff.set).toEqual({ 'profile.postcode': 'E1', active: true });
});

test('Diff - arrays are replaced wholesale', () => {
  const diff = computeDiff({ tags: ['a', 'b', 'c'] }, { tags: ['a', 'x', 'c'] });

  // Positional array diffing is a bug farm once elements move; replacing is the
  // honest, predictable choice.
  expect(diff.set).toEqual({ tags: ['a', 'x', 'c'] });
});

test('Diff - an unchanged array is not rewritten', () => {
  const diff = computeDiff({ tags: [{ id: 1 }, { id: 2 }] }, { tags: [{ id: 1 }, { id: 2 }] });
  expect(isEmptyDiff(diff)).toBe(true);
});

test('Diff - a type change replaces the whole subtree', () => {
  const diff = computeDiff({ value: { nested: true } }, { value: 'now a string' });
  expect(diff.set).toEqual({ value: 'now a string' });
});

test('Diff - _id is never part of the update', () => {
  const diff = computeDiff({ _id: 'old', name: 'Alice' }, { _id: 'new', name: 'Alice' });
  expect(isEmptyDiff(diff)).toBe(true);
});

test('Diff - a document with no base has every field set', () => {
  const diff = computeDiff(null, { _id: 'u1', name: 'Alice', profile: { city: 'London' } });

  // A field the base does not have at all is set whole; dotted paths only earn their
  // keep when there is an existing subtree to edit around.
  expect(diff.set).toEqual({ name: 'Alice', profile: { city: 'London' } });
  expect(diff.unset).toEqual([]);
});

test('Diff - a server Date untouched locally never enters the diff', () => {
  // The upstream document as MongoDB holds it, with real BSON types.
  const serverDocument = {
    _id: 'u1',
    name: 'Alice',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ref: new ObjectId('507f1f77bcf86cd799439011'),
  };

  // What the local store holds — JSON only, so the Date is an ISO string.
  const local = {
    _id: 'u1',
    name: 'Alice Smith',
    createdAt: '2024-01-01T00:00:00.000Z',
    ref: '507f1f77bcf86cd799439011',
  };

  const diff = computeDiff(projectToLocalShape(serverDocument), local);

  // This is the type-preservation guarantee: only `name` is pushed, so the upstream
  // `Date` and `ObjectId` are never rewritten as strings.
  expect(diff.set).toEqual({ name: 'Alice Smith' });
  expect(diff.unset).toEqual([]);
});

test('Diff - values the local store mangles are still protected when untouched', () => {
  const serverDocument = {
    _id: 'u1',
    label: 'report',
    blob: new Binary(Buffer.from([1, 2, 3])),
    amount: Decimal128.fromString('12.50'),
  };

  const projection = projectToLocalShape(serverDocument);
  // Round-tripping these through JSON destroys them, which is exactly why they must
  // never be included in a push.
  const local = { ...projection, label: 'renamed' };

  const diff = computeDiff(projection, local);
  expect(diff.set).toEqual({ label: 'renamed' });
  expect(diff.unset).toEqual([]);
});

test('Diff - applying a diff rolls the server document forward, preserving BSON types', () => {
  const serverDocument = {
    _id: 'u1',
    name: 'Alice',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    profile: { city: 'London', phone: '123' },
  };

  const next = applyDiff(serverDocument, {
    set: { name: 'Alice Smith', 'profile.city': 'Bristol' },
    unset: ['profile.phone'],
  });

  expect(next.name).toBe('Alice Smith');
  expect((next.profile as Record<string, unknown>).city).toBe('Bristol');
  expect(next.profile).not.toHaveProperty('phone');

  // The untouched Date survives as a Date, not as a string.
  expect(next.createdAt).toBeInstanceOf(Date);
  expect((next.createdAt as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');

  // The original is not mutated.
  expect((serverDocument.profile as Record<string, unknown>).city).toBe('London');
});

test('Diff - applying a diff creates intermediate objects for new dotted paths', () => {
  const next = applyDiff({ _id: 'u1' }, { set: { 'a.b.c': 42 }, unset: [] });
  expect(next).toEqual({ _id: 'u1', a: { b: { c: 42 } } });
});

test('Diff - a diff round-trips: base + diff equals the local document', () => {
  const base = { _id: 'u1', name: 'Alice', age: 30, profile: { city: 'London', phone: '123' } };
  const local = { _id: 'u1', name: 'Alice', age: 31, profile: { city: 'Bristol' }, active: true };

  const result = applyDiff(base, computeDiff(base, local));
  expect(result).toEqual(local);
});
