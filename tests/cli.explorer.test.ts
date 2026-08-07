/**
 * End-to-end tests for the guided explorer.
 *
 * The explorer is driven the same way a piped script would drive it: with
 * MONGOLITE_NON_INTERACTIVE set every prompt falls back to reading a line, so
 * a scenario is just the list of answers a user would give. Answers are fed
 * reactively — one whenever a prompt appears — and every scenario asserts that
 * its whole script was consumed, so a script cannot silently drift out of step
 * with the flow it is meant to exercise.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { MongoLite } from '../src/index';
import { Explorer, type ExplorerOptions } from '../src/cli/explorer';
import type { DocumentWithId } from '../src/types';

interface Employee extends DocumentWithId {
  name: string;
  age: number;
  department: string;
  isActive: boolean;
  salary: number;
  skills: string[];
  address: { city: string; country: string };
  joinDate: string;
}

const employees: Omit<Employee, '_id'>[] = [
  {
    name: 'Alice',
    age: 30,
    department: 'Engineering',
    isActive: true,
    salary: 90000,
    skills: ['TypeScript', 'SQL'],
    address: { city: 'London', country: 'UK' },
    joinDate: '2021-03-01T00:00:00.000Z',
  },
  {
    name: 'Bob',
    age: 45,
    department: 'Sales',
    isActive: false,
    salary: 60000,
    skills: ['Negotiation'],
    address: { city: 'Bristol', country: 'UK' },
    joinDate: '2019-07-15T00:00:00.000Z',
  },
  {
    name: 'Carla',
    age: 27,
    department: 'Engineering',
    isActive: true,
    salary: 75000,
    skills: ['Python', 'SQL'],
    address: { city: 'London', country: 'UK' },
    joinDate: '2023-01-20T00:00:00.000Z',
  },
  {
    name: 'Dan',
    age: 50,
    department: 'Sales',
    isActive: true,
    salary: 65000,
    skills: ['Negotiation', 'SQL'],
    address: { city: 'Leeds', country: 'UK' },
    joinDate: '2018-11-05T00:00:00.000Z',
  },
  {
    name: 'Erin',
    age: 38,
    department: 'Engineering',
    isActive: false,
    salary: 82000,
    skills: ['Go'],
    address: { city: 'London', country: 'UK' },
    joinDate: '2022-06-30T00:00:00.000Z',
  },
];

let dir: string;
let dbPath: string;
let legacyPath: string;
let stdin: PassThrough;

let realStdout: NodeJS.WriteStream;
let realStdin: NodeJS.ReadStream;
let realExit: typeof process.exit;
let realCwd: string;

const strip = (value: string): string => value.replace(/\[[0-9;]*[A-Za-z]/g, '');

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

before(async () => {
  realStdout = process.stdout;
  realStdin = process.stdin;
  realExit = process.exit;
  realCwd = process.cwd();

  dir = mkdtempSync(path.join(tmpdir(), 'mongolite-explorer-'));
  dbPath = path.join(dir, 'shop.db');
  legacyPath = path.join(dir, 'legacy.db');

  const client = new MongoLite(dbPath);
  await client.connect();
  const collection = client.collection<Employee>('employees');
  for (const employee of employees) await collection.insertOne(employee);
  await client.collection('orders').insertOne({ total: 10, status: 'shipped' });
  await client.collection('orders').insertOne({ total: 25, status: 'pending' });

  // A collection that exists but holds nothing, for the empty-collection path.
  const scratch = client.collection('archive');
  const inserted = await scratch.insertOne({ placeholder: true });
  await scratch.deleteOne({ _id: inserted.insertedId });
  await client.close();

  // A database with no MongoLite collections at all.
  const legacy = new MongoLite(legacyPath);
  await legacy.connect();
  await legacy.database.exec('CREATE TABLE legacy (id INTEGER, label TEXT)');
  await legacy.database.exec("INSERT INTO legacy VALUES (1, 'one'), (2, 'two')");
  await legacy.close();

  // The database picker looks in the working directory.
  process.chdir(dir);

  process.env.MONGOLITE_NON_INTERACTIVE = '1';
  process.exit = ((code?: number): never => {
    throw new ExitCalled(code);
  }) as typeof process.exit;

  // One stdin for the whole file: the prompt layer keeps a single readline
  // interface over whatever stdin was when the first question was asked.
  stdin = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
});

after(() => {
  delete process.env.MONGOLITE_NON_INTERACTIVE;
  process.exit = realExit;
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
  process.chdir(realCwd);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Set once a scenario times out.
 *
 * A timed-out explorer is still waiting on a line, and it shares stdin with
 * every later scenario - it would steal their answers and turn one real
 * failure into a screenful of meaningless ones.
 */
let poisoned = false;

/**
 * Run the explorer against a script of answers and return everything it wrote.
 *
 * A prompt is a write with no trailing newline — every message helper ends its
 * output with one, and only `question` leaves the cursor on the line.
 */
async function explore(options: ExplorerOptions, answers: string[]): Promise<string> {
  if (poisoned) {
    throw new Error('skipped: an earlier scenario left the prompt layer waiting for input');
  }

  const chunks: string[] = [];
  let consumed = 0;
  let lastPrompt = '';

  class Driver extends Writable {
    isTTY = false;
    columns = 100;
    rows = 24;

    override _write(chunk: unknown, _encoding: string, callback: () => void): void {
      const written = String(chunk);
      chunks.push(written);
      if (!written.endsWith('\n')) {
        lastPrompt = written.trim();
        setImmediate(() => {
          if (consumed < answers.length) stdin.write(`${answers[consumed++]}\n`);
        });
      }
      callback();
    }
  }

  Object.defineProperty(process, 'stdout', { value: new Driver(), configurable: true });

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Explorer(options).run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          poisoned = true;
          reject(
            new Error(
              `The explorer is still waiting after ${consumed}/${answers.length} answers. ` +
                `Last prompt: ${JSON.stringify(lastPrompt)}`
            )
          );
        }, 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
  }

  assert.strictEqual(
    consumed,
    answers.length,
    `the script had ${answers.length - consumed} answer(s) left over, so it does not match the flow`
  );

  return strip(chunks.join(''));
}

/**
 * The rendered rows of the first result page, without the prompts around them.
 *
 * Field and value menus quote examples drawn from every document, so searching
 * the whole transcript for a name proves nothing about what the query matched.
 */
function resultsTable(out: string): string {
  const start = out.indexOf('matches  ');
  const end = out.indexOf('showing 1-');
  assert.ok(start >= 0 && end > start, 'the output should contain a results table');
  return out.slice(start, end);
}

/** Options that open the seeded database straight at the employees collection. */
const atEmployees = (extra: Partial<ExplorerOptions> = {}): ExplorerOptions => ({
  database: dbPath,
  collection: 'employees',
  pageSize: 2,
  ...extra,
});

describe('the explorer, driven end to end', () => {
  it('opens the database and collection named on the command line', async () => {
    const out = await explore(atEmployees(), ['Quit']);

    assert.ok(out.includes('Opened'));
    assert.ok(out.includes('5 documents'), 'the document count is reported');
    assert.ok(out.includes('employees — what would you like to do?'));
  });

  it('browses, pages back and forth, and opens one document', async () => {
    const out = await explore(atEmployees(), [
      'Browse documents',
      'Show the next 2',
      'Show the previous page',
      'View one document in full',
      '1',
      '', // pause after the document
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(out.includes('showing 1-2 of 5'));
    assert.ok(out.includes('showing 3-4 of 5'), 'the next page is reached');
    assert.ok(out.includes('Alice'));
  });

  it('changes the visible columns, both explicitly and back to everything', async () => {
    const out = await explore(atEmployees(), [
      'Browse documents',
      'Choose which columns to show',
      'name, age',
      'Choose which columns to show',
      '', // blank means every inferred field
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(out.includes('Current columns'));
    assert.ok(out.includes('address.city'), 'the blank answer widens to every field');
    assert.ok(out.includes('joinDate'), 'every inferred field is shown, not just the defaults');
  });

  it('builds a one-condition query from menus alone', async () => {
    const out = await explore(atEmployees(), [
      'Find documents',
      'Add a condition',
      'department',
      'is',
      'Sales', // department is low cardinality, so its values are offered
      'Run the query',
      "Don't sort",
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(out.includes('{"department":{"$eq":"Sales"}}'), 'the filter it built is shown');
    assert.ok(out.includes('2 document(s)'));

    // Only the rendered table: the menus quote example values from every
    // document, so the whole transcript mentions everyone.
    const table = resultsTable(out);
    assert.ok(table.includes('Bob'));
    assert.ok(table.includes('Dan'));
    assert.ok(!table.includes('Alice'), 'the filter really was applied');
  });

  it('combines conditions with OR, after removing one, and sorts the results', async () => {
    const out = await explore(atEmployees({ pageSize: 20 }), [
      'Find documents',
      'Add a condition',
      'age',
      'is at least',
      '45',
      'Add another condition',
      'department',
      'is',
      'Engineering',
      'Add another condition',
      'name',
      'contains the text',
      'Carla',
      'Remove a condition',
      '3', // drop the name condition again
      'Run the query',
      'any of these conditions',
      'age',
      'descending',
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(out.includes('Conditions so far'));
    assert.ok(out.includes('$or'), 'OR mode produces an $or filter');
    assert.ok(!out.includes('"name"'), 'the removed condition is gone from the filter');

    // age >= 45 or department Engineering: everyone except Bob... who is 45.
    const table = resultsTable(out);
    for (const name of ['Alice', 'Bob', 'Carla', 'Dan', 'Erin']) {
      assert.ok(table.includes(name), `${name} should match`);
    }
  });

  it('offers a free-text value when the wanted one is not in the menu', async () => {
    const out = await explore(atEmployees(), [
      'Find documents',
      'Add a condition',
      'department',
      'is',
      'Something else…',
      'Facilities',
      'Run the query',
      "Don't sort",
      '', // pause on the empty result
      'Quit',
    ]);

    assert.ok(out.includes('{"department":{"$eq":"Facilities"}}'));
    assert.ok(out.includes('Nothing matched'));
  });

  it('counts, lists distinct values and groups by a field', async () => {
    const out = await explore(atEmployees(), [
      'Count documents',
      'Add a condition',
      'department',
      'is',
      'Engineering',
      'Run the query',
      '', // pause after the count
      'List the values in a field',
      'department',
      '',
      'Count documents by field',
      'department',
      '',
      'Quit',
    ]);

    assert.ok(out.includes('3 document(s) match'), 'three engineers');
    assert.ok(out.includes('2 distinct value(s)'));
    assert.ok(out.includes('2 group(s)'));
  });

  it('counts with several conditions combined', async () => {
    const out = await explore(atEmployees(), [
      'Count documents',
      'Add a condition',
      'department',
      'is',
      'Engineering',
      'Add another condition',
      'age',
      'is less than',
      'Something else…', // 35 is not one of the ages on offer
      '35',
      'Run the query',
      'all of these conditions',
      '',
      'Quit',
    ]);

    assert.ok(out.includes('2 document(s) match'), 'Alice and Carla');
  });

  it('names a field by hand when picking one from the list is not enough', async () => {
    const out = await explore(atEmployees(), [
      'List the values in a field',
      'Type a field name myself…',
      'address.country',
      '',
      'Quit',
    ]);

    assert.ok(out.includes('Values of address.country'));
    assert.ok(out.includes('UK'));
  });

  it('shows the inferred schema and the indexes', async () => {
    const out = await explore(atEmployees(), [
      'Show the fields in this collection',
      '',
      'Show indexes',
      '',
      'Quit',
    ]);

    assert.ok(out.includes('Fields in employees'));
    assert.ok(out.includes('joinDate'));
    assert.ok(out.includes('Indexes on employees'));
  });

  it('reports that nothing has run yet, then shows the SQL once something has', async () => {
    const out = await explore(atEmployees(), [
      'Show the SQL for the last query',
      '',
      'Browse documents',
      'Show the SQL this ran',
      '',
      'Back to the menu',
      'Show the SQL for the last query',
      '',
      'Quit',
    ]);

    assert.ok(out.includes('Nothing has run yet'));
    assert.ok(out.includes('FROM "employees"'));
  });

  it('accepts a MongoDB filter written by hand, rejecting what is not one', async () => {
    const out = await explore(atEmployees({ pageSize: 20 }), [
      'Write a MongoDB filter yourself',
      'not json at all',
      '["an", "array"]',
      '{"age": {"$gt": 40}}',
      "Don't sort",
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(out.includes('That is not valid JSON'));
    assert.ok(out.includes('A filter must be a JSON object.'));
    assert.ok(out.includes('2 document(s)'), 'Bob and Dan are over 40');
  });

  it('runs raw SQL, and reports SQL that does not work', async () => {
    const out = await explore(atEmployees(), [
      'Run raw SQL',
      'SELECT nope FROM nothing',
      '', // blank line ends the SQL entry
      '', // pause after the error
      'Run raw SQL',
      'SELECT _id FROM "employees" LIMIT 2',
      '',
      '',
      'Run raw SQL',
      '', // an empty statement just returns
      'Quit',
    ]);

    assert.ok(out.includes('SQL error'));
    assert.ok(out.includes('2 row(s)'));
  });

  it('exports matching documents, and asks before overwriting', async () => {
    const target = path.join(dir, 'export.json');

    const first = await explore(atEmployees(), [
      'Browse documents',
      'Save these results to a JSON file',
      '3',
      target,
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(first.includes('Wrote 3 document(s)'));
    assert.strictEqual(JSON.parse(readFileSync(target, 'utf8')).length, 3);

    const declined = await explore(atEmployees(), [
      'Browse documents',
      'Save these results to a JSON file',
      '1',
      target,
      'n', // do not overwrite
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(declined.includes('already exists'));
    assert.ok(declined.includes('Not saved'));
    assert.strictEqual(
      JSON.parse(readFileSync(target, 'utf8')).length,
      3,
      'the file is untouched when the overwrite is declined'
    );

    const overwritten = await explore(atEmployees(), [
      'Browse documents',
      'Save these results to a JSON file',
      'not a number', // rejected by validation
      '1',
      target,
      'y',
      'Back to the menu',
      'Quit',
    ]);

    assert.ok(overwritten.includes('Enter a whole number.'));
    assert.strictEqual(JSON.parse(readFileSync(target, 'utf8')).length, 1);
  });

  it('goes from results straight back into changing the filter', async () => {
    const out = await explore(atEmployees(), [
      'Browse documents',
      'Change the filter',
      'Cancel', // backing out returns to the menu
      'Quit',
    ]);

    assert.ok(out.includes('Build your query'));
  });

  it('switches collection, then switches database', async () => {
    const out = await explore(atEmployees(), [
      'Switch collection',
      'orders',
      'Browse documents',
      'Back to the menu',
      'Open a different database',
      'Quit', // quit from the database picker
    ]);

    assert.ok(out.includes('orders — what would you like to do?'));
    assert.ok(out.includes('shipped'));
    assert.ok(out.includes('Which database do you want to open?'));
  });

  it('handles a collection with nothing in it', async () => {
    const out = await explore(atEmployees({ collection: 'archive' }), [
      'Find documents',
      'Add a condition', // there are no fields to add one from
      'Run without any filter',
      '', // pause on the empty result
      'Quit',
    ]);

    assert.ok(out.includes('This collection is empty'));
    assert.ok(out.includes('No fields were found'));
    assert.ok(out.includes('Nothing matched'));
  });

  it('falls back to the picker when -c names a collection that is not there', async () => {
    const out = await explore(atEmployees({ collection: 'nonexistent' }), ['orders', 'Quit']);

    assert.ok(out.includes('No collection named "nonexistent"'));
    assert.ok(out.includes('Which collection?'));
  });

  it('falls back to the picker when -d names a database that is not there', async () => {
    const out = await explore({ database: path.join(dir, 'missing.db') }, ['Quit']);

    assert.ok(out.includes('No database at'));
    assert.ok(out.includes('Which database do you want to open?'));
  });

  it('lets a path be typed in, and says so when there is no file there', async () => {
    const out = await explore({}, [
      'Enter a path manually…',
      path.join(dir, 'not-here.db'),
      'shop.db', // offered by the picker, relative to the working directory
      'Quit',
    ]);

    assert.ok(out.includes('No file at'));
    assert.ok(out.includes('Opened'));
  });

  it('offers raw SQL when a database has no MongoLite collections', async () => {
    const out = await explore({ database: legacyPath }, [
      'Run raw SQL against this one',
      'SELECT label FROM legacy',
      '',
      '', // pause after the rows
      'Quit',
    ]);

    assert.ok(out.includes('no MongoLite collections'));
    assert.ok(out.includes('It does contain 1 other table(s): legacy'));
    assert.ok(out.includes('2 row(s)'));
  });

  it('reports a database it cannot open rather than crashing', async () => {
    const broken = path.join(dir, 'broken.db');
    writeFileSync(broken, 'this is definitely not a sqlite file');

    const out = await explore({ database: broken }, ['Quit']);

    assert.ok(
      out.includes('Could not open that database') ||
        out.includes('Which database') ||
        out.includes('no MongoLite collections'),
      'a file that is not a database never reaches a collection menu'
    );
    assert.ok(existsSync(broken));
  });
});
