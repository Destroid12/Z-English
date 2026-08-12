// Build helper: keeps agent.html's slide-compile machinery byte-identical with
// editor.html. Extracts the shared functions/consts from editor.html and injects
// them into agent.html in place of the /*__SHARED_CORE__*/ marker.
//
// Usage: node scripts/build-agent.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const editorPath = path.join(root, 'editor.html');
const agentPath = path.join(root, 'agent.html');

const src = fs.readFileSync(editorPath, 'utf8');

function skipString(text, start, quote) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

function isRegexStart(text, slashIndex) {
  let i = slashIndex - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  const prev = text[i];
  // After an identifier, number, closing bracket/paren/brace or a quote, a '/' is division.
  if (/[A-Za-z0-9_$)]}'"\`]/.test(prev)) return false;
  return true;
}

function skipRegex(text, slashIndex) {
  let i = slashIndex + 1, inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    i++;
  }
  return text.length;
}

function skipTemplate(text, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') return i + 1;
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === "'" || c === '"') { j = skipString(text, j + 1, c); continue; }
        if (c === '`') { j = skipTemplate(text, j + 1); continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return text.length;
}

function extractFunction(text, name) {
  const idx = text.indexOf('function ' + name);
  if (idx < 0) throw new Error('function not found: ' + name);
  const open = text.indexOf('{', idx);
  if (open < 0) throw new Error('no body for: ' + name);
  let depth = 0, i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') { i = skipString(text, i + 1, c); continue; }
    if (c === '`') { i = skipTemplate(text, i + 1); continue; }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(idx, i + 1); }
    i++;
  }
  throw new Error('unbalanced function: ' + name);
}

function extractConst(text, name) {
  const idx = text.indexOf('const ' + name + ' =');
  if (idx < 0) throw new Error('const not found: ' + name);
  const semi = text.indexOf(';', idx);
  return text.slice(idx, semi + 1);
}

const core = [
  'uid',
  'esc',
  'escAttr',
  'shuffleArray',
  'extractDriveFileId',
  'driveEmbedUrl',
  'normalizeMediaUrl',
  'b64EncodeUnicode',
  'b64DecodeUnicode',
  'getCustomTypes',
  'getTypeLabel',
  'compileSlide',
  'getPreviewCSS'
]
  .map(name => extractFunction(src, name))
  .join('\n\n') + '\n\n' + extractConst(src, 'ICON_PLAY') + '\n';

let agent = fs.readFileSync(agentPath, 'utf8');
agent = agent.replace('/*__SHARED_CORE__*/', core);
fs.writeFileSync(agentPath, agent, 'utf8');

console.log('OK   agent.html core updated (' + core.split('\n').length + ' lines of shared code)');
