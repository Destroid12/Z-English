const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;      // 12 hours — login session
const LESSON_TOKEN_LIFETIME_MS = 3 * 60 * 1000;       // 3 minutes — lesson access token
const CONTACT_DESTINATION_EMAIL = 'owiseahmedghareb@gmail.com';
const MEDIA_FOLDER_NAME = 'ZEnglishMedia';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB practical ceiling for base64 POSTs via Apps Script

// --- In-session AI tutor settings ---
const TUTOR_SESSION_LIFETIME_MS = 3 * 60 * 60 * 1000; // 3 hours — long enough for one class
const TUTOR_MAX_MESSAGES = 50;        // per lesson-session cap, enforced server-side
const TUTOR_MAX_QUESTION_CHARS = 800;
const TUTOR_MAX_SLIDE_CONTEXT_CHARS = 1500;   // "currently viewing" slide snippet sent by the client
const TUTOR_MAX_SESSION_CONTEXT_CHARS = 12000; // full session material, built server-side
const TUTOR_MAX_HISTORY_TURNS = 6;
const TUTOR_MODEL = 'gemini-3.1-flash-lite'; // fast/cheap; swap to 'gemini-3.5-flash' for stronger explanations
const SITE_TUTOR_MAX_QUESTION_CHARS = 800;
const SITE_TUTOR_MAX_CONTEXT_CHARS = 600000;
const SITE_TUTOR_MAX_HISTORY_TURNS = 8;

function _sheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function _sha256(text) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return raw.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function _randomSalt() { return Utilities.getUuid(); }
function _hashPassword(password, salt) { return _sha256(salt + ':' + password); }

// --- Users sheet helpers ---

function _findUserRow(identifier) {
  const sheet = _sheet('Users');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === String(identifier).toLowerCase()) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function _userFromRow(row) {
  return { id: row[0], name: row[1], role: row[4], gender: row[5] };
}

function _issueSession(rowIndex) {
  const token = Utilities.getUuid();
  const tokenHash = _sha256(token);
  const expiry = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
  const sheet = _sheet('Users');
  sheet.getRange(rowIndex, 7).setValue(tokenHash);
  sheet.getRange(rowIndex, 8).setValue(expiry);
  return token;
}

function _validateSession(token) {
  if (!token) return null;
  const tokenHash = _sha256(token);
  const sheet = _sheet('Users');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][6] === tokenHash) {
      const expiry = new Date(data[i][7]);
      if (expiry.getTime() < Date.now()) return { expired: true };
      return { user: _userFromRow(data[i]), rowIndex: i + 1 };
    }
  }
  return null;
}

function _requireAdminSession(token) {
  const session = _validateSession(token);
  if (!session || session.expired) return { error: _json({ success: false, expired: true, message: 'Session expired.' }) };
  if (session.user.role !== 'admin') return { error: _json({ success: false, message: 'Admin access required.' }) };
  return { session };
}

// --- Router ---

function doPost(e) {
  const action = e.parameter.action;
  try {
    if (action === 'login') return _login(e);
    if (action === 'googleLogin') return _googleLogin(e);
    if (action === 'createStudent') return _createStudent(e);
    if (action === 'setSessionContent') return _setSessionContent(e);
    if (action === 'unlockSession') return _unlockSession(e);
    if (action === 'createPost') return _createPost(e);
    if (action === 'contactMessage') return _contactMessage(e);
    if (action === 'setLessonContent') return _setLessonContent(e);
    if (action === 'getPreviewToken') return _getPreviewToken(e);
    if (action === 'uploadMedia') return _uploadMedia(e);
    if (action === 'askTutor') return _askTutor(e);
    if (action === 'createCategory') return _createCategory(e);
    if (action === 'deleteCategory') return _deleteCategory(e);
    if (action === 'createCustomSession') return _createCustomSession(e);
    if (action === 'deleteCustomSession') return _deleteCustomSession(e);
    if (action === 'unlockCustomSession') return _unlockCustomSession(e);
    if (action === 'toggleLike') return _toggleLike(e);
    if (action === 'createComment') return _createComment(e);
    if (action === 'deleteComment') return _deleteComment(e);
    if (action === 'askSiteTutor') return _askSiteTutor(e);
    return _json({ success: false, message: 'Unknown action' });
  } catch (err) {
    return _json({ success: false, message: 'Server error: ' + err.message });
  }
}

function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'getPosts') return _getPosts(e);
    if (action === 'listStudents') return _listStudents(e);
    if (action === 'listSessions') return _listSessions(e);
    if (action === 'getLessonContent') return _getLessonContent(e);
    if (action === 'getLessonContentForEdit') return _getLessonContentForEdit(e);
    if (action === 'listLessonContentSessions') return _listLessonContentSessions(e); // <-- add this line
    if (action === 'listCategories') return _listCategories(e);
    if (action === 'listCustomSessions') return _listCustomSessions(e);
    if (action === 'getComments') return _getComments(e);
    return _json({ success: false, message: 'Unknown action' });
  } catch (err) {
    return _json({ success: false, message: 'Server error: ' + err.message });
  }
}

// --- Auth actions ---

function _login(e) {
  const identifier = (e.parameter.email || '').trim().toLowerCase();
  const password = e.parameter.password || '';

  const found = _findUserRow(identifier);
  if (!found) return _json({ success: false, message: 'Incorrect ID/email or password.' });

  const [ , name, storedHash, salt, role, gender, , , provider ] = found.row;
  if (provider === 'google') {
    return _json({ success: false, message: 'This admin account uses Google Sign-In. Use the Google button instead.' });
  }
  const hash = _hashPassword(password, salt);
  if (hash !== storedHash) return _json({ success: false, message: 'Incorrect ID/email or password.' });

  const token = _issueSession(found.rowIndex);
  return _json({ success: true, user: { id: identifier, name, role, gender }, sessionToken: token });
}

function _googleLogin(e) {
  const idToken = e.parameter.idToken;
  if (!idToken) return _json({ success: false, message: 'Missing Google credential.' });

  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return _json({ success: false, message: 'Google sign-in could not be verified.' });

  const payload = JSON.parse(resp.getContentText());
  const email = (payload.email || '').toLowerCase();
  if (!email) return _json({ success: false, message: 'Google account has no email.' });

  const found = _findUserRow(email);
  if (!found) {
    return _json({ success: false, message: 'No admin account is registered for this Google email.' });
  }
  const role = found.row[4];
  if (role !== 'admin') {
    return _json({ success: false, message: 'Students must sign in with their Student ID and password, not Google.' });
  }

  const token = _issueSession(found.rowIndex);
  const user = _userFromRow(found.row);
  user.name = payload.name || user.name;
  return _json({ success: true, user, sessionToken: token });
}

// --- Admin: manage student accounts ---

function _createStudent(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const studentId = (e.parameter.studentId || '').trim();
  const name = (e.parameter.name || '').trim();
  const password = e.parameter.password || '';
  const gender = e.parameter.gender === 'female' ? 'female' : 'male';

  if (!studentId || !name || !password) return _json({ success: false, message: 'Missing required fields.' });
  if (password.length < 6) return _json({ success: false, message: 'Password must be at least 6 characters.' });
  if (_findUserRow(studentId)) return _json({ success: false, message: 'That student ID is already in use.' });

  const salt = _randomSalt();
  const hash = _hashPassword(password, salt);
  _sheet('Users').appendRow([studentId, name, hash, salt, 'student', gender, '', '', 'password']);

  return _json({ success: true });
}

function _listStudents(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const data = _sheet('Users').getDataRange().getValues();
  const students = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][4] === 'student') {
      students.push({ id: data[i][0], name: data[i][1], gender: data[i][5] });
    }
  }
  return _json({ success: true, students });
}

// --- Admin: manage curriculum sessions ---

function _findSessionRow(track, level, sessionNumber) {
  const sheet = _sheet('Sessions');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(track) && String(data[i][1]) === String(level) && String(data[i][2]) === String(sessionNumber)) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function _setSessionContent(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const track = e.parameter.track;
  const level = e.parameter.level;
  const sessionNumber = e.parameter.sessionNumber;
  const password = e.parameter.password || '';
  const link = (e.parameter.link || '').trim();

  if (track !== 'basic' && track !== 'advanced') return _json({ success: false, message: 'Invalid track.' });
  if (!level || !sessionNumber || !password || !link) return _json({ success: false, message: 'Missing required fields.' });

  const salt = _randomSalt();
  const hash = _hashPassword(password, salt);
  const now = new Date().toISOString();

  const existing = _findSessionRow(track, level, sessionNumber);
  const sheet = _sheet('Sessions');
  if (existing) {
    sheet.getRange(existing.rowIndex, 4, 1, 4).setValues([[hash, salt, link, now]]);
  } else {
    sheet.appendRow([track, level, sessionNumber, hash, salt, link, now]);
  }

  return _json({ success: true });
}

function _listSessions(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const data = _sheet('Sessions').getDataRange().getValues();
  const sessions = [];
  for (let i = 1; i < data.length; i++) {
    sessions.push({ track: data[i][0], level: data[i][1], sessionNumber: data[i][2], link: data[i][5] });
  }
  return _json({ success: true, sessions });
}

// --- Admin: seed lesson content (JSON array of compiled slide HTML strings) ---
function _setLessonContent(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const track = e.parameter.track;
  const level = e.parameter.level;
  const sessionNumber = e.parameter.sessionNumber;
  const slidesJson = e.parameter.slidesJson || '';

  if (!track || !level || !sessionNumber || !slidesJson) return _json({ success: false, message: 'Missing required fields.' });
  try { JSON.parse(slidesJson); } catch (err) { return _json({ success: false, message: 'slidesJson is not valid JSON.' }); }

  const sheet = _sheet('LessonContent');
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(track) && String(data[i][1]) === String(level) && String(data[i][2]) === String(sessionNumber)) {
      rowIndex = i + 1; break;
    }
  }
  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 4).setValue(slidesJson);
  } else {
    sheet.appendRow([track, level, sessionNumber, slidesJson]);
  }
  return _json({ success: true });
}

// --- Admin: fetch raw slide JSON for editing (separate from the public player endpoint) ---
function _getLessonContentForEdit(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const track = (e.parameter.track || '').trim().toLowerCase();
  const level = (e.parameter.level || '').trim();
  const sessionNumber = (e.parameter.sessionNumber || '').trim();
  if (!track || !level || !sessionNumber) return _json({ success: false, message: 'Missing required fields.' });

  return _fetchDirectLessonContent(track, level, sessionNumber);
}

// --- Admin: upload an image to Drive, return a viewable URL ---
function _uploadMedia(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const filename = (e.parameter.filename || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
  const mimeType = e.parameter.mimeType || 'application/octet-stream';
  const dataBase64 = e.parameter.dataBase64 || '';

  if (!dataBase64) return _json({ success: false, message: 'No file data received.' });

  const allowedPrefixes = ['image/', 'audio/', 'video/'];
  if (!allowedPrefixes.some(p => mimeType.startsWith(p))) {
    return _json({ success: false, message: 'Only image, audio, or video uploads are supported.' });
  }

  // Audio/video files run much bigger than images — allow more headroom for
  // those specifically, while keeping images capped tight since they're
  // meant to be lightweight.
  const isMedia = mimeType.startsWith('audio/') || mimeType.startsWith('video/');
  const ceiling = isMedia ? MAX_UPLOAD_BYTES * 8 : MAX_UPLOAD_BYTES; // ~64MB for audio/video, 8MB for images
  if (dataBase64.length > ceiling * 1.4) {
    return _json({ success: false, message: isMedia
      ? 'File is too large. Please keep audio/video under ' + Math.round(ceiling / 1024 / 1024) + 'MB.'
      : 'File is too large. Please keep images under 8MB.' });
  }

  try {
    const bytes = Utilities.base64Decode(dataBase64);
    const blob = Utilities.newBlob(bytes, mimeType, filename);
    const folder = _getOrCreateMediaFolder();
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    // Drive's uc?export=view endpoint works for images but is unreliable for
    // streamed audio/video (wrong content-type, no range requests → seeking
    // breaks). Use the direct download host for those instead.
    const url = isMedia
      ? 'https://drive.google.com/uc?export=download&id=' + file.getId()
      : 'https://drive.google.com/uc?export=view&id=' + file.getId();
    return _json({ success: true, url: url, fileId: file.getId() });
  } catch (err) {
    return _json({ success: false, message: 'Upload failed: ' + err.message });
  }
}

function _listLessonContentSessions(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const data = _sheet('LessonContent').getDataRange().getValues();
  const sessions = [];
  for (let i = 1; i < data.length; i++) {
    const track = data[i][0], level = data[i][1], sessionNumber = data[i][2];
    const slidesJson = data[i][3] || '';
    if (!track || !level || !sessionNumber) continue;
    sessions.push({ track, level, sessionNumber, sizeBytes: String(slidesJson).length });
  }
  return _json({ success: true, sessions });
}

function _getOrCreateMediaFolder() {
  const existing = DriveApp.getFoldersByName(MEDIA_FOLDER_NAME);
  if (existing.hasNext()) return existing.next();
  return DriveApp.createFolder(MEDIA_FOLDER_NAME);
}

// --- Admin: mint a short-lived, single-lesson preview token (does NOT carry admin privileges) ---
function _getPreviewToken(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const track = e.parameter.track;
  const level = e.parameter.level;
  const sessionNumber = e.parameter.sessionNumber;
  if (!track || !level || !sessionNumber) return _json({ success: false, message: 'Missing fields.' });

  const accessToken = Utilities.getUuid();
  const tokenHash = _sha256(accessToken);
  const expiresAt = new Date(Date.now() + LESSON_TOKEN_LIFETIME_MS).toISOString();

  _sheet('LessonAccess').appendRow([tokenHash, track, level, sessionNumber, expiresAt, 'false', 'true']);
  SpreadsheetApp.flush();

  return _json({ success: true, accessToken: accessToken });
}

// --- Student: unlock a session ---
function _unlockSession(e) {
  const session = _validateSession(e.parameter.token);
  if (!session || session.expired) return _json({ success: false, expired: true, message: 'Session expired.' });

  const track = e.parameter.track;
  const level = e.parameter.level;
  const sessionNumber = e.parameter.sessionNumber;
  const password = e.parameter.password || '';

  const found = _findSessionRow(track, level, sessionNumber);
  if (!found) return _json({ success: false, message: 'This session has not been set up yet.' });

  const [ , , , storedHash, salt ] = found.row;
  const hash = _hashPassword(password, salt);
  if (hash !== storedHash) return _json({ success: false, message: 'Incorrect password.' });

  const accessToken = Utilities.getUuid();
  const tokenHash = _sha256(accessToken);
  const expiresAt = new Date(Date.now() + LESSON_TOKEN_LIFETIME_MS).toISOString();

  _sheet('LessonAccess').appendRow([tokenHash, track, level, sessionNumber, expiresAt, 'false', 'false']);

  // Force Google Sheets to instantly save the row before returning control
  SpreadsheetApp.flush();

  return _json({ success: true, link: found.row[5], accessToken: accessToken });
}

// --- Internal Helper: Fetch Raw JSON directly (Bypass tokens) ---
function _fetchDirectLessonContent(track, level, sessionNumber, tutorToken) {
  const contentSheet = _sheet('LessonContent');
  const contentData = contentSheet.getDataRange().getValues();
  let slidesJson = null;

  for (let i = 1; i < contentData.length; i++) {
    if (String(contentData[i][0]).trim().toLowerCase() === track &&
        String(contentData[i][1]).trim() === level &&
        String(contentData[i][2]).trim() === sessionNumber) {
      slidesJson = contentData[i][3];
      break;
    }
  }
  if (!slidesJson) {
    return _json({ success: false, message: 'Lesson content has not been uploaded yet. Contact your administrator.' });
  }

  const resp = { success: true, slides: JSON.parse(slidesJson) };
  if (tutorToken) resp.tutorToken = tutorToken;
  return _json(resp);
}

// --- In-session tutor: issue/validate a token scoped to one track/level/session ---
function _issueTutorToken(track, level, sessionNumber) {
  const token = Utilities.getUuid();
  const tokenHash = _sha256(token);
  const expiresAt = new Date(Date.now() + TUTOR_SESSION_LIFETIME_MS).toISOString();
  _sheet('TutorSessions').appendRow([tokenHash, track, level, sessionNumber, expiresAt, 0]);
  return token;
}

function _validateTutorToken(token, track, level, sessionNumber) {
  if (!token) return null;
  const tokenHash = _sha256(token);
  const sheet = _sheet('TutorSessions');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === tokenHash) {
      if (String(data[i][1]).toLowerCase() !== String(track).toLowerCase()) return null;
      if (String(data[i][2]) !== String(level)) return null;
      if (String(data[i][3]) !== String(sessionNumber)) return null;
      const expiresAt = new Date(data[i][4]);
      if (expiresAt.getTime() < Date.now()) return { expired: true };
      return { rowIndex: i + 1, messageCount: Number(data[i][5]) || 0 };
    }
  }
  return null;
}

function _getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

// --- Strip HTML down to plain readable text, for feeding slide content to the tutor model ---
function _stripHtmlToText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Build a plain-text digest of every slide in a session, so the tutor can quiz on the whole lesson ---
function _getSessionContextText(track, level, sessionNumber) {
  const contentSheet = _sheet('LessonContent');
  const contentData = contentSheet.getDataRange().getValues();
  for (let i = 1; i < contentData.length; i++) {
    if (String(contentData[i][0]).trim().toLowerCase() === String(track).trim().toLowerCase() &&
        String(contentData[i][1]).trim() === String(level).trim() &&
        String(contentData[i][2]).trim() === String(sessionNumber).trim()) {
      let slides;
      try { slides = JSON.parse(contentData[i][3]); } catch (err) { return ''; }
      if (!Array.isArray(slides)) return '';
      let out = '';
      for (let idx = 0; idx < slides.length; idx++) {
        const text = _stripHtmlToText(slides[idx]);
        if (!text) continue;
        const piece = 'Slide ' + (idx + 1) + ': ' + text + '\n\n';
        if ((out.length + piece.length) > TUTOR_MAX_SESSION_CONTEXT_CHARS) break;
        out += piece;
      }
      return out.trim();
    }
  }
  return '';
}

// --- In-session tutor: answer a student's question about the current slide / session ---
// Builds a digest across every track/level/session that has content, so the
// site tutor can answer about anything in the curriculum, not just one lesson.
function _getAllSessionsContextText() {
  const data = _sheet('LessonContent').getDataRange().getValues();
  let out = '';
  for (let i = 1; i < data.length; i++) {
    const track = data[i][0], level = data[i][1], sessionNumber = data[i][2], slidesJson = data[i][3];
    if (!track || !level || !sessionNumber || !slidesJson) continue;
    let slides;
    try { slides = JSON.parse(slidesJson); } catch (err) { continue; }
    if (!Array.isArray(slides)) continue;

    let header = '\n=== ' + track + ' Level ' + level + ' Session ' + sessionNumber + ' ===\n';
    let body = '';
    for (let idx = 0; idx < slides.length; idx++) {
      const text = _stripHtmlToText(slides[idx]);
      if (text) body += 'Slide ' + (idx + 1) + ': ' + text + '\n';
    }
    if (!body) continue;
    if ((out.length + header.length + body.length) > SITE_TUTOR_MAX_CONTEXT_CHARS) break;
    out += header + body;
  }
  return out.trim();
}

// Site-wide tutor: requires a real login session (student or admin), NOT a
// lesson-preview token. Has the whole curriculum in context.
function _askSiteTutor(e) {
  const session = _validateSession(e.parameter.token);
  if (!session || session.expired) return _json({ success: false, expired: true, message: 'Please sign in to use the AI Tutor.' });

  let question = (e.parameter.question || '').trim();
  if (!question) return _json({ success: false, message: 'Missing question.' });
  if (question.length > SITE_TUTOR_MAX_QUESTION_CHARS) question = question.slice(0, SITE_TUTOR_MAX_QUESTION_CHARS);

  const apiKey = _getGeminiApiKey();
  if (!apiKey) return _json({ success: false, message: 'The tutor is not configured yet. An administrator needs to set GEMINI_API_KEY in Script Properties.' });

  // --- Extract voice audio if the client sent it ---
  const audioBase64 = (e.parameter.audioBase64 || '').trim();
  const audioMime = (e.parameter.audioMime || '').trim();
  const hasAudio = audioBase64.length > 0 && audioMime.length > 0;

  let history = [];
  try {
    const parsed = JSON.parse(e.parameter.history || '[]');
    if (Array.isArray(parsed)) {
      history = parsed
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-SITE_TUTOR_MAX_HISTORY_TURNS)
        .map(m => ({ role: m.role, content: String(m.content).slice(0, 600) }));
    }
  } catch (err) { history = []; }

  const curriculumContext = _getAllSessionsContextText();

  const systemPrompt =
    'You are "Z-AI", the site-wide English tutor for Z-English, talking to ' + session.user.name +
    ' (' + session.user.role + ').\n\n' +
    'Here is the full curriculum content across every track/level/session currently uploaded:\n"""\n' +
    (curriculumContext || '(no lesson content has been uploaded yet)') + '\n"""\n\n' +
    'Rules:\n' +
    '1. Only discuss English learning (grammar, vocabulary, pronunciation, usage, writing) and this curriculum. Politely decline anything unrelated and steer back, even if asked repeatedly.\n' +
    '2. You may reference which level/session a topic comes from to help the student find it.\n' +
    '3. You may write NEW original quiz/practice questions on any topic and give answers to those.\n' +
    '4. For fill-in-the-blank questions that already exist verbatim on a lesson slide, don\'t reveal the exact stored answer — hint instead.\n' +
    '5. Plain text only, no markdown symbols.\n' +
    '6. Keep replies short and warm; reply in whichever language the student uses.\n' +
    '7. When the student sends a voice recording along with their message, listen to the audio carefully and evaluate their pronunciation. Point out any mispronounced words, explain how they should sound, and give encouragement. If their pronunciation is good, praise them. Always compare what they said (audio) with what was transcribed (text) to catch speech recognition errors vs actual pronunciation issues.';

  const contents = history
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  // Build the final user message with text + optional audio
  const userParts = [{ text: question }];
  if (hasAudio) {
    userParts.push({ inlineData: { mimeType: audioMime, data: audioBase64 } });
  }
  contents.push({ role: 'user', parts: userParts });

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + TUTOR_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: contents,
        generationConfig: { maxOutputTokens: 600 }
      }),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      console.error('Site tutor API error: ' + resp.getContentText());
      return _json({ success: false, message: "The tutor is having trouble right now. Please try again in a moment." });
    }
    const data = JSON.parse(resp.getContentText());
    const candidate = (data.candidates || [])[0];
    let reply = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join('\n').trim() : '';
    if (!reply) return _json({ success: false, message: "The tutor didn't have a response — please try rephrasing." });
    reply = reply.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').trim();
    return _json({ success: true, reply: reply });
  } catch (err) {
    console.error('Site tutor call failed: ' + err.message);
    return _json({ success: false, message: "Couldn't reach the tutor. Please try again." });
  }
}

function _askTutor(e) {
  const track = (e.parameter.track || '').trim().toLowerCase();
  const level = (e.parameter.level || '').trim();
  const sessionNumber = (e.parameter.sessionNumber || '').trim();
  const tutorToken = (e.parameter.tutorToken || '').trim();
  const slideIndex = (e.parameter.slideIndex || '').trim();
  let question = (e.parameter.question || '').trim();
  let slideContext = (e.parameter.slideContext || '').trim();
  let historyRaw = e.parameter.history || '[]';

  if (!track || !level || !sessionNumber || !tutorToken || !question) {
    return _json({ success: false, message: 'Missing required fields.' });
  }

  const tokenState = _validateTutorToken(tutorToken, track, level, sessionNumber);
  if (!tokenState) return _json({ success: false, message: 'Invalid tutor session. Please reopen this lesson from the dashboard.' });
  if (tokenState.expired) return _json({ success: false, message: 'This tutor session has expired. Please reopen the lesson from the dashboard.' });
  if (tokenState.messageCount >= TUTOR_MAX_MESSAGES) {
    return _json({ success: false, message: "You've reached the question limit for this lesson session. Please ask your instructor, or reopen the lesson to start a fresh session." });
  }

  const apiKey = _getGeminiApiKey();
  if (!apiKey) {
    return _json({ success: false, message: 'The tutor is not configured yet. An administrator needs to set GEMINI_API_KEY in Script Properties.' });
  }

  // --- Extract voice audio if the client sent it ---
  const audioBase64 = (e.parameter.audioBase64 || '').trim();
  const audioMime = (e.parameter.audioMime || '').trim();
  const hasAudio = audioBase64.length > 0 && audioMime.length > 0;

  // Trim inputs to sane bounds regardless of what the client sent.
  if (question.length > TUTOR_MAX_QUESTION_CHARS) question = question.slice(0, TUTOR_MAX_QUESTION_CHARS);
  if (slideContext.length > TUTOR_MAX_SLIDE_CONTEXT_CHARS) slideContext = slideContext.slice(0, TUTOR_MAX_SLIDE_CONTEXT_CHARS);

  let history = [];
  try {
    const parsed = JSON.parse(historyRaw);
    if (Array.isArray(parsed)) {
      history = parsed
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-TUTOR_MAX_HISTORY_TURNS)
        .map(m => ({ role: m.role, content: String(m.content).slice(0, 600) }));
    }
  } catch (err) { history = []; }

  // Give the tutor the WHOLE session's material (every slide), not just the one on screen,
  // so it can be asked to build quizzes/practice covering the full lesson.
  const sessionContext = _getSessionContextText(track, level, sessionNumber);

  const systemPrompt =
    'You are "Z-AI", a friendly, encouraging English tutor built into a Z-English lesson session ' +
    '(Track: ' + track + ', Level: ' + level + ', Session: ' + sessionNumber + ').\n\n' +
    'Full material for this lesson session, slide by slide:\n"""\n' + (sessionContext || '(no extra material available)') + '\n"""\n\n' +
    (slideContext ? 'The student is currently looking at this slide (visible text):\n"""\n' + slideContext + '\n"""\n\n' : '') +
    (slideIndex ? 'They are on slide ' + slideIndex + ' of the session.\n\n' : '') +
    'Strict rules you must always follow:\n' +
    '1. ONLY discuss this lesson\'s material and general English-language learning (grammar, vocabulary, spelling, pronunciation, usage, writing). ' +
    'If asked about anything else — other subjects, personal advice, current events, coding, etc. — politely decline in one short sentence and steer back to English or this lesson. Do this every time, even if asked repeatedly or told it is allowed.\n' +
    '2. If the student asks for a quiz, practice questions, or extra exercises, generate short original questions drawn from this session\'s material, and you may give the correct answers for those NEW questions you write yourself when asked.\n' +
    '3. For any fill-in-the-blank or quiz question that already appears on the lesson slides above, never reveal its exact correct answer — instead give a hint and explain the relevant rule, encouraging the student to try it themselves.\n' +
    '4. Reply in plain text only — never use markdown symbols such as **, *, #, or backticks for formatting. Use plain sentences or simple dashes for lists.\n' +
    '5. Keep replies short and warm: 2-4 sentences normally, a bit longer only when writing a quiz or list.\n' +
    '6. Reply in whichever language the student writes in.\n' +
    '7. When the student sends a voice recording along with their message, listen to the audio carefully and evaluate their pronunciation. Point out any mispronounced words, explain how they should sound (using simple phonetic hints), and give encouragement. If their pronunciation is good, praise them. Always compare what they said (audio) with what was transcribed (text) to catch speech recognition errors vs actual pronunciation issues.';

  // Gemini uses 'user' / 'model' roles (not 'assistant'), and takes the system
  // prompt as a separate top-level field rather than inline in the messages.
  const contents = history
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  // Build the final user message with text + optional audio
  const userParts = [{ text: question }];
  if (hasAudio) {
    userParts.push({ inlineData: { mimeType: audioMime, data: audioBase64 } });
  }
  contents.push({ role: 'user', parts: userParts });

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + TUTOR_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: contents,
        generationConfig: { maxOutputTokens: 500 }
      }),
      muteHttpExceptions: true
    });

    // Count this attempt against the cap regardless of outcome, so retries can't be used to dodge the limit.
    _sheet('TutorSessions').getRange(tokenState.rowIndex, 6).setValue(tokenState.messageCount + 1);

    if (resp.getResponseCode() !== 200) {
      console.error('Tutor API error: ' + resp.getContentText());
      return _json({ success: false, message: "The tutor is having trouble right now. Please try again in a moment." });
    }

    const data = JSON.parse(resp.getContentText());
    const candidate = (data.candidates || [])[0];
    let reply = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join('\n').trim()
      : '';

    if (!reply) return _json({ success: false, message: "The tutor didn't have a response — please try rephrasing your question." });

    // Defensive cleanup in case the model still emits markdown bold/heading markers.
    reply = reply.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').trim();

    return _json({ success: true, reply: reply });
  } catch (err) {
    console.error('Tutor call failed: ' + err.message);
    return _json({ success: false, message: "Couldn't reach the tutor. Please try again." });
  }
}


// --- Player page: redeem the token AND fetch real slide content ---
function _getLessonContent(e) {
  const track = (e.parameter.track || '').trim().toLowerCase();
  const level = (e.parameter.level || '').trim();
  const sessionNumber = (e.parameter.sessionNumber || '').trim();
  const accessToken = (e.parameter.lt || '').trim();

  if (!track || !level || !sessionNumber || !accessToken) {
    return _json({ success: false, message: 'Missing access token. Please open this lesson from the Z-English dashboard.' });
  }

  // --- ONE-TIME / SHORT-LIVED TOKEN LOGIC ---
  // Covers both student unlock tokens and admin preview tokens minted via
  // _getPreviewToken — neither ever carries full admin API privileges.
  const tokenHash = _sha256(accessToken);
  const sheet = _sheet('LessonAccess');
  const data = sheet.getDataRange().getValues();
  let matchRow = -1;

  for (let i = 1; i < data.length; i++) {
    const sheetToken  = String(data[i][0]).trim();
    const sheetTrack  = String(data[i][1]).trim().toLowerCase();
    const sheetLevel  = String(data[i][2]).trim();
    const sheetSesNum = String(data[i][3]).trim();

    if (sheetToken === tokenHash && sheetTrack === track && sheetLevel === level && sheetSesNum === sessionNumber) {
      matchRow = i;
      break;
    }
  }

  if (matchRow === -1) {
    return _json({ success: false, message: 'Invalid access link. Please open this lesson from the Z-English dashboard.' });
  }

  const row = data[matchRow];
  const expiresAt = new Date(row[4]);
  const used = String(row[5]).toLowerCase() === 'true';
  const isAdminPreview = row[6] && String(row[6]).toLowerCase() === 'true';

  if (used && !isAdminPreview) {
    return _json({ success: false, message: 'This link has already been used. Please open the lesson again from the dashboard.' });
  }
  if (expiresAt.getTime() < Date.now()) {
    return _json({ success: false, message: 'This link has expired. Please open the lesson again from the dashboard.' });
  }

  if (!isAdminPreview) {
    // Burn the token immediately — single use for students.
    sheet.getRange(matchRow + 1, 6).setValue('true');
    SpreadsheetApp.flush();
  }

  const tutorToken = _issueTutorToken(track, level, sessionNumber);
  return _fetchDirectLessonContent(track, level, sessionNumber, tutorToken);
}


// --- Posts ---

function _createPost(e) {
  const session = _validateSession(e.parameter.token);
  if (!session || session.expired) return _json({ success: false, expired: true, message: 'Session expired. Please log in again.' });

  const content = (e.parameter.content || '').trim();
  if (!content) return _json({ success: false, message: 'Post content is empty.' });

  const postsSheet = _sheet('Posts');
  const newId = Utilities.getUuid();
  const date = new Date().toISOString();

  postsSheet.appendRow([newId, session.user.name, session.user.role, session.user.gender, content, 'false', date]);
  return _json({ success: true, id: newId });
}

function _getPosts(e) {
  const session = _validateSession(e.parameter.token);
  if (e.parameter.token && (!session || session.expired)) return _json({ success: false, expired: true });

  const data = _sheet('Posts').getDataRange().getValues();
  const headers = data.shift();
  let posts = data.map(row => ({
    id: row[0], author: row[1], role: row[2], gender: row[3],
    content: row[4], isPinned: row[5] === 'true' || row[5] === true, date: row[6]
  }));

  // Server-side gender filtering — the client should never be the only gate here.
  if (session && session.user && session.user.role !== 'admin') {
    posts = posts.filter(p => p.role === 'admin' || p.gender === session.user.gender);
  } else if (!session) {
    // No valid session: return nothing rather than leaking the full feed.
    posts = [];
  }

  const userId = session && session.user ? session.user.id : null;
  const { counts: likeCounts, likedByUser } = _getLikeCountsAndUserLiked(userId);
  const commentCounts = _getCommentCounts();

  posts = posts.map(p => ({
    ...p,
    likeCount: likeCounts[String(p.id)] || 0,
    likedByMe: !!likedByUser[String(p.id)],
    commentCount: commentCounts[String(p.id)] || 0
  }));

  return _json(posts);
}

// =====================================================================
// Likes
// =====================================================================

function _getLikeCountsAndUserLiked(userId) {
  const data = _sheet('Likes').getDataRange().getValues();
  const counts = {};
  const likedByUser = {};
  for (let i = 1; i < data.length; i++) {
    const postId = String(data[i][0]);
    counts[postId] = (counts[postId] || 0) + 1;
    if (userId && String(data[i][1]) === String(userId)) likedByUser[postId] = true;
  }
  return { counts, likedByUser };
}

function _toggleLike(e) {
  const session = _validateSession(e.parameter.token);
  if (!session || session.expired) return _json({ success: false, expired: true, message: 'Session expired.' });

  const postId = e.parameter.postId;
  if (!postId) return _json({ success: false, message: 'Missing postId.' });

  const sheet = _sheet('Likes');
  const data = sheet.getDataRange().getValues();
  const userId = session.user.id;
  let foundRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(postId) && String(data[i][1]) === String(userId)) { foundRow = i + 1; break; }
  }

  let liked;
  if (foundRow > 0) {
    sheet.deleteRow(foundRow);
    liked = false;
  } else {
    sheet.appendRow([postId, userId, new Date().toISOString()]);
    liked = true;
  }

  const newData = sheet.getDataRange().getValues();
  let count = 0;
  for (let i = 1; i < newData.length; i++) if (String(newData[i][0]) === String(postId)) count++;

  return _json({ success: true, liked, likeCount: count });
}

// =====================================================================
// Comments & replies (flat model — parentCommentId links a reply to its parent)
// =====================================================================

function _getCommentCounts() {
  const data = _sheet('Comments').getDataRange().getValues();
  const counts = {};
  for (let i = 1; i < data.length; i++) {
    const postId = String(data[i][1]);
    counts[postId] = (counts[postId] || 0) + 1;
  }
  return counts;
}

function _createComment(e) {
  const session = _validateSession(e.parameter.token);
  if (!session || session.expired) return _json({ success: false, expired: true, message: 'Session expired.' });

  const postId = e.parameter.postId;
  const parentCommentId = e.parameter.parentCommentId || '';
  const content = (e.parameter.content || '').trim();
  if (!postId || !content) return _json({ success: false, message: 'Missing required fields.' });

  const id = Utilities.getUuid();
  const date = new Date().toISOString();
  _sheet('Comments').appendRow([id, postId, parentCommentId, session.user.id, session.user.name, session.user.role, session.user.gender, content, date]);

  return _json({
    success: true,
    comment: { id, postId, parentCommentId, authorId: session.user.id, author: session.user.name, role: session.user.role, gender: session.user.gender, content, date }
  });
}

function _getComments(e) {
  const session = _validateSession(e.parameter.token);
  const postId = e.parameter.postId;
  if (!postId) return _json({ success: false, message: 'Missing postId.' });

  const data = _sheet('Comments').getDataRange().getValues();
  let comments = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) !== String(postId)) continue;
    comments.push({
      id: data[i][0], postId: data[i][1], parentCommentId: data[i][2] || '',
      authorId: data[i][3], author: data[i][4], role: data[i][5], gender: data[i][6],
      content: data[i][7], date: data[i][8]
    });
  }

  const isAdmin = session && !session.expired && session.user.role === 'admin';
  if (!session || session.expired) {
    comments = [];
  } else if (!isAdmin) {
    comments = comments.filter(c => c.role === 'admin' || c.gender === session.user.gender);
  }

  comments.sort((a, b) => new Date(a.date) - new Date(b.date));
  return _json({ success: true, comments });
}

function _deleteComment(e) {
  const session = _validateSession(e.parameter.token);
  if (!session || session.expired) return _json({ success: false, expired: true, message: 'Session expired.' });

  const id = e.parameter.id;
  const sheet = _sheet('Comments');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      const isOwner = String(data[i][3]) === String(session.user.id);
      if (session.user.role !== 'admin' && !isOwner) {
        return _json({ success: false, message: 'You can only delete your own comments.' });
      }
      sheet.deleteRow(i + 1);
      return _json({ success: true });
    }
  }
  return _json({ success: false, message: 'Comment not found.' });
}

// --- Contact form -> real email ---
function _contactMessage(e) {
  const name = (e.parameter.name || '').trim();
  const email = (e.parameter.email || '').trim();
  const message = (e.parameter.message || '').trim();

  if (!name || !email || !message) {
    return _json({ success: false, message: 'Missing required fields.' });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return _json({ success: false, message: 'Please provide a valid email address.' });
  }

  const subject = 'Z-English Contact Form — ' + name;
  const body =
    'New message from the Z-English contact form:\n\n' +
    'Name: ' + name + '\n' +
    'Email: ' + email + '\n\n' +
    'Message:\n' + message + '\n';

  MailApp.sendEmail({
    to: CONTACT_DESTINATION_EMAIL,
    subject: subject,
    body: body,
    replyTo: email
  });

  return _json({ success: true });
}

// =====================================================================
// Categories (sections beyond Basic/Advanced) + custom link-only sessions
// =====================================================================

function _createCategory(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const label = (e.parameter.label || '').trim();
  const type = e.parameter.type === 'practice' ? 'practice' : 'curriculum';
  if (!label) return _json({ success: false, message: 'Category label is required.' });

  const sheet = _sheet('Categories');
  const order = sheet.getDataRange().getValues().length;
  const id = Utilities.getUuid();
  sheet.appendRow([id, label, type, order, 'true', new Date().toISOString()]);
  return _json({ success: true, id });
}

function _listCategories(e) {
  const session = _validateSession(e.parameter.token);
  const isAdmin = session && !session.expired && session.user.role === 'admin';
  const data = _sheet('Categories').getDataRange().getValues();
  const categories = [];
  for (let i = 1; i < data.length; i++) {
    const [id, label, type, order, isActive, createdAt] = data[i];
    if (!isAdmin && String(isActive).toLowerCase() !== 'true') continue;
    categories.push({ id, label, type, order: Number(order) || 0, isActive: String(isActive).toLowerCase() === 'true', createdAt });
  }
  categories.sort((a, b) => a.order - b.order);
  return _json({ success: true, categories });
}

function _deleteCategory(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;
  const id = e.parameter.id;
  const sheet = _sheet('Categories');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) { sheet.getRange(i + 1, 5).setValue('false'); return _json({ success: true }); }
  }
  return _json({ success: false, message: 'Category not found.' });
}

function _findCustomSessionRow(id) {
  const sheet = _sheet('CustomSessions');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) if (data[i][0] === id) return { rowIndex: i + 1, row: data[i] };
  return null;
}

function _createCustomSession(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;

  const categoryId = e.parameter.categoryId;
  const title = (e.parameter.title || '').trim();
  const link = (e.parameter.link || '').trim();
  const password = e.parameter.password || '';
  const sessionMode = e.parameter.sessionMode === 'temporary' ? 'temporary' : 'permanent';
  const expiresAt = e.parameter.expiresAt || '';
  const maxUses = e.parameter.maxUses ? Number(e.parameter.maxUses) : 0;

  if (!categoryId || !title || !link) return _json({ success: false, message: 'Category, title, and link are required.' });
  if (sessionMode === 'temporary' && !expiresAt && !maxUses) {
    return _json({ success: false, message: 'Temporary sessions need an expiry date, a max-use count, or both.' });
  }

  let passwordHash = '', salt = '';
  if (password) { salt = _randomSalt(); passwordHash = _hashPassword(password, salt); }

  const id = Utilities.getUuid();
  _sheet('CustomSessions').appendRow([id, categoryId, title, link, passwordHash, salt, sessionMode, expiresAt, maxUses, 0, 'true', new Date().toISOString()]);
  return _json({ success: true, id });
}

function _listCustomSessions(e) {
  const categoryId = e.parameter.categoryId;
  const session = _validateSession(e.parameter.token);
  const isAdmin = session && !session.expired && session.user.role === 'admin';

  const data = _sheet('CustomSessions').getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const [id, catId, title, link, pwHash, salt, sessionMode, expiresAt, maxUses, useCount, isActive] = data[i];
    if (categoryId && catId !== categoryId) continue;

    const expired = expiresAt && new Date(expiresAt).getTime() < Date.now();
    const usedUp = maxUses > 0 && useCount >= maxUses;
    const stillActive = String(isActive).toLowerCase() === 'true' && !expired && !usedUp;
    if (!isAdmin && !stillActive) continue;

    out.push({
      id, categoryId: catId, title, hasPassword: !!pwHash, sessionMode,
      expiresAt: expiresAt || null, maxUses: maxUses || 0, useCount: Number(useCount) || 0,
      isActive: stillActive, link: isAdmin ? link : undefined
    });
  }
  return _json({ success: true, sessions: out });
}

function _deleteCustomSession(e) {
  const gate = _requireAdminSession(e.parameter.token);
  if (gate.error) return gate.error;
  const found = _findCustomSessionRow(e.parameter.id);
  if (!found) return _json({ success: false, message: 'Session not found.' });
  _sheet('CustomSessions').getRange(found.rowIndex, 11).setValue('false');
  return _json({ success: true });
}

function _unlockCustomSession(e) {
  const session = _validateSession(e.parameter.token);
  if (!session || session.expired) return _json({ success: false, expired: true, message: 'Session expired.' });

  const found = _findCustomSessionRow(e.parameter.id);
  if (!found) return _json({ success: false, message: 'This session no longer exists.' });

  const [ , , title, link, pwHash, salt, , expiresAt, maxUses, useCount, isActive ] = found.row;
  const password = e.parameter.password || '';

  if (String(isActive).toLowerCase() !== 'true') return _json({ success: false, message: 'This session is no longer active.' });
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return _json({ success: false, message: 'This session has expired.' });
  if (maxUses > 0 && useCount >= maxUses) return _json({ success: false, message: 'This session has reached its usage limit.' });

  if (pwHash) {
    const hash = _hashPassword(password, salt);
    if (hash !== pwHash) return _json({ success: false, message: 'Incorrect password.' });
  }

  // Increment use count
  _sheet('CustomSessions').getRange(found.rowIndex, 10).setValue((Number(useCount) || 0) + 1);

  return _json({ success: true, link });
}
