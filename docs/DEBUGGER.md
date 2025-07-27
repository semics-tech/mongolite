# MongoLite Query Debugger

An interactive debugging tool for MongoLite queries that helps you:

1. Convert MongoDB-style find queries to SQL
2. Execute and test SQL queries directly
3. Inspect query results and debug complex searches

## Installation

The debugger is included with the `mongolite-ts` package. You can use it via npx:

```bash
npx mongolite-debug
```

## Usage

### Basic Usage

```bash
# Use with default database file (mongolite.db in current directory)
npx mongolite-debug

# Specify a specific database file
npx mongolite-debug -d ./path/to/your/database.db

# Start with a specific collection selected
npx mongolite-debug -c users

# Enable verbose output
npx mongolite-debug --verbose
```

### Command Line Options

- `-d, --database <path>` - Database file path (default: searches for common database files)
- `-c, --collection <name>` - Initial collection to use
- `-v, --verbose` - Enable verbose output
- `-h, --help` - Show help

### Interactive Commands

Once the debugger starts, you can use these commands:

- `.help` - Show available commands
- `.collections` - List all collections in the database
- `.use <collection>` - Select a collection to work with
- `.find <filter>` - Convert find filter to SQL and execute
- `.sql <query>` - Execute raw SQL query
- `.last` - Show last generated SQL query
- `.sample [count]` - Show sample documents from current collection (default: 5)
- `.exit` - Exit the debugger

## Examples

### Basic Queries

```
mongolite-debug> .use users
Switched to collection: users

mongolite-debug> .find {"age": {"$gt": 25}}

📝 Generated SQL:
Query: SELECT _id, data FROM "users" WHERE json_extract(data, '$.age') > ?
Parameters: [25]

📊 Results (3 documents):
[0] {
  "_id": "user1",
  "name": "John Doe",
  "age": 30
}
...
```

### Complex Queries

```
mongolite-debug> .find {"department": "Engineering", "skills": {"$in": ["JavaScript", "Python"]}}

📝 Generated SQL:
Query: SELECT _id, data FROM "users" WHERE (json_extract(data, '$.department') = ? OR json_extract(data, '$.department') LIKE '%' || ? || '%') AND (json_extract(data, '$.skills') = ? OR json_extract(data, '$.skills') = ?)
Parameters: ["Engineering", "Engineering", "JavaScript", "Python"]
```

### Raw SQL Queries

```
mongolite-debug> .sql SELECT _id, json_extract(data, '$.name') as name, json_extract(data, '$.department') as dept FROM users WHERE json_extract(data, '$.salary') > 80000

🔧 Executing SQL:
SELECT _id, json_extract(data, '$.name') as name, json_extract(data, '$.department') as dept FROM users WHERE json_extract(data, '$.salary') > 80000

📊 Results (4 rows):
[0] {
  "_id": "user1",
  "name": "Alice Johnson",
  "dept": "Engineering"
}
...
```

### Debugging Workflow

1. **Start the debugger**: `npx mongolite-debug -d myapp.db`
2. **List collections**: `.collections`
3. **Select a collection**: `.use users`
4. **Sample data**: `.sample 3`
5. **Test queries**: `.find {"age": {"$gte": 30}}`
6. **Review SQL**: `.last`
7. **Modify and test**: `.sql SELECT * FROM users WHERE json_extract(data, '$.age') >= 30 AND json_extract(data, '$.isActive') = 1`

## Common Use Cases

### Finding Query Performance Issues

```
# Test complex queries to see generated SQL
.find {"$and": [{"age": {"$gte": 25}}, {"department": "Engineering"}, {"skills": {"$in": ["JavaScript"]}}]}

# Compare with optimized SQL
.sql SELECT _id, data FROM users WHERE json_extract(data, '$.age') >= 25 AND json_extract(data, '$.department') = 'Engineering' AND json_extract(data, '$.skills') LIKE '%JavaScript%'
```

### Testing Array Operations

```
# Test $elemMatch queries
.find {"reviews": {"$elemMatch": {"rating": {"$gte": 4}}}}

# Test $all queries  
.find {"tags": {"$all": ["computer", "work"]}}
```

### Debugging Nested Queries

```
# Test nested object queries
.find {"address.city": "San Francisco"}

# Verify with raw SQL
.sql SELECT * FROM users WHERE json_extract(data, '$.address.city') = 'San Francisco'
```

## Tips

1. **Use `.sample`** to understand your data structure before writing complex queries
2. **Check `.last`** to see the generated SQL and understand how your queries are translated
3. **Compare performance** between MongoDB-style queries and optimized SQL
4. **Test edge cases** with raw SQL to verify behavior
5. **Use verbose mode** (`-v`) to see detailed query building information

## Troubleshooting

### Database Not Found

```
❌ Failed to connect to database: SQLITE_CANTOPEN: unable to open database file

💡 Tip: Make sure the database file exists or specify a different path with -d
   Example: npx mongolite-debug -d ./path/to/your/database.db
```

### Empty Collections

If `.collections` shows no results, your database might be empty or use different table structures. You can still test queries by creating sample data or using `.sql` to inspect the raw SQLite schema:

```
.sql SELECT name FROM sqlite_master WHERE type='table'
```
