# MongoLite CLI

An interactive explorer for MongoLite databases. It walks you through picking a
database file, picking a collection, and then running an operation — building
queries out of plain-English choices rather than MongoDB syntax.

```bash
npx mongolite
```

That is the whole command. Everything else is a shortcut.

## The guided flow

### 1. Pick a database

The CLI scans the current directory (two levels deep, skipping `node_modules`,
`.git`, `dist` and friends) for `.db`, `.sqlite`, `.sqlite3` and `.db3` files
and lists them newest-first with their size and when they last changed:

```
? Which database do you want to open?
  ↑/↓ move · type to filter · enter to open
❯ myapp.sqlite          412 KB · 2m ago
  fixtures/seed.db      28 KB · 3d ago
  Enter a path manually…
  Quit
```

Nothing found, or the file lives elsewhere? "Enter a path manually…" takes a
path, and `~` and `:memory:` both work.

### 2. Pick a collection

Collections are read from the database itself, with their document counts.
Tables that are not MongoLite collections (no `_id`/`data` columns) are left
out of the list — if a database has none at all, the CLI says so and offers raw
SQL instead of showing you an empty menu.

```
? Which collection?
❯ users        1,204 documents
  orders       88 documents
  Open a different database
  Quit
```

Choosing a collection samples it and infers the fields:

```
  1,204 documents · 14 fields inferred from 200 sampled
```

### 3. Pick an operation

```
? users — what would you like to do?
❯ Browse documents                    — page through everything
  Find documents                      — build a filter step by step
  Count documents                     — how many match a filter
  List the values in a field          — distinct values
  Count documents by field            — e.g. orders per status
  Show the fields in this collection
  Show indexes
  Advanced
  Write a MongoDB filter yourself     — JSON
  Run raw SQL
  Show the SQL for the last query
  Switch collection
  Open a different database
  Quit
```

## Building a query without knowing MongoDB

"Find documents" asks for one condition at a time. Fields come from the
inferred schema, with their type, how often they appear, and an example value:

```
? Which field?
❯ _id          — string, e.g. 6a743ee91b515f6582c76e4d
  age          — number, e.g. 34
  department   — string, e.g. Engineering
  isActive     — boolean, e.g. true
  joinDate     — date, e.g. 2023-01-15T00:00:00.000Z
  skills       — array of string, e.g. ["TypeScript","SQL"]
  address.city — string, e.g. London
  Type a field name myself…
```

The conditions offered next depend on the field's type — no operators that
cannot apply:

| Field type | Conditions |
|------------|------------|
| text | is · is not · contains the text · starts with · ends with · is one of · is none of · matches a regular expression |
| number | equals · does not equal · is greater than · is at least · is less than · is at most · is between · is one of |
| date | is exactly · is after · is on or after · is before · is on or before · is between |
| true/false | is true · is false |
| array | contains · contains any of · contains all of · has exactly N items |
| object | equals this JSON |
| any | has a value · is missing or empty |

When a field only holds a handful of distinct values, you pick the value from a
list instead of typing it — no guessing at spelling or capitalisation:

```
? Value
❯ Engineering
  Sales
  Marketing
  Something else…
```

Add as many conditions as you like, then choose whether documents must match
**all** of them (AND) or **any** of them (OR). Results arrive as a table, with
the filter that produced them printed above:

```
Query
  matching department is "Engineering" and age is at least 30
  filter   {"department":{"$eq":"Engineering"},"age":{"$gte":30}}
  matches  38 document(s)

# │ _id                 │ name        │ age │ department  │ isActive
──┼─────────────────────┼─────────────┼─────┼─────────────┼─────────
1 │ 6a743ee91b515f658…  │ Alice Chen  │ 34  │ Engineering │ true
```

The filter is always shown, so the MongoDB syntax is there to learn from rather
than hidden.

From the results you can page forward and back, open any document as full JSON,
change which columns are shown, save the results to a JSON file, see the SQL
that ran, or go back and change the filter.

## For people who already know MongoDB

Under **Advanced**:

- **Write a MongoDB filter yourself** — paste a filter as JSON, e.g.
  `{"age": {"$gt": 25}, "skills": {"$all": ["SQL"]}}`. Invalid JSON is reported
  rather than swallowed.
- **Run raw SQL** — query the underlying SQLite directly. Documents live in a
  `data` JSON column, so `SELECT _id, json_extract(data, '$.name') FROM users`
  is the shape you want.
- **Show the SQL for the last query** — the generated SQL and its bound
  parameters, which is what the original query debugger existed for.

## Options

```
npx mongolite                      Start the guided explorer
npx mongolite ./app.db             Open a specific database
npx mongolite ./app.db users       Open a specific collection
```

| Option | Description |
|--------|-------------|
| `-d, --database <path>` | Database file to open |
| `-c, --collection <name>` | Collection to start in |
| `--sample <n>` | Documents sampled when inferring fields (default 200) |
| `--page-size <n>` | Results per page (default 20) |
| `--repl` | Use the older command-driven debugger |
| `-v, --verbose` | Log the SQL as it is built |
| `-h, --help` | Show help |
| `-V, --version` | Show the version |

A path or collection that does not exist is not fatal — the CLI says so and
falls back to letting you pick.

## Keys

| Key | Action |
|-----|--------|
| ↑ / ↓ | Move through the list |
| any letter | Filter the list |
| Backspace | Undo a filter character |
| Enter | Choose |
| Esc | Go back a step |
| Ctrl+C | Quit |

## Non-interactive use

When stdin is not a TTY the same prompts print as numbered lists and read
answers a line at a time, so a session can be scripted or captured:

```bash
printf '1\n2\n6\n\n13\n' | npx mongolite    # open the first database, first
                                            # collection, show its fields, quit
```

Set `MONGOLITE_NON_INTERACTIVE=1` to force that mode in a real terminal, and
`NO_COLOR=1` to drop the colours.

## Read-only

The explorer reads. There is no menu path that inserts, updates or deletes
documents — a query tool that can quietly mutate the database it is exploring
is a bad trade. Raw SQL will run whatever you type, so that is the one place to
be careful.

## Troubleshooting

**"No .db/.sqlite files found in this directory."** — You are somewhere else in
the tree, or the file has an unusual extension. Choose "Enter a path
manually…".

**"This database has no MongoLite collections."** — The file opened, but no
table has the `_id`/`data` shape MongoLite writes. It is probably a SQLite
database from something else; the raw SQL option will still let you look
around.

**A field is missing from the list** — Fields are inferred from a sample
(200 documents by default). A field that only appears in rarer documents may
not be in the list; raise `--sample`, or use "Type a field name myself…".

## The older debugger

`mongolite-debug` still exists and now starts the same guided explorer. The
original command-driven REPL (`.use`, `.find`, `.sql`, `.last`, `.sample`) is
still available with `--repl`, and is documented in
[DEBUGGER.md](./DEBUGGER.md).
