#!/usr/bin/env node
/**
 * `mongolite` — the guided explorer for MongoLite databases.
 *
 * Running it with no arguments is the intended path: it finds your database
 * files, lists the collections it finds inside, and walks you through a query.
 * Flags are shortcuts for people who already know where they are going, and
 * `--repl` drops into the older command-driven debugger.
 */
import { Explorer } from '../cli/explorer.js';
import { QueryDebugger } from '../debugger/query-debugger.js';
import { closePrompts, style } from '../cli/ui.js';

interface CliOptions {
  database?: string;
  collection?: string;
  verbose: boolean;
  help: boolean;
  version: boolean;
  repl: boolean;
  sampleSize?: number;
  pageSize?: number;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { verbose: false, help: false, version: false, repl: false };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--database':
      case '-d':
        options.database = argv[++index];
        break;
      case '--collection':
      case '-c':
        options.collection = argv[++index];
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--repl':
      case '--expert':
        options.repl = true;
        break;
      case '--sample':
        options.sampleSize = Number(argv[++index]);
        break;
      case '--page-size':
        options.pageSize = Number(argv[++index]);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-V':
        options.version = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
        break;
    }
  }

  // `mongolite ./app.db users` is the shape people try first, so support it.
  if (!options.database && positional[0]) options.database = positional[0];
  if (!options.collection && positional[1]) options.collection = positional[1];

  return options;
}

function showHelp(): void {
  const lines = [
    `${style.bold('mongolite')} — explore a MongoLite (SQLite-backed) database`,
    '',
    style.bold('Usage'),
    '  npx mongolite                      Start the guided explorer',
    '  npx mongolite ./app.db             Open a specific database',
    '  npx mongolite ./app.db users       Open a specific collection',
    '',
    style.bold('Options'),
    '  -d, --database <path>   Database file to open (otherwise you get a list to pick from)',
    '  -c, --collection <name> Collection to start in',
    '      --sample <n>        Documents to sample when inferring fields (default 200)',
    '      --page-size <n>     Results shown per page (default 20)',
    '      --repl              Use the older command-driven debugger instead',
    '  -v, --verbose           Log the SQL being built',
    '  -h, --help              Show this help',
    '  -V, --version           Show the version',
    '',
    style.bold('In the explorer'),
    '  ↑/↓ move · type to filter the list · enter to choose · esc to go back · Ctrl+C to quit',
    '',
    'No MongoDB knowledge is needed: pick a field, pick a condition in plain English,',
    'and the filter it builds is printed so you can learn the syntax as you go.',
    'If you already know it, "Write a MongoDB filter yourself" and "Run raw SQL" are',
    'under Advanced.',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Find the package version by walking up from the running script.
 * Deliberately avoids `import.meta` and `__dirname` so the same source compiles
 * for both the ESM and CommonJS builds.
 */
async function showVersion(): Promise<void> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, join, parse } = await import('node:path');

  let dir = dirname(process.argv[1] ?? process.cwd());
  const { root } = parse(dir);

  while (dir && dir !== root) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if (pkg.version) {
          process.stdout.write(`${pkg.version}\n`);
          return;
        }
      } catch {
        // Unreadable package.json - keep walking up.
      }
    }
    dir = dirname(dir);
  }

  process.stdout.write('unknown\n');
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('Run with --help to see the available options.\n');
    process.exit(1);
    return;
  }

  if (options.help) {
    showHelp();
    return;
  }
  if (options.version) {
    await showVersion();
    return;
  }

  if (options.repl) {
    const queryDebugger = new QueryDebugger({
      database: options.database,
      collection: options.collection,
      verbose: options.verbose,
    });
    await queryDebugger.start();
    return;
  }

  const explorer = new Explorer({
    database: options.database,
    collection: options.collection,
    verbose: options.verbose,
    sampleSize: Number.isFinite(options.sampleSize) ? options.sampleSize : undefined,
    pageSize: Number.isFinite(options.pageSize) ? options.pageSize : undefined,
  });

  await explorer.run();
}

main()
  .then(() => {
    closePrompts();
    process.exit(0);
  })
  .catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n✖ ${text}\n`);
    if (text.includes('SQLITE_CANTOPEN') || text.includes('unable to open')) {
      process.stderr.write('  The file may not exist, or may not be readable.\n');
    }
    process.exit(1);
  });
