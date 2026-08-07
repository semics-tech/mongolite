/**
 * Rendering helpers: turning documents into something readable in a terminal.
 */
import { getPath, type InferredSchema } from './schema.js';
import { style, terminalWidth, truncate, displayWidth } from './ui.js';

/** Render a value as a single-line cell. */
export function formatCell(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value
      .map((item) => (typeof item === 'object' && item !== null ? '{…}' : String(item)))
      .join(', ');
    return `[${inner}]`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface TableOptions {
  columns: string[];
  maxColumnWidth?: number;
  /** Prefix each row with its index in the result set. */
  showRowNumbers?: boolean;
  /** Index of the first row, used when paging. */
  startIndex?: number;
}

/**
 * Render documents as an aligned table. Columns are sized to their content and
 * then shrunk proportionally if the table would overflow the terminal.
 */
export function renderTable(docs: Record<string, unknown>[], options: TableOptions): string {
  const { columns } = options;
  if (columns.length === 0) return style.grey('No columns to show.');

  const maxColumnWidth = options.maxColumnWidth ?? 40;
  const startIndex = options.startIndex ?? 0;
  const showRowNumbers = options.showRowNumbers ?? true;

  const headers = showRowNumbers ? ['#', ...columns] : [...columns];
  const rows = docs.map((doc, index) => {
    const cells = columns.map((column) => formatCell(getPath(doc, column)));
    return showRowNumbers ? [String(startIndex + index + 1), ...cells] : cells;
  });

  // Natural width per column, capped.
  const widths = headers.map((header, columnIndex) => {
    const longestCell = rows.reduce(
      (max, row) => Math.max(max, (row[columnIndex] ?? '').length),
      0
    );
    return Math.min(Math.max(header.length, longestCell), maxColumnWidth);
  });

  // Shrink the widest columns until the whole table fits the terminal.
  const separatorWidth = 3;
  const available = terminalWidth() - 1;
  let total = widths.reduce((sum, width) => sum + width, 0) + separatorWidth * (widths.length - 1);
  while (total > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 6) break;
    widths[widest] -= 1;
    total -= 1;
  }

  const line = (cells: string[], colourise?: (text: string) => string): string =>
    cells
      .map((cell, index) => {
        const clipped = truncate(cell, widths[index]);
        const padded = clipped.padEnd(widths[index]);
        return colourise ? colourise(padded) : padded;
      })
      .join(style.grey(' │ '))
      .trimEnd();

  const output: string[] = [];
  output.push(line(headers, style.bold));
  output.push(style.grey(widths.map((width) => '─'.repeat(width)).join('─┼─')));
  for (const row of rows) output.push(line(row));
  return output.join('\n');
}

/** Pretty-print one document, with the `_id` called out first. */
export function renderDocument(doc: Record<string, unknown>): string {
  return JSON.stringify(doc, null, 2);
}

/** Render an inferred schema as a table of fields. */
export function renderSchema(schema: InferredSchema): string {
  if (schema.fields.length === 0) {
    return style.grey('No fields found - the collection looks empty.');
  }

  const rows = schema.fields.map((field) => {
    const type =
      field.primaryType === 'array' && field.elementTypes?.length
        ? `array<${field.elementTypes.filter((t) => t !== 'null').join('|') || 'any'}>`
        : field.types.join('|');
    const example = field.examples.length
      ? formatCell(field.examples[0])
      : field.types.includes('null')
        ? 'null'
        : '';
    return {
      field: field.path,
      type,
      present: `${Math.round(field.presence * 100)}%`,
      example,
    };
  });

  const widths = {
    field: Math.min(Math.max(5, ...rows.map((r) => r.field.length)), 40),
    type: Math.min(Math.max(4, ...rows.map((r) => r.type.length)), 24),
    present: 7,
  };
  const exampleWidth = Math.max(
    10,
    terminalWidth() - widths.field - widths.type - widths.present - 10
  );

  const output: string[] = [];
  output.push(
    style.bold(
      `${'field'.padEnd(widths.field)}  ${'type'.padEnd(widths.type)}  ${'present'.padEnd(widths.present)}  example`
    )
  );
  for (const row of rows) {
    output.push(
      `${truncate(row.field, widths.field).padEnd(widths.field)}  ${style.cyan(
        truncate(row.type, widths.type).padEnd(widths.type)
      )}  ${style.grey(row.present.padEnd(widths.present))}  ${style.grey(
        truncate(row.example, exampleWidth)
      )}`
    );
  }
  return output.join('\n');
}

/** Show a generated SQL statement with its bound parameters. */
export function renderSql(sql: string, params: unknown[]): string {
  const lines = [style.bold('SQL'), sql];
  if (params.length > 0) {
    lines.push(style.bold('Parameters'), JSON.stringify(params));
  }
  return lines.join('\n');
}

/** Describe a filter in plain English, for confirming what is about to run. */
export function describeFilter(filter: Record<string, unknown>): string {
  if (!filter || Object.keys(filter).length === 0) return 'all documents';
  return JSON.stringify(filter);
}

/** Wrap long text to the terminal width, preserving existing newlines. */
export function wrapText(text: string, width = terminalWidth() - 2): string {
  return text
    .split('\n')
    .map((paragraph) => {
      if (displayWidth(paragraph) <= width) return paragraph;
      const words = paragraph.split(' ');
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        if (current === '') {
          current = word;
        } else if (displayWidth(`${current} ${word}`) <= width) {
          current = `${current} ${word}`;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines.join('\n');
    })
    .join('\n');
}
