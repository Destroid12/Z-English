// One-off recovery tool: fix Basic L7S7 + Basic L8 (1-7) that were accidentally
// overwritten with Advanced content, and move that generated content to Advanced.
//
// Usage:
//   1. Create .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example).
//   2. node restore_content.js --dry-run     (read-only, prints plan)
//   3. node restore_content.js --execute     (backs up, then applies)
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SNAPSHOT = path.join(__dirname, 'sheets', 'LessonContent.csv');
const BACKUP = path.join(__dirname, 'lesson_content_backup.json');
// The original Basic L7 S7 + L8 S1-S7 are stored chunked across columns in this
// snapshot (Google Sheets cell-size limit). r.slice(3).join('') reconstructs them.

const AFFECTED = [
  { track: 'basic', level: '7', session_number: '7' },
  ...Array.from({ length: 7 }, (_, i) => ({ track: 'basic', level: '8', session_number: String(i + 1) })),
];

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

// RFC-4180 CSV parser: handles quoted fields with embedded commas/quotes/newlines.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const exec = process.argv.includes('--execute');
  if (!dry && !exec) {
    console.error('Pass --dry-run or --execute.');
    process.exit(1);
  }

  const env = loadEnv();
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  const sb = createClient(url, key);

  // --- 1. Parse snapshot CSV, find original basic rows ---
  // NOTE: Google Sheets exports slides_json chunked across many columns
  // (cell size limit). The migrate/gs-to-supabase.js script joins chunk 4+.
  const rows = parseCSV(fs.readFileSync(SNAPSHOT, 'utf8'));
  const snap = new Map();
  for (const r of rows) {
    if (r.length < 4) continue;
    const [track, level, sn] = r;
    if (!track || !level || !sn) continue;
    const slides = r.slice(3).join('');
    snap.set(`${track}|${level}|${sn}`, slides);
  }
  console.log('Snapshot rows:', rows.length);

  const want = new Map(AFFECTED.map(a => [`${a.track}|${a.level}|${a.session_number}`, a]));
  const originals = {};
  for (const [key, a] of want) {
    if (!snap.has(key)) { console.error('MISSING original in snapshot for', key); process.exit(1); }
    originals[key] = snap.get(key);
  }

  // --- 2. Read current DB state for affected rows + their advanced counterparts ---
  const keys = [...want.keys()];
  const advancedKeys = keys.map(k => k.replace(/^basic/, 'advanced'));
  const allKeys = [...keys, ...advancedKeys];
  const { data, error } = await sb
    .from('lesson_content')
    .select('track, level, session_number, slides_json')
    .in('track', ['basic', 'advanced'])
    .in('level', ['7', '8']);
  if (error) { console.error('DB select error:', error.message); process.exit(1); }

  const cur = new Map();
  for (const r of data || []) cur.set(`${r.track}|${r.level}|${r.session_number}`, r.slides_json || '');

  const backupPayload = {};
  for (const k of allKeys) backupPayload[k] = cur.get(k) || null;

  if (!dry) {
    fs.writeFileSync(BACKUP, JSON.stringify({ savedAt: new Date().toISOString(), rows: backupPayload }, null, 2));
    console.log('Backed up current state ->', BACKUP);
  }

  // --- 3. Plan ---
  const plan = [];
  for (const k of keys) {
    const curBasic = cur.get(k) || '';
    const adv = k.replace(/^basic/, 'advanced');
    const curAdv = cur.get(adv) || '';
    plan.push({
      copy: `${k} (${curBasic.length}b) -> ${adv}`,
      advExists: curAdv.length > 0,
    });
  }
  for (const [k, original] of Object.entries(originals)) {
    const len = cur.get(k) || 0;
    plan.push({ restore: `${k}: overwrite (${len}b) with original (${original.length}b)` });
  }
  console.log('\n=== PLAN ===');
  for (const p of plan) console.log(JSON.stringify(p));

  if (dry) { console.log('\n(dry-run: nothing written)'); return; }

  // --- 4. Apply: copy current basic (generated advanced content) -> advanced ---
  for (const k of keys) {
    const slides = cur.get(k);
    if (!slides) { console.warn('skip (no current basic content):', k); continue; }
    const adv = k.replace(/^basic/, 'advanced');
    const { error: e } = await sb.from('lesson_content').upsert(
      { track: 'advanced', level: adv.split('|')[1], session_number: adv.split('|')[2], slides_json: slides, updated_at: new Date().toISOString() },
      { onConflict: 'track,level,session_number' }
    );
    if (e) { console.error('copy to advanced failed:', adv, e.message); }
    else console.log('Copied ->', adv, `(${slides.length}b)`);
    try {
      await sb.from('sessions').upsert(
        { track: 'advanced', level: adv.split('|')[1], session_number: adv.split('|')[2], link: 'lesson', updated_at: new Date().toISOString() },
        { onConflict: 'track,level,session_number' }
      );
    } catch (e2) { console.warn('sessions upsert warn:', e2.message); }
  }

  // --- 5. Apply: restore original basic from snapshot ---
  for (const [k, original] of Object.entries(originals)) {
    const [track, level, sn] = k.split('|');
    const { error: e } = await sb.from('lesson_content').upsert(
      { track, level, session_number: sn, slides_json: original, updated_at: new Date().toISOString() },
      { onConflict: 'track,level,session_number' }
    );
    if (e) { console.error('restore failed:', k, e.message); }
    else console.log('Restored ->', k, `(${original.length}b)`);
    try {
      await sb.from('sessions').upsert(
        { track, level, session_number: sn, link: 'lesson', updated_at: new Date().toISOString() },
        { onConflict: 'track,level,session_number' }
      );
    } catch (e2) { console.warn('sessions upsert warn:', e2.message); }
  }

  console.log('\nDone. Review backup file', BACKUP, 'if anything looks wrong.');
}

main().catch(e => { console.error(e); process.exit(1); });
