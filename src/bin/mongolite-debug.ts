#!/usr/bin/env node

import { QueryDebugger } from '../debugger/query-debugger.js';
import path from 'path';

// CLI argument parsing
function parseArgs(): {
  verbose?: boolean;
  collection?: string;
  database?: string;
  help?: boolean;
} {
  const args = process.argv.slice(2);
  const options: any = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--collection' || arg === '-c') {
      options.collection = args[++i];
    } else if (arg === '--database' || arg === '-d') {
      options.database = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function showHelp() {
  console.log('MongoLite Query Debugger');
  console.log('');
  console.log('Interactive debugging tool for MongoLite queries.');
  console.log('');
  console.log('Usage: npx mongolite-debug [options]');
  console.log('');
  console.log('Options:');
  console.log('  -d, --database <path>     Database file path (default: ./mongolite.db)');
  console.log('  -c, --collection <name>   Initial collection to use');
  console.log('  -v, --verbose             Enable verbose output');
  console.log('  -h, --help                Show this help');
  console.log('');
  console.log('Interactive Commands:');
  console.log('  .help                     Show available commands');
  console.log('  .collections              List all collections');
  console.log('  .use <collection>         Select a collection to work with');
  console.log('  .find <filter>            Convert find filter to SQL and execute');
  console.log('  .sql <query>              Execute raw SQL query');
  console.log('  .last                     Show last generated SQL');
  console.log('  .sample [count]           Show sample documents from current collection');
  console.log('  .exit                     Exit the debugger');
  console.log('');
  console.log('Examples:');
  console.log('  npx mongolite-debug -d ./myapp.db -c users');
  console.log('  npx mongolite-debug --verbose');
  console.log('');
  console.log('  # Inside the debugger:');
  console.log('  .use users');
  console.log('  .find {"age": {"$gt": 25}}');
  console.log('  .sql SELECT * FROM users WHERE json_extract(data, "$.age") > 25');
  console.log('');
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Set default database path if not provided
  if (!options.database) {
    // Look for common database files in the current directory
    const cwd = process.cwd();
    const commonNames = [
      'mongolite.db',
      'mongolite.sqlite',
      'database.db',
      'database.sqlite',
      'app.db',
      'app.sqlite'
    ];

    // Check if any common database files exist
    const { existsSync } = await import('fs');
    let foundDb = false;

    for (const name of commonNames) {
      const dbPath = path.join(cwd, name);
      if (existsSync(dbPath)) {
        options.database = dbPath;
        foundDb = true;
        break;
      }
    }

    if (!foundDb) {
      options.database = path.join(cwd, 'mongolite.db');
    }
  }

  console.log('🔍 MongoLite Query Debugger (npx version)');
  console.log(`📁 Database: ${options.database}`);

  if (options.collection) {
    console.log(`📋 Initial collection: ${options.collection}`);
  }

  console.log('');

  try {
    const queryDebugger = new QueryDebugger(options);
    await queryDebugger.start();
  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : error);

    if (error instanceof Error && error.message.includes('SQLITE_CANTOPEN')) {
      console.error('');
      console.error('💡 Tip: Make sure the database file exists or specify a different path with -d');
      console.error('   Example: npx mongolite-debug -d ./path/to/your/database.db');
    }

    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
