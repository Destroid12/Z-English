const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
const env = loadEnv();
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data, error } = await sb
    .from('lesson_content')
    .select('track, level, session_number, slides_json')
    .in('track', ['basic', 'advanced'])
    .in('level', ['7', '8']);
  if (error) { console.error('ERR', error.message); process.exit(1); }
  console.log('DB rows returned:', (data || []).length);
  const map = {};
  for (const r of data || []) {
    const k = `${r.track}|L${r.level}|S${r.session_number}`;
    map[k] = r.slides_json || '';
  }
  const targets = [];
  for (const tr of ['basic', 'advanced']) {
    for (const lv of ['7', '8']) {
      for (let sn = 1; sn <= 7; sn++) targets.push(`${tr}|L${lv}|S${sn}`);
    }
  }
  for (const k of targets) {
    const v = map[k];
    const len = v ? v.length : 0;
    let ok = 'EMPTY';
    if (len) { try { JSON.parse(v); ok = 'valid-json'; } catch (e) { ok = 'INVALID'; } }
    console.log(`${k}: bytes=${len} ${ok}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
