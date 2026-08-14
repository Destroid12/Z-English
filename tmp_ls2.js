const fs = require('fs');
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') {}
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
for (const f of ['C:/Users/ziyad/OneDrive/Desktop/lesson_content_rows.csv', 'C:/Users/ziyad/Downloads/lesson_content_rows.csv']) {
  const rows = parseCSV(fs.readFileSync(f, 'utf8'));
  console.log('=== ' + f + ' rows=' + rows.length);
  const seen = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 4) continue;
    const joined = r.slice(3).join('');
    let ok; try { JSON.parse(joined); ok = 'ok'; } catch (e) { ok = 'BAD'; }
    seen.set(r[0] + '|L' + r[1] + '|S' + r[2], r.length + ' fields, ' + joined.length + 'b ' + ok);
  }
  const keys = [...seen.keys()].sort();
  console.log(keys.map(k => k + '  ' + seen.get(k)).join('\n'));
}
