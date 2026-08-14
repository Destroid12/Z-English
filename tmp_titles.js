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
function firstTitle(slidesJson) {
  try {
    const arr = JSON.parse(slidesJson);
    const first = arr[0] || '';
    const m = first.match(/<!--EDITOR_DATA:([A-Za-z0-9+/=]+)-->/);
    if (m) {
      const obj = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      return (obj.type || '?') + ' | ' + (obj.title || '?');
    }
    return '(no editor data) ' + first.slice(0, 60);
  } catch (e) { return 'PARSE-ERR: ' + e.message; }
}

// 1. From sheets CSV (All-Original_Basic)
const rows = parseCSV(fs.readFileSync('sheets/LessonContent.csv', 'utf8'));
console.log('=== All-Original_Basic.csv (sheets) ===');
for (const [t, l, s] of [['basic','7','7'],['basic','8','1'],['basic','8','3'],['basic','8','5'],['basic','8','7']]) {
  const r = rows.find(x => x[0] === t && x[1] === l && x[2] === s);
  if (!r) { console.log(t, l, s, 'MISSING'); continue; }
  const joined = r.slice(3).join('');
  console.log(`${t} L${l} S${s} (${joined.length}b): ${firstTitle(joined)}`);
}

// 2. From Downloads/lesson_content_rows.csv (the user's export)
const dRows = parseCSV(fs.readFileSync('C:/Users/ziyad/Downloads/lesson_content_rows.csv', 'utf8'));
console.log('\n=== Downloads/lesson_content_rows.csv ===');
for (const [t, l, s] of [['basic','7','7'],['basic','8','1'],['basic','8','3'],['basic','8','5'],['basic','8','7']]) {
  const r = dRows.find(x => x[0] === t && x[1] === l && x[2] === s);
  if (!r) { console.log(t, l, s, 'MISSING'); continue; }
  const slides = r[3] || '';
  console.log(`${t} L${l} S${s} (${slides.length}b): ${firstTitle(slides)}`);
}
