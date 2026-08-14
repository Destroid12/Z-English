const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
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
function firstTitle(s) {
  try {
    const a = JSON.parse(s);
    const m = (a[0] || '').match(/<!--EDITOR_DATA:([A-Za-z0-9+/=]+)-->/);
    if (m) { const o = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); return (o.type || '?') + '|' + (o.title || '?'); }
    return '(none)';
  } catch (e) { return 'ERR:' + e.message; }
}

(async () => {
  const env = loadEnv();
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const rows = parseCSV(fs.readFileSync(path.join(__dirname, 'sheets', 'LessonContent.csv'), 'utf8'));
  const r = rows.find(x => x[0] === 'basic' && x[1] === '7' && x[2] === '6');
  if (!r) { console.error('MISSING basic 7 6 in snapshot'); process.exit(1); }
  const original = r.slice(3).join('');

  const { data, error } = await sb.from('lesson_content')
    .select('track, level, session_number, slides_json')
    .in('track', ['basic', 'advanced']).eq('level', '7').eq('session_number', '6');
  if (error) { console.error(error.message); process.exit(1); }

  const cur = {};
  for (const x of data || []) cur[x.track] = x.slides_json || '';
  const backup = { savedAt: new Date().toISOString(), basic_7_6: cur.basic, advanced_7_6: cur.advanced };
  fs.writeFileSync(path.join(__dirname, 'lesson_content_backup_7_6.json'), JSON.stringify(backup, null, 2));
  console.log('backup ->', backup);

  console.log('current basic|7|6 :', cur.basic.length + 'b', firstTitle(cur.basic));
  console.log('current advanced|7|6:', (cur.advanced || '').length + 'b', firstTitle(cur.advanced || ''));
  console.log('snapshot basic|7|6 :', original.length + 'b', firstTitle(original));

  // 1. copy current basic -> advanced
  const { error: e1 } = await sb.from('lesson_content').upsert(
    { track: 'advanced', level: '7', session_number: '6', slides_json: cur.basic, updated_at: new Date().toISOString() },
    { onConflict: 'track,level,session_number' }
  );
  if (e1) { console.error('copy to advanced failed:', e1.message); process.exit(1); }
  console.log('copied basic 7 6 -> advanced 7 6');

  // 2. restore basic from snapshot
  const { error: e2 } = await sb.from('lesson_content').upsert(
    { track: 'basic', level: '7', session_number: '6', slides_json: original, updated_at: new Date().toISOString() },
    { onConflict: 'track,level,session_number' }
  );
  if (e2) { console.error('restore basic failed:', e2.message); process.exit(1); }
  console.log('restored basic 7 6 from snapshot');

  // 3. verify
  const { data: v, error: ve } = await sb.from('lesson_content')
    .select('track, level, session_number, slides_json')
    .in('track', ['basic', 'advanced']).eq('level', '7').eq('session_number', '6');
  if (ve) { console.error(ve.message); process.exit(1); }
  for (const x of v || []) console.log(x.track, '|7|6:', x.slides_json.length + 'b', firstTitle(x.slides_json || ''));
})().catch(e => { console.error(e); process.exit(1); });
