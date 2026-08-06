/**
 * The guided MongoLite explorer.
 *
 * The flow is deliberately linear — pick a database, pick a collection, pick
 * something to do — and every step offers real choices derived from the data
 * rather than asking the user to type something they have to know already.
 * MongoDB syntax stays available under "Advanced", and every guided query
 * prints the filter it built, so the CLI teaches the syntax instead of hiding
 * it.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MongoLite } from '../index.js';
import type { MongoLiteCollection } from '../collection.js';
import type { DocumentWithId, Filter, SortCriteria } from '../types.js';
import {
  findDatabaseFiles,
  formatBytes,
  formatRelativeTime,
  listCollectionInfo,
  resolveDatabasePath,
  databaseExists,
  type CollectionInfo,
} from './discover.js';
import {
  defaultColumns,
  describeField,
  getPath,
  inferSchema,
  type InferredField,
  type InferredSchema,
} from './schema.js';
import {
  combineConditions,
  describeCondition,
  operatorsFor,
  parseValue,
  parseValueList,
  type Condition,
} from './filter-builder.js';
import { renderDocument, renderSchema, renderSql, renderTable, formatCell } from './format.js';
import {
  Choice,
  PromptCancelledError,
  confirm,
  error,
  heading,
  info,
  multilineText,
  pause,
  select,
  style,
  success,
  text,
  warn,
} from './ui.js';

export interface ExplorerOptions {
  database?: string;
  collection?: string;
  verbose?: boolean;
  /** How many documents to sample when inferring the schema. Default 200. */
  sampleSize?: number;
  /** Rows shown per page of results. Default 20. */
  pageSize?: number;
}

type Doc = Record<string, unknown> & DocumentWithId;

interface QueryState {
  filter: Filter<Doc>;
  sort: SortCriteria<Doc> | null;
  /** Human-readable description of how the filter was built. */
  description: string;
}

export class Explorer {
  private client: MongoLite | null = null;
  private dbPath: string | null = null;
  private collectionName: string | null = null;
  private schema: InferredSchema | null = null;
  private lastSql: { sql: string; params: unknown[] } | null = null;
  private lastQuery: QueryState | null = null;
  /**
   * `-d`/`-c` are a starting point, not a preference. Once they have been
   * honoured they are forgotten, otherwise "open a different database" would
   * take you straight back to the one on the command line.
   */
  private startingDatabaseUsed = false;
  private startingCollectionUsed = false;

  private readonly sampleSize: number;
  private readonly pageSize: number;

  constructor(private readonly options: ExplorerOptions = {}) {
    this.sampleSize = options.sampleSize ?? 200;
    this.pageSize = options.pageSize ?? 20;
  }

  // ---------------------------------------------------------------- lifecycle

  async run(): Promise<void> {
    info(`${style.bold('MongoLite')} ${style.grey('· interactive explorer')}`);
    info(style.grey('Ctrl+C to quit at any point.\n'));

    try {
      for (;;) {
        if (!this.client) {
          const connected = await this.chooseDatabase();
          if (!connected) return;
        }
        if (!this.collectionName) {
          const chosen = await this.chooseCollection();
          if (chosen === 'quit') return;
          if (chosen === 'switch-database') {
            await this.disconnect();
            continue;
          }
        }
        const outcome = await this.collectionMenu();
        if (outcome === 'quit') return;
        if (outcome === 'switch-collection') {
          this.collectionName = null;
          this.schema = null;
        }
        if (outcome === 'switch-database') {
          await this.disconnect();
          this.collectionName = null;
          this.schema = null;
        }
      }
    } finally {
      await this.disconnect();
    }
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Closing a database we may never have opened is not worth reporting.
      }
    }
    this.client = null;
    this.dbPath = null;
  }

  // ------------------------------------------------------------ step 1: file

  private async chooseDatabase(): Promise<boolean> {
    // An explicit -d wins the first time round, as long as it is usable.
    if (this.options.database && !this.startingDatabaseUsed) {
      this.startingDatabaseUsed = true;
      const resolved = resolveDatabasePath(this.options.database);
      if (databaseExists(resolved)) {
        if (await this.connect(resolved)) return true;
      } else {
        warn(`No database at ${style.bold(resolved)} — pick one below.`);
      }
    }

    for (;;) {
      const candidates = findDatabaseFiles(process.cwd());
      const choices: Choice<string>[] = candidates.map((candidate) => ({
        label: candidate.relativePath,
        value: candidate.path,
        hint: `${formatBytes(candidate.sizeBytes)} · ${formatRelativeTime(candidate.modified)}`,
      }));

      if (choices.length === 0) {
        warn('No .db/.sqlite files found in this directory.');
      }

      choices.push({ label: 'Enter a path manually…', value: '__manual__' });
      choices.push({ label: 'Quit', value: '__quit__' });

      let picked: string;
      try {
        picked = await select({
          message: 'Which database do you want to open?',
          choices,
          hint: '  ↑/↓ move · type to filter · enter to open',
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) return false;
        throw err;
      }

      if (picked === '__quit__') return false;

      const target =
        picked === '__manual__'
          ? resolveDatabasePath(
              await text({
                message: 'Path to the database file',
                defaultValue: path.join(process.cwd(), 'mongolite.db'),
              })
            )
          : picked;

      if (!databaseExists(target)) {
        error(`No file at ${target}`);
        continue;
      }
      if (await this.connect(target)) return true;
    }
  }

  private async connect(dbPath: string): Promise<boolean> {
    try {
      const client = new MongoLite(dbPath, { verbose: this.options.verbose });
      await client.connect();
      this.client = client;
      this.dbPath = dbPath;
      success(`Opened ${style.bold(path.relative(process.cwd(), dbPath) || dbPath)}`);
      return true;
    } catch (err) {
      error(`Could not open that database: ${message(err)}`);
      return false;
    }
  }

  // ------------------------------------------------------ step 2: collection

  private async chooseCollection(): Promise<'ok' | 'quit' | 'switch-database'> {
    const client = this.requireClient();

    let collections: CollectionInfo[];
    try {
      collections = await listCollectionInfo(client.database);
    } catch (err) {
      error(`Could not read the collections: ${message(err)}`);
      return 'switch-database';
    }

    const usable = collections.filter((collection) => collection.isMongoLite);
    const foreign = collections.filter((collection) => !collection.isMongoLite);

    if (usable.length === 0) {
      warn('This database has no MongoLite collections.');
      if (foreign.length > 0) {
        info(
          style.grey(
            `  It does contain ${foreign.length} other table(s): ${foreign
              .map((table) => table.name)
              .slice(0, 5)
              .join(', ')}`
          )
        );
        info(style.grey('  You can still inspect them with the raw SQL option.'));
      }
      const next = await select<'switch-database' | 'quit' | 'sql'>({
        message: 'What now?',
        choices: [
          { label: 'Open a different database', value: 'switch-database' },
          { label: 'Run raw SQL against this one', value: 'sql' },
          { label: 'Quit', value: 'quit' },
        ],
      });
      if (next === 'sql') {
        await this.runRawSql();
        return this.chooseCollection();
      }
      return next;
    }

    // An explicit -c only counts the first time, and only if it is really there.
    if (this.options.collection && !this.startingCollectionUsed) {
      this.startingCollectionUsed = true;
      const match = usable.find((collection) => collection.name === this.options.collection);
      if (match) {
        await this.useCollection(match.name);
        return 'ok';
      }
      warn(`No collection named "${this.options.collection}" in this database.`);
    }

    const choices: Choice<string>[] = usable.map((collection) => ({
      label: collection.name,
      value: collection.name,
      hint: `${collection.count.toLocaleString()} document${collection.count === 1 ? '' : 's'}`,
    }));
    choices.push({ label: 'Open a different database', value: '__switch__' });
    choices.push({ label: 'Quit', value: '__quit__' });

    let picked: string;
    try {
      picked = await select({ message: 'Which collection?', choices });
    } catch (err) {
      if (err instanceof PromptCancelledError) return 'switch-database';
      throw err;
    }

    if (picked === '__quit__') return 'quit';
    if (picked === '__switch__') return 'switch-database';

    await this.useCollection(picked);
    return 'ok';
  }

  private async useCollection(name: string): Promise<void> {
    this.collectionName = name;
    this.lastQuery = null;
    const collection = this.collection();

    try {
      const sample = (await collection.find({}).limit(this.sampleSize).toArray()) as Doc[];
      this.schema = inferSchema(sample);
      const total = await collection.countDocuments({});
      const fieldCount = this.schema.fields.length;
      info(
        style.grey(
          `  ${total.toLocaleString()} documents · ${fieldCount} field${fieldCount === 1 ? '' : 's'} inferred from ${sample.length.toLocaleString()} sampled`
        )
      );
      if (total === 0) {
        warn('This collection is empty, so there is not much to explore yet.');
      }
    } catch (err) {
      warn(`Could not sample "${name}": ${message(err)}`);
      this.schema = { sampled: 0, fields: [] };
    }
  }

  // -------------------------------------------------------- step 3: what now

  private async collectionMenu(): Promise<
    'quit' | 'switch-collection' | 'switch-database' | 'stay'
  > {
    type Action =
      | 'browse'
      | 'find'
      | 'count'
      | 'distinct'
      | 'group'
      | 'schema'
      | 'indexes'
      | 'json-filter'
      | 'sql'
      | 'last-sql'
      | 'switch-collection'
      | 'switch-database'
      | 'quit';

    const choices: Choice<Action>[] = [
      { label: 'Browse documents', value: 'browse', hint: '— page through everything' },
      { label: 'Find documents', value: 'find', hint: '— build a filter step by step' },
      { label: 'Count documents', value: 'count', hint: '— how many match a filter' },
      { label: 'List the values in a field', value: 'distinct', hint: '— distinct values' },
      { label: 'Count documents by field', value: 'group', hint: '— e.g. orders per status' },
      { label: 'Show the fields in this collection', value: 'schema' },
      { label: 'Show indexes', value: 'indexes' },
      { label: 'Advanced', value: 'json-filter', separator: true },
      { label: 'Write a MongoDB filter yourself', value: 'json-filter', hint: '— JSON' },
      { label: 'Run raw SQL', value: 'sql' },
      { label: 'Show the SQL for the last query', value: 'last-sql' },
      { label: ' ', value: 'quit', separator: true },
      { label: 'Switch collection', value: 'switch-collection' },
      { label: 'Open a different database', value: 'switch-database' },
      { label: 'Quit', value: 'quit' },
    ];

    let action: Action;
    try {
      action = await select({
        message: `${this.collectionName} — what would you like to do?`,
        choices,
        pageSize: 16,
      });
    } catch (err) {
      if (err instanceof PromptCancelledError) return 'switch-collection';
      throw err;
    }

    try {
      switch (action) {
        case 'browse':
          await this.runQuery({ filter: {}, sort: null, description: 'all documents' });
          break;
        case 'find':
          await this.guidedFind();
          break;
        case 'count':
          await this.countFlow();
          break;
        case 'distinct':
          await this.distinctFlow();
          break;
        case 'group':
          await this.groupFlow();
          break;
        case 'schema':
          await this.showSchema();
          break;
        case 'indexes':
          await this.showIndexes();
          break;
        case 'json-filter':
          await this.jsonFilterFlow();
          break;
        case 'sql':
          await this.runRawSql();
          break;
        case 'last-sql':
          this.showLastSql();
          await pause();
          break;
        case 'switch-collection':
          return 'switch-collection';
        case 'switch-database':
          return 'switch-database';
        case 'quit':
          return 'quit';
      }
    } catch (err) {
      if (!(err instanceof PromptCancelledError)) {
        error(message(err));
        await pause();
      }
    }

    return 'stay';
  }

  // ------------------------------------------------------------ guided query

  private async guidedFind(): Promise<void> {
    const conditions = await this.buildConditions();
    if (conditions === null) return;

    let filter: Filter<Doc> = {};
    let description = 'all documents';

    if (conditions.length > 0) {
      const mode =
        conditions.length === 1
          ? 'all'
          : await select<'all' | 'any'>({
              message: 'Should documents match…',
              choices: [
                { label: 'all of these conditions', value: 'all', hint: '— AND' },
                { label: 'any of these conditions', value: 'any', hint: '— OR' },
              ],
            });
      filter = combineConditions(conditions, mode) as Filter<Doc>;
      description = conditions
        .map((condition) => describeCondition(condition))
        .join(mode === 'all' ? ' and ' : ' or ');
    }

    const sort = await this.chooseSort();
    await this.runQuery({ filter, sort, description });
  }

  /** Collect conditions until the user is done. Returns null when cancelled. */
  private async buildConditions(existing: Condition[] = []): Promise<Condition[] | null> {
    const conditions = [...existing];

    for (;;) {
      if (conditions.length > 0) {
        heading('Conditions so far');
        conditions.forEach((condition, index) => {
          info(`  ${index + 1}. ${describeCondition(condition)}`);
        });
        info('');
      }

      type Step = 'add' | 'run' | 'remove' | 'cancel';
      const choices: Choice<Step>[] = [
        {
          label: conditions.length === 0 ? 'Add a condition' : 'Add another condition',
          value: 'add',
        },
        {
          label: conditions.length === 0 ? 'Run without any filter' : 'Run the query',
          value: 'run',
        },
      ];
      if (conditions.length > 0) choices.push({ label: 'Remove a condition', value: 'remove' });
      choices.push({ label: 'Cancel', value: 'cancel' });

      let step: Step;
      try {
        step = await select({ message: 'Build your query', choices });
      } catch (err) {
        if (err instanceof PromptCancelledError) return null;
        throw err;
      }

      if (step === 'cancel') return null;
      if (step === 'run') return conditions;
      if (step === 'remove') {
        const index = await select<number>({
          message: 'Remove which condition?',
          choices: conditions.map((condition, position) => ({
            label: describeCondition(condition),
            value: position,
          })),
        });
        conditions.splice(index, 1);
        continue;
      }

      const condition = await this.buildOneCondition();
      if (condition) conditions.push(condition);
    }
  }

  private async buildOneCondition(): Promise<Condition | null> {
    const schema = this.schema;
    if (!schema || schema.fields.length === 0) {
      warn('No fields were found in this collection, so there is nothing to filter on.');
      return null;
    }

    let field: InferredField | '__custom__';
    try {
      field = await select<InferredField | '__custom__'>({
        message: 'Which field?',
        choices: [
          ...schema.fields.map((candidate) => ({
            label: candidate.path,
            value: candidate,
            hint: describeField(candidate),
          })),
          { label: 'Type a field name myself…', value: '__custom__' as const },
        ],
        pageSize: 14,
      });
    } catch (err) {
      if (err instanceof PromptCancelledError) return null;
      throw err;
    }

    const resolved: InferredField =
      field === '__custom__'
        ? {
            path: await text({
              message: 'Field name (dot notation for nested fields, e.g. address.city)',
            }),
            types: ['string'],
            primaryType: 'string',
            count: 0,
            presence: 0,
            examples: [],
            lowCardinality: false,
          }
        : field;

    const operators = operatorsFor(resolved);
    let operatorId: string;
    try {
      operatorId = await select({
        message: `${resolved.path} …`,
        choices: operators.map((operator) => ({
          label: operator.label,
          value: operator.id,
          hint: operator.hint ? `— ${operator.hint}` : undefined,
        })),
        pageSize: 14,
      });
    } catch (err) {
      if (err instanceof PromptCancelledError) return null;
      throw err;
    }

    const operator = operators.find((candidate) => candidate.id === operatorId);
    if (!operator) return null;

    // Values are parsed as the element type for array fields, so
    // "tags contains work" compares against the strings inside the array.
    const valueType =
      resolved.primaryType === 'array'
        ? (resolved.elementTypes?.find((type) => type !== 'null') ?? 'string')
        : resolved.primaryType;

    const values: unknown[] = [];
    try {
      if (operator.arity === 'one') {
        values.push(await this.askForValue(resolved, valueType, operator.valuePrompt ?? 'Value'));
      } else if (operator.arity === 'two') {
        values.push(await this.askForValue(resolved, valueType, operator.valuePrompt ?? 'From'));
        values.push(
          await this.askForValue(resolved, valueType, operator.secondValuePrompt ?? 'To')
        );
      } else if (operator.arity === 'many') {
        const raw = await text({
          message: operator.valuePrompt ?? 'Values (comma separated)',
          validate: (input) => {
            try {
              parseValueList(input, valueType);
              return undefined;
            } catch (err) {
              return message(err);
            }
          },
        });
        values.push(...parseValueList(raw, valueType));
      }
    } catch (err) {
      if (err instanceof PromptCancelledError) return null;
      throw err;
    }

    return { field: resolved.path, operator: operatorId, values, fieldType: valueType };
  }

  /**
   * Ask for one value. When the field has few distinct values in the sample we
   * offer them as a menu — no typing, no guessing at spelling or casing.
   */
  private async askForValue(
    field: InferredField,
    valueType: Condition['fieldType'],
    prompt: string
  ): Promise<unknown> {
    if (field.lowCardinality && field.distinctValues && field.distinctValues.length > 1) {
      const picked = await select<unknown>({
        message: prompt,
        choices: [
          ...field.distinctValues.map((value) => ({
            label: formatCell(value),
            value,
          })),
          { label: 'Something else…', value: '__other__' },
        ],
        hint: style.grey(`  values seen in ${field.count} sampled document(s)`),
        pageSize: 14,
      });
      if (picked !== '__other__') return picked;
    }

    const raw = await text({
      message: prompt,
      hint: field.examples.length
        ? style.grey(`  examples: ${field.examples.slice(0, 3).map(formatCell).join(', ')}`)
        : undefined,
      validate: (input) => {
        try {
          parseValue(input, valueType);
          return undefined;
        } catch (err) {
          return message(err);
        }
      },
    });
    return parseValue(raw, valueType);
  }

  private async chooseSort(): Promise<SortCriteria<Doc> | null> {
    const schema = this.schema;
    if (!schema || schema.fields.length === 0) return null;

    const sortable = schema.fields.filter((field) =>
      ['string', 'number', 'date', 'boolean'].includes(field.primaryType)
    );
    if (sortable.length === 0) return null;

    const field = await select<string | null>({
      message: 'Sort the results by…',
      choices: [
        { label: "Don't sort", value: null },
        ...sortable.map((candidate) => ({
          label: candidate.path,
          value: candidate.path,
          hint: describeField(candidate),
        })),
      ],
      pageSize: 12,
    });
    if (!field) return null;

    const direction = await select<1 | -1>({
      message: `Sort ${field}…`,
      choices: [
        { label: 'ascending', value: 1, hint: '— A→Z, smallest first, oldest first' },
        { label: 'descending', value: -1, hint: '— Z→A, largest first, newest first' },
      ],
    });

    return { [field]: direction } as SortCriteria<Doc>;
  }

  // -------------------------------------------------------------- run & view

  private async runQuery(query: QueryState): Promise<void> {
    this.lastQuery = query;
    const collection = this.collection();

    let total: number;
    try {
      total = await collection.countDocuments(query.filter);
    } catch (err) {
      error(`That query could not run: ${message(err)}`);
      await pause();
      return;
    }

    heading('Query');
    info(`  ${style.grey('matching')} ${query.description}`);
    info(`  ${style.grey('filter')}   ${JSON.stringify(query.filter)}`);
    if (query.sort) info(`  ${style.grey('sort')}     ${JSON.stringify(query.sort)}`);
    info(`  ${style.grey('matches')}  ${style.bold(total.toLocaleString())} document(s)`);

    if (total === 0) {
      info('');
      info(style.grey('  Nothing matched. Try a looser condition, or check the field spelling.'));
      await pause();
      return;
    }

    let columns = this.schema ? defaultColumns(this.schema) : ['_id'];
    let offset = 0;

    for (;;) {
      const cursor = collection.find(query.filter).skip(offset).limit(this.pageSize);
      if (query.sort) cursor.sort(query.sort);
      this.lastSql = cursor.toSQL();

      let docs: Doc[];
      try {
        docs = (await cursor.toArray()) as Doc[];
      } catch (err) {
        error(`Could not fetch results: ${message(err)}`);
        await pause();
        return;
      }

      if (docs.length === 0 && offset > 0) {
        info(style.grey('  No more documents.'));
        offset = Math.max(0, offset - this.pageSize);
        continue;
      }

      info('');
      info(renderTable(docs, { columns, startIndex: offset }));
      info(
        style.grey(`  showing ${offset + 1}-${offset + docs.length} of ${total.toLocaleString()}`)
      );
      info('');

      type ResultAction =
        'next' | 'prev' | 'view' | 'columns' | 'sql' | 'export' | 'refine' | 'done';
      const choices: Choice<ResultAction>[] = [];
      if (offset + docs.length < total) {
        choices.push({ label: `Show the next ${this.pageSize}`, value: 'next' });
      }
      if (offset > 0) choices.push({ label: 'Show the previous page', value: 'prev' });
      choices.push({ label: 'View one document in full', value: 'view' });
      choices.push({ label: 'Choose which columns to show', value: 'columns' });
      choices.push({ label: 'Save these results to a JSON file', value: 'export' });
      choices.push({ label: 'Show the SQL this ran', value: 'sql' });
      choices.push({ label: 'Change the filter', value: 'refine' });
      choices.push({ label: 'Back to the menu', value: 'done' });

      let action: ResultAction;
      try {
        action = await select({ message: 'Results', choices, pageSize: 12 });
      } catch (err) {
        if (err instanceof PromptCancelledError) return;
        throw err;
      }

      switch (action) {
        case 'next':
          offset += this.pageSize;
          break;
        case 'prev':
          offset = Math.max(0, offset - this.pageSize);
          break;
        case 'view': {
          const doc = await select<Doc>({
            message: 'Which document?',
            choices: docs.map((candidate, index) => ({
              label: `${offset + index + 1}. ${formatCell(candidate._id)}`,
              value: candidate,
              hint: columns
                .filter((column) => column !== '_id')
                .slice(0, 2)
                .map((column) => formatCell(getPath(candidate, column)))
                .join(' · '),
            })),
            pageSize: 12,
          });
          heading('Document');
          info(renderDocument(doc));
          await pause();
          break;
        }
        case 'columns':
          columns = await this.chooseColumns(columns);
          break;
        case 'export':
          await this.exportDocuments(query, total);
          break;
        case 'sql':
          this.showLastSql();
          await pause();
          break;
        case 'refine':
          return this.guidedFind();
        case 'done':
          return;
      }
    }
  }

  private async chooseColumns(current: string[]): Promise<string[]> {
    const schema = this.schema;
    if (!schema) return current;

    info(style.grey(`  Current columns: ${current.join(', ')}`));
    const raw = await text({
      message: 'Columns to show (comma separated, blank for all fields)',
      defaultValue: current.join(', '),
      allowEmpty: true,
      hint: style.grey(`  available: ${schema.fields.map((field) => field.path).join(', ')}`),
    });

    if (raw.trim() === '') return schema.fields.map((field) => field.path);
    const columns = raw
      .split(',')
      .map((column) => column.trim())
      .filter((column) => column !== '');
    return columns.length > 0 ? columns : current;
  }

  private async exportDocuments(query: QueryState, total: number): Promise<void> {
    const limitRaw = await text({
      message: `How many documents? (up to ${total})`,
      defaultValue: String(Math.min(total, 1000)),
      validate: (input) =>
        Number.isInteger(Number(input)) && Number(input) > 0 ? undefined : 'Enter a whole number.',
    });
    const limit = Number(limitRaw);

    const file = await text({
      message: 'Save to which file?',
      defaultValue: path.join(process.cwd(), `${this.collectionName}-export.json`),
    });

    const cursor = this.collection().find(query.filter).limit(limit);
    if (query.sort) cursor.sort(query.sort);
    const docs = await cursor.toArray();

    const target = path.resolve(file);
    if (existsSync(target)) {
      const overwrite = await confirm(`${target} already exists. Overwrite it?`, false);
      if (!overwrite) {
        info(style.grey('  Not saved.'));
        return;
      }
    }

    writeFileSync(target, `${JSON.stringify(docs, null, 2)}\n`, 'utf8');
    success(`Wrote ${docs.length.toLocaleString()} document(s) to ${target}`);
  }

  // ------------------------------------------------------------ other actions

  private async countFlow(): Promise<void> {
    const conditions = await this.buildConditions();
    if (conditions === null) return;

    const mode =
      conditions.length > 1
        ? await select<'all' | 'any'>({
            message: 'Should documents match…',
            choices: [
              { label: 'all of these conditions', value: 'all', hint: '— AND' },
              { label: 'any of these conditions', value: 'any', hint: '— OR' },
            ],
          })
        : 'all';

    const filter = combineConditions(conditions, mode) as Filter<Doc>;
    const count = await this.collection().countDocuments(filter);

    heading('Count');
    info(`  ${style.grey('filter')} ${JSON.stringify(filter)}`);
    info(`  ${style.bold(count.toLocaleString())} document(s) match`);
    await pause();
  }

  private async distinctFlow(): Promise<void> {
    const field = await this.pickField('Show the distinct values of which field?');
    if (!field) return;

    const values = await this.collection().distinct(field);
    heading(`Values of ${field}`);
    if (values.length === 0) {
      info(style.grey('  No values found.'));
    } else {
      const shown = values.slice(0, 200);
      shown.forEach((value) => info(`  ${formatCell(value)}`));
      info(
        style.grey(
          `  ${values.length.toLocaleString()} distinct value(s)${values.length > shown.length ? `, showing the first ${shown.length}` : ''}`
        )
      );
    }
    await pause();
  }

  private async groupFlow(): Promise<void> {
    const field = await this.pickField('Count documents by which field?');
    if (!field) return;

    const results = (await this.collection()
      .aggregate([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { count: -1 } }])
      .toArray()) as Record<string, unknown>[];

    heading(`Documents per ${field}`);
    if (results.length === 0) {
      info(style.grey('  Nothing to count.'));
    } else {
      // `$group` names the grouping key `_id`; label it with the real field so
      // the table reads the way the question was asked.
      const rows = results.map((row) => ({ [field]: row._id, count: row.count }));
      info(
        renderTable(rows, {
          columns: [field, 'count'],
          showRowNumbers: false,
        })
      );
      info(style.grey(`  ${results.length.toLocaleString()} group(s)`));
    }
    await pause();
  }

  private async pickField(message_: string): Promise<string | null> {
    const schema = this.schema;
    if (!schema || schema.fields.length === 0) {
      warn('No fields were found in this collection.');
      await pause();
      return null;
    }
    try {
      const picked = await select<string>({
        message: message_,
        choices: [
          ...schema.fields.map((field) => ({
            label: field.path,
            value: field.path,
            hint: describeField(field),
          })),
          { label: 'Type a field name myself…', value: '__custom__' },
        ],
        pageSize: 14,
      });
      if (picked !== '__custom__') return picked;
      return await text({ message: 'Field name' });
    } catch (err) {
      if (err instanceof PromptCancelledError) return null;
      throw err;
    }
  }

  private async showSchema(): Promise<void> {
    const schema = this.schema;
    heading(`Fields in ${this.collectionName}`);
    if (!schema) {
      info(style.grey('  Nothing sampled yet.'));
    } else {
      info(renderSchema(schema));
      info(
        style.grey(
          `\n  Inferred from ${schema.sampled.toLocaleString()} sampled document(s) — fields that only appear in rarer documents may be missing.`
        )
      );
    }
    await pause();
  }

  private async showIndexes(): Promise<void> {
    heading(`Indexes on ${this.collectionName}`);
    try {
      const indexes = await this.collection().listIndexes().toArray();
      if (indexes.length === 0) {
        info(style.grey('  No indexes beyond the _id primary key.'));
      } else {
        for (const index of indexes) {
          info(`  ${style.bold(index.name)} ${style.grey(JSON.stringify(index.key))}`);
        }
      }
    } catch (err) {
      error(message(err));
    }
    await pause();
  }

  // ------------------------------------------------------------------ escape
  // hatches for people who do know MongoDB / SQL

  private async jsonFilterFlow(): Promise<void> {
    info(
      style.grey(
        '  Enter a MongoDB-style filter as JSON, e.g. {"age": {"$gt": 25}, "isActive": true}'
      )
    );
    const raw = await text({
      message: 'Filter',
      defaultValue: '{}',
      validate: (input) => {
        try {
          const parsed = JSON.parse(input);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return 'A filter must be a JSON object.';
          }
          return undefined;
        } catch (err) {
          return `That is not valid JSON: ${message(err)}`;
        }
      },
    });

    const filter = JSON.parse(raw) as Filter<Doc>;
    const sort = await this.chooseSort();
    await this.runQuery({ filter, sort, description: `filter ${raw}` });
  }

  private async runRawSql(): Promise<void> {
    const client = this.requireClient();
    info(
      style.grey(
        `  Documents live in a "data" JSON column, e.g. SELECT _id, json_extract(data, '$.name') FROM "${this.collectionName ?? 'collection'}"`
      )
    );
    const sql = await multilineText('SQL to run');
    if (sql.trim() === '') return;

    try {
      const rows = await client.database.all<Record<string, unknown>>(sql);
      heading('Rows');
      if (rows.length === 0) {
        info(style.grey('  No rows returned.'));
      } else {
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        info(renderTable(rows, { columns }));
        info(style.grey(`  ${rows.length.toLocaleString()} row(s)`));
      }
      this.lastSql = { sql, params: [] };
    } catch (err) {
      error(`SQL error: ${message(err)}`);
    }
    await pause();
  }

  private showLastSql(): void {
    heading('Last query');
    if (!this.lastSql) {
      info(style.grey('  Nothing has run yet.'));
      return;
    }
    if (this.lastQuery) {
      info(`${style.bold('Filter')}\n${JSON.stringify(this.lastQuery.filter, null, 2)}`);
    }
    info(renderSql(this.lastSql.sql, this.lastSql.params));
  }

  // ------------------------------------------------------------------ helpers

  private requireClient(): MongoLite {
    if (!this.client) throw new Error('No database is open.');
    return this.client;
  }

  private collection(): MongoLiteCollection<Doc> {
    if (!this.collectionName) throw new Error('No collection is selected.');
    return this.requireClient().collection<Doc>(this.collectionName);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
