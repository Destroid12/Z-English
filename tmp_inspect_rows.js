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
  console.log('\n=== ' + f + ' rows=' + rows.length);
  console.log('header:', JSON.stringify(rows[0]));
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 3) { console.log(i, 'SHORT ROW fields=', r.length); continue; }
    // In Supabase export format: track,level,session_number,slides_json,updated_at
    const track = r[0], level = r[1], sn = r[2];
    let slides = '';
    if (r.length >= 4) slides = r[3];
    let ok = 'n/a';
    try { JSON.parse(slides); ok = 'VALID'; } catch (e) { ok = 'INVALID: ' + e.message.slice(0, 40); }
    console.log(`${i}: ${track}|L${level}|S${sn} fields=${r.length} slidesBytes=${slides.length} ${ok}`);
  }
}
