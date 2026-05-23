// Tiny RFC 4180-ish CSV parser. Handles:
//   - quoted fields with embedded commas / newlines
//   - `""` as an escape for a literal `"` inside a quoted field
//   - CRLF or LF line endings
//   - trailing newlines (a final empty row isn't emitted)
//
// Used by the bulk-insert dialog. Not the world's most robust CSV impl —
// no comment lines, no custom delimiters yet — but covers the formats
// the user is likely to paste from a spreadsheet.

export interface ParsedCsv {
  rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush a trailing field/row that wasn't terminated by a newline. Skip
  // a completely empty trailing row (e.g. file ends with `\n`).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing rows that are entirely empty strings (some exporters
  // emit a final blank line that we shouldn't treat as a data row).
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.every((c) => c === '')
  ) {
    rows.pop();
  }
  return { rows };
}
