/**
 * Tests for the CLI rendering helpers in src/cli/format.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  formatCell,
  renderDocument,
  renderSchema,
  renderSql,
  describeFilter,
  wrapText,
} from '../src/cli/format.js';
import { inferSchema } from '../src/cli/schema.js';

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('cli format helpers', () => {
  it('formatCell renders each value kind on one line', () => {
    assert.strictEqual(formatCell(undefined), '');
    assert.strictEqual(formatCell(null), 'null');
    assert.strictEqual(
      formatCell(new Date('2024-01-02T03:04:05.000Z')),
      '2024-01-02T03:04:05.000Z'
    );
    assert.strictEqual(formatCell([]), '[]');
    assert.strictEqual(formatCell([1, 'a', { x: 1 }]), '[1, a, {…}]');
    assert.strictEqual(formatCell({ a: 1 }), '{"a":1}');
    assert.strictEqual(formatCell(42), '42');
  });

  it('renderDocument pretty-prints with two-space indent', () => {
    assert.strictEqual(renderDocument({ a: 1 }), '{\n  "a": 1\n}');
  });

  it('renderSql lists parameters only when there are some', () => {
    assert.strictEqual(stripAnsi(renderSql('SELECT 1', [])), 'SQL\nSELECT 1');
    assert.strictEqual(
      stripAnsi(renderSql('SELECT ?', ['x', 2])),
      'SQL\nSELECT ?\nParameters\n["x",2]'
    );
  });

  it('describeFilter says "all documents" for an empty filter', () => {
    assert.strictEqual(describeFilter({}), 'all documents');
    assert.strictEqual(
      describeFilter(undefined as unknown as Record<string, unknown>),
      'all documents'
    );
    assert.strictEqual(describeFilter({ a: 1 }), '{"a":1}');
  });

  it('wrapText keeps short lines and newlines, wraps long ones at word boundaries', () => {
    assert.strictEqual(wrapText('short\nlines', 20), 'short\nlines');
    assert.strictEqual(wrapText('aaa bbb ccc ddd', 7), 'aaa bbb\nccc ddd');
    assert.strictEqual(wrapText('averyveryverylongword x', 5), 'averyveryverylongword\nx');
  });

  it('renderSchema reports an empty collection', () => {
    assert.match(stripAnsi(renderSchema({ sampled: 0, fields: [] })), /No fields found/);
  });

  it('renderSchema shows field, type, presence and example', () => {
    const schema = inferSchema([
      { _id: '1', name: 'Ann', tags: ['a', 'b'], note: null },
      { _id: '2', name: 'Bob', tags: ['c'] },
    ]);
    const out = stripAnsi(renderSchema(schema)).split('\n');
    assert.match(out[0], /^field\s+type\s+present\s+example/);
    const name = out.find((l) => l.startsWith('name'));
    assert.ok(name && /string/.test(name) && /100%/.test(name) && /Ann/.test(name));
    const tags = out.find((l) => l.startsWith('tags'));
    assert.ok(tags && /array<string>/.test(tags) && /100%/.test(tags));
    const note = out.find((l) => l.startsWith('note'));
    assert.ok(note && /50%/.test(note) && /null/.test(note));
  });
});
