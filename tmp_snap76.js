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
const rows = parseCSV(fs.readFileSync('sheets/LessonContent.csv', 'utf8'));
const r = rows.find(x => x[0] === 'basic' && x[1] === '7' && x[2] === '6');
if (!r) { console.log('MISSING basic 7 6'); process.exit(0); }
const s = r.slice(3).join('');
console.log('basic 7 6 snapshot length:', s.length);
const a = JSON.parse(s);
const m = (a[0] || '').match(/<!--EDITOR_DATA:([A-Za-z0-9+/=]+)-->/);
if (m) {
  const o = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  console.log('first slide:', o.type, '|', o.title);
}
