// Syntax-check the serverless functions and every inline <script> in the HTML
// pages. This is the same trick the old test_script.js did, but wired into CI.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const jsFiles = ['api/backend.js', 'api/paymob.js', 'scripts/check-syntax.js'];
const htmlFiles = ['index.html', 'editor.html', 'player.html', 'agent.html'];
let failed = false;

function check(file, label) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    console.log('OK   ' + label);
  } catch (e) {
    console.error('FAIL ' + label);
    failed = true;
  }
}

for (const f of jsFiles) check(path.join(root, f), f);

for (const h of htmlFiles) {
  const html = fs.readFileSync(path.join(root, h), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  const tmp = path.join(os.tmpdir(), 'zenglish_check_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.js');
  let errors = 0;
  scripts.forEach((m, i) => {
    const code = m[1] || '';
    if (!code.trim()) return;
    fs.writeFileSync(tmp, code);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      errors++;
      const msg = String(e.stderr || '').split('\n').slice(0, 5).join('\n');
      console.error('FAIL ' + h + ' inline script #' + (i + 1) + ':\n' + msg);
    }
  });
  if (errors) failed = true;
  else console.log('OK   ' + h + ' (' + scripts.length + ' inline scripts)');
  try { fs.unlinkSync(tmp); } catch (e) {}
}

process.exit(failed ? 1 : 0);
