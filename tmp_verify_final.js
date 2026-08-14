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
function firstTitle(slidesJson) {
  try {
    const arr = JSON.parse(slidesJson);
    const first = arr[0] || '';
    const m = first.match(/<!--EDITOR_DATA:([A-Za-z0-9+/=]+)-->/);
    if (m) {
      const obj = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      return (obj.type || '?') + ' | ' + (obj.title || '?');
    }
    return '(no editor data)';
  } catch (e) { return 'PARSE-ERR: ' + e.message; }
}

(async () => {
  const env = loadEnv();
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const rows = ['basic|7|6','basic|7|7','basic|8|1','basic|8|7','advanced|7|7','advanced|8|1','advanced|8|7'];
  const { data, error } = await sb.from('lesson_content')
    .select('track, level, session_number, slides_json')
    .in('track', ['basic','advanced']).in('level', ['7','8']);
  if (error) { console.error(error.message); process.exit(1); }
  const map = {};
  for (const r of data || []) map[`${r.track}|${r.level}|${r.session_number}`] = r.slides_json || '';
  for (const k of rows) {
    const v = map[k];
    console.log(k, v ? `(${v.length}b) ${firstTitle(v)}` : '(MISSING)');
  }
})();
