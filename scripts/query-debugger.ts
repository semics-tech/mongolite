#!/usr/bin/env tsx

import { MongoLite } from '../src/index.js';
import { FindCursor } from '../src/cursors/findCursor.js';
import { Filter } from '../src/types.js';
import * as readline from 'readline';
import path from 'path';

interface DebuggerOptions {
    verbose?: boolean;
    collection?: string;
    database?: string;
}

class QueryDebugger {
    private client: MongoLite;
    private rl: readline.Interface;
    private currentCollection: string | null = null;
    private lastFilter: Filter<any> | null = null;
    private lastSqlQuery: { sql: string; params: unknown[] } | null = null;

    constructor(options: DebuggerOptions = {}) {
        if (!options.database) {
            throw new Error('Database path is required. Use --database <path> to specify it.');
        }
        const dbPath = options.database;
        this.client = new MongoLite(dbPath, { verbose: options.verbose });

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'query-debugger> '
        });

        if (options.collection) {
            this.currentCollection = options.collection;
        }
    }

    async start(): Promise<void> {
        console.log('🔍 MongoLite Query Debugger');
        console.log('Commands:');
        console.log('  .help                     - Show this help');
        console.log('  .collections              - List all collections');
        console.log('  .use <collection>         - Select a collection to work with');
        console.log('  .find <filter>            - Convert find filter to SQL');
        console.log('  .sql <query>              - Execute raw SQL query');
        console.log('  .last                     - Show last generated SQL');
        console.log('  .sample [count]           - Show sample documents from current collection');
        console.log('  .exit                     - Exit the debugger');
        console.log('');

        await this.client.connect();
        console.log('Connected to database.');

        if (this.currentCollection) {
            console.log(`Current collection: ${this.currentCollection}`);
        }

        this.rl.prompt();

        this.rl.on('line', async (input: string) => {
            const trimmed = input.trim();

            if (trimmed === '.exit') {
                await this.cleanup();
                return;
            }

            try {
                await this.handleCommand(trimmed);
            } catch (error) {
                console.error('Error:', error instanceof Error ? error.message : error);
            }

            this.rl.prompt();
        });

        this.rl.on('close', async () => {
            await this.cleanup();
        });
    }

    private async handleCommand(input: string): Promise<void> {
        if (input === '.help') {
            this.showHelp();
            return;
        }

        if (input === '.collections') {
            await this.listCollections();
            return;
        }

        if (input.startsWith('.use ')) {
            const collection = input.slice(5).trim();
            this.currentCollection = collection;
            console.log(`Switched to collection: ${collection}`);
            return;
        }

        if (input.startsWith('.find ')) {
            await this.handleFindCommand(input.slice(6).trim());
            return;
        }

        if (input.startsWith('.sql ')) {
            await this.handleSqlCommand(input.slice(5).trim());
            return;
        }

        if (input === '.last') {
            this.showLastQuery();
            return;
        }

        if (input.startsWith('.sample')) {
            const parts = input.split(' ');
            const count = parts.length > 1 ? parseInt(parts[1]) || 5 : 5;
            await this.showSample(count);
            return;
        }

        console.log('Unknown command. Type .help for available commands.');
    }

    private showHelp(): void {
        console.log('');
        console.log('Available commands:');
        console.log('  .help                     - Show this help');
        console.log('  .collections              - List all collections');
        console.log('  .use <collection>         - Select a collection to work with');
        console.log('  .find <filter>            - Convert find filter to SQL and execute');
        console.log('  .sql <query>              - Execute raw SQL query');
        console.log('  .last                     - Show last generated SQL');
        console.log('  .sample [count]           - Show sample documents from current collection');
        console.log('  .exit                     - Exit the debugger');
        console.log('');
        console.log('Examples:');
        console.log('  .use users');
        console.log('  .find {"age": {"$gt": 25}}');
        console.log('  .find {"name": "John", "age": {"$in": [25, 30, 35]}}');
        console.log('  .sql SELECT * FROM users WHERE json_extract(data, "$.age") > 25');
        console.log('');
    }

    private async listCollections(): Promise<void> {
        const collections = await this.client.listCollections().toArray();
        if (collections.length === 0) {
            console.log('No collections found.');
        } else {
            console.log('Collections:');
            collections.forEach(collection => {
                const marker = collection === this.currentCollection ? ' (current)' : '';
                console.log(`  - ${collection}${marker}`);
            });
        }
    }

    private async handleFindCommand(filterStr: string): Promise<void> {
        if (!this.currentCollection) {
            console.log('No collection selected. Use .use <collection> first.');
            return;
        }

        let filter: Filter<any>;
        try {
            filter = JSON.parse(filterStr);
        } catch (error) {
            console.log('Invalid JSON filter:', error instanceof Error ? error.message : error);
            return;
        }

        this.lastFilter = filter;

        // Create a collection and a find cursor to extract the SQL
        const collection = this.client.collection(this.currentCollection);

        // We need to access the internal SQL generation. Let's create a custom cursor
        // that exposes the SQL generation logic
        const debugCursor = new DebugFindCursor(
            (collection as any).db,
            this.currentCollection,
            filter,
            { verbose: true }
        );

        this.lastSqlQuery = debugCursor.getSQL();

        console.log('');
        console.log('📝 Generated SQL:');
        console.log('Query:', this.lastSqlQuery.sql);
        console.log('Parameters:', JSON.stringify(this.lastSqlQuery.params));
        console.log('');

        // Execute the query and show results
        try {
            const results = await debugCursor.toArray();
            console.log(`📊 Results (${results.length} documents):`);
            if (results.length > 0) {
                results.forEach((doc, index) => {
                    console.log(`[${index}]`, JSON.stringify(doc, null, 2));
                });
            } else {
                console.log('No documents found.');
            }
        } catch (error) {
            console.error('Execution error:', error instanceof Error ? error.message : error);
        }
    }

    private async handleSqlCommand(sqlQuery: string): Promise<void> {
        if (!this.currentCollection) {
            console.log('No collection selected. Use .use <collection> first.');
            return;
        }

        try {
            // Get the database instance to execute raw SQL
            const db = (this.client as any).db;

            console.log('');
            console.log('🔧 Executing SQL:');
            console.log(sqlQuery);
            console.log('');

            const results = await db.all(sqlQuery);
            console.log(`📊 Results (${results.length} rows):`);

            if (results.length > 0) {
                results.forEach((row: any, index: number) => {
                    console.log(`[${index}]`, JSON.stringify(row, null, 2));
                });
            } else {
                console.log('No rows returned.');
            }
        } catch (error) {
            console.error('SQL execution error:', error instanceof Error ? error.message : error);
        }
    }

    private showLastQuery(): void {
        if (!this.lastSqlQuery) {
            console.log('No previous query to show.');
            return;
        }

        console.log('');
        console.log('📝 Last Generated SQL:');
        console.log('Query:', this.lastSqlQuery.sql);
        console.log('Parameters:', JSON.stringify(this.lastSqlQuery.params));

        if (this.lastFilter) {
            console.log('Original Filter:', JSON.stringify(this.lastFilter, null, 2));
        }
        console.log('');
    }

    private async showSample(count: number): Promise<void> {
        if (!this.currentCollection) {
            console.log('No collection selected. Use .use <collection> first.');
            return;
        }

        try {
            const collection = this.client.collection(this.currentCollection);
            const results = await collection.find({}).limit(count).toArray();

            console.log('');
            console.log(`📋 Sample documents from "${this.currentCollection}" (${results.length} of ${count} requested):`);
            if (results.length > 0) {
                results.forEach((doc, index) => {
                    console.log(`[${index}]`, JSON.stringify(doc, null, 2));
                });
            } else {
                console.log('Collection is empty.');
            }
            console.log('');
        } catch (error) {
            console.error('Error fetching sample:', error instanceof Error ? error.message : error);
        }
    }

    private async cleanup(): Promise<void> {
        console.log('\nClosing database connection...');
        await this.client.close();
        this.rl.close();
        process.exit(0);
    }
}

// Extended FindCursor that exposes SQL generation
class DebugFindCursor<T extends import('../src/types.js').DocumentWithId> extends FindCursor<T> {
    constructor(
        db: any,
        collectionName: string,
        filter: Filter<T>,
        options: { verbose?: boolean } = {}
    ) {
        super(db, collectionName, filter, options);
    }

    public getSQL(): { sql: string; params: unknown[] } {
        // Access the private queryParts property
        return (this as any).queryParts;
    }
}

// CLI argument parsing
function parseArgs(): DebuggerOptions {
    const args = process.argv.slice(2);
    const options: DebuggerOptions = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--verbose' || arg === '-v') {
            options.verbose = true;
        } else if (arg === '--collection' || arg === '-c') {
            options.collection = args[++i];
        } else if (arg === '--database' || arg === '-d') {
            options.database = args[++i];
        } else if (arg === '--help' || arg === '-h') {
            console.log('MongoLite Query Debugger');
            console.log('');
            console.log('Usage: tsx scripts/query-debugger.ts [options]');
            console.log('');
            console.log('Options:');
            console.log('  -d, --database <path>     Database file path (default: debug.sqlite)');
            console.log('  -c, --collection <name>   Initial collection to use');
            console.log('  -v, --verbose             Enable verbose output');
            console.log('  -h, --help                Show this help');
            console.log('');
            process.exit(0);
        }
    }

    return options;
}

// Main execution
async function main() {
    const options = parseArgs();
    const queryDebugger = new QueryDebugger(options);
    await queryDebugger.start();
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

export { QueryDebugger };
