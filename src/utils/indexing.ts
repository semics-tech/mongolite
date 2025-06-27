export function extractRawIndexColumns(sql) {
  const match = sql.match(/\(([\s\S]+)\)/); // allow multiline matching
  if (!match) return [];

  const colsPart = match[1];

  // Split on commas not inside parentheses
  const columns: string[] = [];
  let current = '';
  let parens = 0;

  for (let i = 0; i < colsPart.length; i++) {
    const char = colsPart[i];
    if (char === '(') parens++;
    if (char === ')') parens--;
    if (char === ',' && parens === 0) {
      columns.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) columns.push(current.trim());

  return columns.map((col) => {
    // Extract direction (ASC or DESC)
    const directionMatch = col.match(/\s+(ASC|DESC)\s*$/i);
    const direction = directionMatch ? directionMatch[1].toUpperCase() : null;

    // Remove direction from column string
    const colWithoutDirection = directionMatch
      ? col.slice(0, directionMatch.index).trim()
      : col.trim();

    // Check for json_extract and pull out path
    const jsonMatch = colWithoutDirection.match(/json_extract\s*\(\s*[^,]+,\s*'([^']+)'\s*\)/i);
    let column = jsonMatch
      ? jsonMatch[1] // the JSON path like '$.age'
      : colWithoutDirection; // fallback to raw column like testCol

    column = column.replace('$.', ''); // Remove leading $ if present
    return { column, direction };
  });
}
