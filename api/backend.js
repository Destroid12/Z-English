// =====================================================================
// Z-English Backend - Vercel Serverless Function
// ---------------------------------------------------------------------
// MIGRATION: Google Apps Script (backend_Code.gs.local) -> Supabase
// (Postgres + Storage). The Apps Script action contract is preserved:
// action names, parameter names, response shapes and error strings are
// matched exactly so the existing frontends (index.html, player.html,
// editor.html) keep working without changes.
//
// - Login sessions: users.session_token_hash = sha256(raw token),
//   users.session_expiry = now + 12h.
// - Lesson access tokens: lesson_access.token_hash = sha256(raw token),
//   single-use for students, reusable for admin previews.
// - In-session AI tutor: tutor_sessions rows minted on lesson open.
// - Media files live in the public 'zenglish-media' storage bucket;
//   public.media rows index them by storage object key.
// =====================================================================
'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------
// Constants (mirrors backend_Code.gs.local)
// ---------------------------------------------------------------------
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;            // 12h login session
const LESSON_TOKEN_LIFETIME_MS = 3 * 60 * 1000;             // 3min lesson access token
const TUTOR_SESSION_LIFETIME_MS = 3 * 60 * 60 * 1000;       // 3h tutor session
const TUTOR_MAX_MESSAGES = 50;
const TUTOR_MAX_QUESTION_CHARS = 800;
const TUTOR_MAX_SLIDE_CONTEXT_CHARS = 1500;
const TUTOR_MAX_SESSION_CONTEXT_CHARS = 12000;
const TUTOR_MAX_HISTORY_TURNS = 6;
const SITE_TUTOR_MAX_QUESTION_CHARS = 800;
const SITE_TUTOR_MAX_CONTEXT_CHARS = 600000;
const SITE_TUTOR_MAX_HISTORY_TURNS = 8;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;                   // images
const MAX_MEDIA_UPLOAD_BYTES = 64 * 1024 * 1024;            // audio/video
const STORAGE_BUCKET = 'zenglish-media';
const CONTACT_DESTINATION_EMAIL =
  process.env.CONTACT_DESTINATION_EMAIL || 'z.english.academy26@gmail.com';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const ADMIN_GOOGLE_EMAILS = String(process.env.ADMIN_GOOGLE_EMAILS || '')
  .split(',')
  .map(function (s) { return String(s).trim().toLowerCase(); })
  .filter(Boolean);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------
function _sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}
function _randomSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function _hashPassword(password, salt) {
  return _sha256(salt + ':' + password);
}
function _hashDevice(deviceId) {
  return _sha256('dev:' + deviceId);
}
function _nowIso() {
  return new Date().toISOString();
}
function _uuid() {
  return crypto.randomUUID();
}
// Short codes for temp ('T-...') / public sessions. Skips I/O/0/1.
function _generateShortCode(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return prefix ? (prefix + code) : code;
}
function _randomAlnum(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

// ---------------------------------------------------------------------
// Auth / session helpers (ported from backend_Code.gs.local)
// ---------------------------------------------------------------------
async function _issueSession(userId) {
  const token = _uuid();
  const tokenHash = _sha256(token);
  const expiry = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
  const { error } = await supabase
    .from('users')
    .update({ session_token_hash: tokenHash, session_expiry: expiry })
    .eq('id', userId);
  if (error) throw new Error(error.message);
  return token;
}

// Returns null | { expired: true } | { user: <users row> }
async function _validateSession(token) {
  if (!token) return null;
  const tokenHash = _sha256(token);
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('session_token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const expiry = data.session_expiry ? new Date(data.session_expiry).getTime() : 0;
  if (expiry < Date.now()) return { expired: true };
  return { user: data };
}

// Strict admin gate (role === 'admin' only, like the .gs file).
async function _requireAdminSession(token) {
  const session = await _validateSession(token);
  if (!session || session.expired) {
    return { error: { success: false, expired: true, message: 'Session expired.' } };
  }
  if (session.user.role !== 'admin') {
    return { error: { success: false, message: 'Admin access required.' } };
  }
  return { session };
}

async function _hasLevelAccess(studentId, track, level) {
  const { data, error } = await supabase
    .from('unlocked_levels')
    .select('student_id')
    .eq('student_id', String(studentId).toLowerCase())
    .eq('track', track)
    .eq('level', level)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

// Returns an array of { track, level } objects (the frontend reads .track/.level).
async function _getUnlockedLevels(studentId) {
  const { data, error } = await supabase
    .from('unlocked_levels')
    .select('track, level')
    .eq('student_id', String(studentId).toLowerCase());
  if (error) throw new Error(error.message);
  return data || [];
}

async function _loadLessonContent(track, level, sessionNumber) {
  const { data, error } = await supabase
    .from('lesson_content')
    .select('slides_json')
    .eq('track', track)
    .eq('level', level)
    .eq('session_number', sessionNumber)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return data.slides_json;
}

// Device binding ported from _checkAndBindDevice (backend_Code.gs.local).
async function _checkAndBindDevice(user, deviceId, deviceName) {
  if (!deviceId) {
    return { ok: false, message: 'Missing device identifier. Please reload and try again.' };
  }
  const dHash = _hashDevice(deviceId);
  if (user.device1_hash === dHash || user.device2_hash === dHash) return { ok: true };
  if (!user.device1_hash) {
    await supabase
      .from('users')
      .update({ device1_hash: dHash, device1_name: deviceName })
      .eq('id', user.id);
    return { ok: true };
  }
  if (!user.device2_hash) {
    await supabase
      .from('users')
      .update({ device2_hash: dHash, device2_name: deviceName })
      .eq('id', user.id);
    return { ok: true };
  }
  return { ok: false, message: 'This account is already in use on 2 devices. Ask your admin to free a slot.' };
}

// ---------------------------------------------------------------------
// Request parsing: query params first, then body params override.
// Body may be an object, a JSON string (text/plain), or a urlencoded
// string. The frontends' irrelevant `_ts` GET param is ignored.
// ---------------------------------------------------------------------
function _parseParams(req) {
  const params = {};
  const query = req.query || {};
  if (typeof query === 'object') {
    for (const key in query) params[key] = query[key];
  }
  let body = req.body;
  if (body != null) {
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed) {
        let parsed = null;
        try { parsed = JSON.parse(trimmed); } catch (err) { parsed = null; }
        if (parsed && typeof parsed === 'object') {
          for (const key in parsed) params[key] = parsed[key];
        } else {
          try {
            const usp = new URLSearchParams(trimmed);
            for (const pair of usp.entries()) params[pair[0]] = pair[1];
          } catch (err2) { /* not parseable -> ignored */ }
        }
      }
    } else if (typeof body === 'object') {
      for (const key in body) params[key] = body[key];
    }
  }
  delete params._ts;
  return params;
}
// ---------------------------------------------------------------------
// Auth actions
// ---------------------------------------------------------------------
async function _login(p) {
  const identifier = String(p.email || '').trim().toLowerCase();
  const password = p.password || '';
  const deviceId = String(p.deviceId || '').trim();
  const deviceName = String(p.deviceName || 'Unknown Device').trim();

  const { data: user, error } = await supabase
    .from('users').select('*').eq('id', identifier).maybeSingle();
  if (error) throw new Error(error.message);
  if (!user) return { success: false, message: 'Incorrect ID/email or password.' };
  if (user.provider === 'google') {
    return { success: false, message: 'This admin account uses Google Sign-In. Use the Google button instead.' };
  }
  const hash = _hashPassword(password, user.salt);
  if (hash !== user.password_hash) {
    return { success: false, message: 'Incorrect ID/email or password.' };
  }

  let unlockedLevels = [];
  if (user.role === 'student') {
    const deviceCheck = await _checkAndBindDevice(user, deviceId, deviceName);
    if (!deviceCheck.ok) return { success: false, message: deviceCheck.message };
    unlockedLevels = await _getUnlockedLevels(user.id);
  }

  const token = await _issueSession(user.id);
  return {
    success: true,
    user: { id: user.id, name: user.name, role: user.role, gender: user.gender, unlockedLevels: unlockedLevels },
    sessionToken: token
  };
}

async function _googleLogin(p) {
  const idToken = p.idToken;
  if (!idToken) return { success: false, message: 'Missing Google credential.' };

  let payload;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (resp.status !== 200) return { success: false, message: 'Google sign-in could not be verified.' };
    payload = await resp.json();
  } catch (err) {
    return { success: false, message: 'Google sign-in could not be verified.' };
  }

  const email = String(payload.email || '').toLowerCase();
  if (!email) return { success: false, message: 'Google account has no email.' };

  const allowedEmail = ADMIN_GOOGLE_EMAILS.indexOf(email) !== -1;
  const { data: found } = await supabase
    .from('users').select('*').eq('id', email).maybeSingle();

  if (!(found && found.role === 'admin')) {
    if (!allowedEmail) {
      return { success: false, message: 'This Google account is not authorized as an admin.' };
    }
    if (found) {
      await supabase.from('users').update({ role: 'admin', provider: 'google' }).eq('id', email);
    } else {
      const { error: insErr } = await supabase.from('users').insert({
        id: email,
        name: payload.name || email,
        role: 'admin',
        gender: 'male',
        provider: 'google',
        password_hash: '',
        salt: '',
        session_token_hash: '',
        session_expiry: null,
        device1_hash: '', device1_name: '', device2_hash: '', device2_name: ''
      });
      if (insErr) throw new Error(insErr.message);
    }
  }

  const { data: user } = await supabase
    .from('users').select('*').eq('id', email).maybeSingle();
  const token = await _issueSession(user.id);
  return {
    success: true,
    user: { id: user.id, name: payload.name || user.name, role: user.role, gender: user.gender, unlockedLevels: [] },
    sessionToken: token
  };
}

async function _createStudent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const studentId = String(p.studentId || '').trim().toLowerCase();
  const name = String(p.name || '').trim();
  const password = p.password || '';
  const gender = p.gender === 'female' ? 'female' : 'male';

  if (!studentId || !name || !password) {
    return { success: false, message: 'Missing required fields.' };
  }
  if (password.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters.' };
  }
  const { data: dup } = await supabase
    .from('users').select('id').eq('id', studentId).maybeSingle();
  if (dup) return { success: false, message: 'That student ID is already in use.' };

  const salt = _randomSalt();
  const hash = _hashPassword(password, salt);
  const { error } = await supabase.from('users').insert({
    id: studentId,
    name: name,
    password_hash: hash,
    salt: salt,
    role: 'student',
    gender: gender,
    provider: 'password',
    session_token_hash: '',
    session_expiry: null,
    device1_hash: '', device1_name: '', device2_hash: '', device2_name: ''
  });
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _listStudents(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const { data, error } = await supabase
    .from('users').select('*').eq('role', 'student').order('id');
  if (error) throw new Error(error.message);

  const students = [];
  for (const u of data || []) {
    const unlockedLevels = await _getUnlockedLevels(u.id);
    students.push({
      id: u.id,
      name: u.name,
      gender: u.gender,
      hasDevice1: !!u.device1_hash,
      hasDevice2: !!u.device2_hash,
      device1Name: u.device1_name || '',
      device2Name: u.device2_name || '',
      unlockedLevels: unlockedLevels
    });
  }
  return { success: true, students: students };
}

async function _deleteStudent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const studentId = String(p.studentId || '').toLowerCase();
  const { data: found } = await supabase
    .from('users').select('id').eq('id', studentId).maybeSingle();
  if (!found) return { success: false, message: 'Student not found.' };

  await supabase.from('unlocked_levels').delete().eq('student_id', studentId);
  await supabase.from('users').delete().eq('id', studentId);
  return { success: true };
}

async function _freeDeviceSlot(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const studentId = String(p.studentId || '').toLowerCase();
  const slot = String(p.slot || '');
  const { data: found } = await supabase
    .from('users').select('id').eq('id', studentId).maybeSingle();
  if (!found) return { success: false, message: 'Student not found.' };

  const isSlot2 = slot === '2';
  await supabase.from('users').update({
    [isSlot2 ? 'device2_hash' : 'device1_hash']: '',
    [isSlot2 ? 'device2_name' : 'device1_name']: ''
  }).eq('id', studentId);
  return { success: true };
}

// ---------------------------------------------------------------------
// Level access (admin)
// ---------------------------------------------------------------------
async function _grantLevelAccess(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const studentId = String(p.studentId || '').toLowerCase();
  const track = p.track;
  const level = p.level;
  if (!studentId || !track || !level) {
    return { success: false, message: 'Missing required fields.' };
  }
  if (await _hasLevelAccess(studentId, track, level)) return { success: true };
  const { error } = await supabase.from('unlocked_levels').insert({ student_id: studentId, track: track, level: level });
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _revokeLevelAccess(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const studentId = String(p.studentId || '').toLowerCase();
  const track = p.track;
  const level = p.level;
  const { error } = await supabase
    .from('unlocked_levels')
    .delete()
    .eq('student_id', studentId)
    .eq('track', track)
    .eq('level', level);
  if (error) throw new Error(error.message);
  return { success: true };
}
// ---------------------------------------------------------------------
// Admin: curriculum sessions (track/level/session links)
// ---------------------------------------------------------------------
async function _setSessionContent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const track = String(p.track || '');
  const level = String(p.level || '');
  const sessionNumber = String(p.sessionNumber || '');
  const link = String(p.link || '').trim();

  if (track !== 'basic' && track !== 'advanced') {
    return { success: false, message: 'Invalid track.' };
  }
  if (!level || !sessionNumber || !link) {
    return { success: false, message: 'Missing required fields.' };
  }
  const { error } = await supabase
    .from('sessions')
    .upsert(
      { track: track, level: level, session_number: sessionNumber, link: link, updated_at: _nowIso() },
      { onConflict: 'track,level,session_number' }
    );
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _listSessions(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const { data, error } = await supabase
    .from('sessions').select('*').order('track').order('level').order('session_number');
  if (error) throw new Error(error.message);
  const sessions = (data || []).map(function (r) {
    return { track: r.track, level: r.level, sessionNumber: r.session_number, link: r.link };
  });
  return { success: true, sessions: sessions };
}

async function _setLessonContent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const track = String(p.track || '');
  const level = String(p.level || '');
  const sessionNumber = String(p.sessionNumber || '');
  const slidesJson = String(p.slidesJson || '');

  if (!track || !level || !sessionNumber || !slidesJson) {
    return { success: false, message: 'Missing required fields.' };
  }
  try { JSON.parse(slidesJson); } catch (err) {
    return { success: false, message: 'slidesJson is not valid JSON.' };
  }
  const { error } = await supabase
    .from('lesson_content')
    .upsert(
      { track: track, level: level, session_number: sessionNumber, slides_json: slidesJson, updated_at: _nowIso() },
      { onConflict: 'track,level,session_number' }
    );
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _listLessonContentSessions(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const { data, error } = await supabase
    .from('lesson_content').select('track, level, session_number, slides_json');
  if (error) throw new Error(error.message);
  const sessions = (data || [])
    .filter(function (r) { return r.track && r.level && r.session_number; })
    .map(function (r) {
      return {
        track: r.track,
        level: r.level,
        sessionNumber: r.session_number,
        sizeBytes: Buffer.byteLength(String(r.slides_json || ''), 'utf8')
      };
    });
  return { success: true, sessions: sessions };
}

async function _fetchDirectLessonContent(track, level, sessionNumber, tutorToken) {
  const slidesJson = await _loadLessonContent(track, level, sessionNumber);
  if (!slidesJson) {
    return { success: false, message: 'Lesson content has not been uploaded yet. Contact your administrator.' };
  }
  const resp = { success: true, slides: JSON.parse(slidesJson) };
  if (tutorToken) resp.tutorToken = tutorToken;
  return resp;
}

async function _getLessonContentForEdit(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const track = String(p.track || '').trim().toLowerCase();
  const level = String(p.level || '').trim();
  const sessionNumber = String(p.sessionNumber || '').trim();
  if (!track || !level || !sessionNumber) {
    return { success: false, message: 'Missing required fields.' };
  }
  return await _fetchDirectLessonContent(track, level, sessionNumber, null);
}

// ---------------------------------------------------------------------
// Lesson content player endpoint (the heart of the app)
// ---------------------------------------------------------------------
async function _issueTutorToken(track, level, sessionNumber) {
  const token = _uuid();
  const tokenHash = _sha256(token);
  const expiresAt = new Date(Date.now() + TUTOR_SESSION_LIFETIME_MS).toISOString();
  const { error } = await supabase.from('tutor_sessions').insert({
    token_hash: tokenHash,
    track: track,
    level: level,
    session_number: sessionNumber,
    expires_at: expiresAt,
    message_count: 0
  });
  if (error) throw new Error(error.message);
  return token;
}

async function _getLessonContent(p) {
  const userToken = String(p.userToken || p.token || '').trim();
  let user = null;
  let tokenExpired = false;
  if (userToken) {
    const sess = await _validateSession(userToken);
    if (sess && !sess.expired) user = sess.user;
    else if (sess && sess.expired) tokenExpired = true;
  }

  // --- Temporary / public session path (by tempId) ---
  const tempId = String(p.tempId || '').trim();
  if (tempId) {
    const { data: temp, error: terr } = await supabase
      .from('temp_sessions').select('*').eq('id', tempId).maybeSingle();
    if (terr) throw new Error(terr.message);
    if (temp) {
      if (new Date(temp.expires_at).getTime() < Date.now()) {
        return { success: false, expired: true, message: 'This temporary session has expired.' };
      }
      const authStudents = Array.isArray(temp.authorized_students)
        ? temp.authorized_students.map(function (id) { return String(id).trim(); })
        : [];
      const currentUserId = user ? String(user.id).trim() : '';
      if (!user || (user.role !== 'admin' && user.role !== 'instructor' && authStudents.indexOf(currentUserId) === -1)) {
        return { success: false, message: 'You have not been granted access to this temporary session.' };
      }
      return { success: true, slides: JSON.parse(temp.slides_json || '[]') };
    }

    const { data: pub, error: perr } = await supabase
      .from('public_sessions').select('*').eq('id', tempId).maybeSingle();
    if (perr) throw new Error(perr.message);
    if (pub) {
      if (new Date(pub.expires_at).getTime() < Date.now()) {
        return { success: false, expired: true, message: 'This public session has expired.' };
      }
      let authData = { max: 0, joined: [] };
      const pd = pub.participant_data;
      if (pd && typeof pd === 'object') {
        if (Array.isArray(pd.joined)) authData.joined = pd.joined;
        if (typeof pd.max === 'number') authData.max = pd.max;
      }
      const participantId = user && user.id ? String(user.id) : String(p.guestId || 'anon_' + Math.random());
      const isElevated = user && (user.role === 'admin' || user.role === 'instructor');
      if (authData.max > 0) {
        if (authData.joined.indexOf(participantId) === -1 && !isElevated) {
          if (authData.joined.length >= authData.max) {
            return {
              success: false,
              message: 'This session is full (' + authData.max + '/' + authData.max + ' students).'
            };
          }
          authData.joined.push(participantId);
          const { error: uerr } = await supabase
            .from('public_sessions').update({ participant_data: authData }).eq('id', tempId);
          if (uerr) throw new Error(uerr.message);
        }
      }
      return { success: true, slides: JSON.parse(pub.slides_json || '[]') };
    }
    return { success: false, message: 'Session not found.' };
  }

  // --- Regular lesson path (track/level/session + one-time access token) ---
  const track = String(p.track || '').trim().toLowerCase();
  const level = String(p.level || '').trim();
  const sessionNumber = String(p.sessionNumber || '').trim();
  const accessToken = String(p.lt || '').trim();

  if (!user) {
    if (tokenExpired) {
      return { success: false, expired: true, message: 'Your session has expired. Please log in again.' };
    }
    return { success: false, message: 'You must be logged into Z-English to view this session.' };
  }
  if (!track || !level || !sessionNumber || !accessToken) {
    return { success: false, message: 'Missing access token. Please open this lesson from the Z-English dashboard.' };
  }

  const tokenHash = _sha256(accessToken);
  const { data: accessRow, error } = await supabase
    .from('lesson_access')
    .select('*')
    .eq('token_hash', tokenHash)
    .eq('track', track)
    .eq('level', level)
    .eq('session_number', sessionNumber)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!accessRow) {
    return { success: false, message: 'Invalid access link. Please open this lesson from the Z-English dashboard.' };
  }

  const isAdminPreview = !!accessRow.is_admin_preview;
  const savedStudentId = accessRow.student_id ? String(accessRow.student_id) : '';

  if (!isAdminPreview && savedStudentId && savedStudentId.trim() !== String(user.id).trim()) {
    return {
      success: false,
      message: "This link is registered to a different user. Access denied. (Expected: '" +
        savedStudentId + "', Got: '" + user.id + "')"
    };
  }
  if (accessRow.used && !isAdminPreview) {
    return { success: false, message: 'This link has already been used. Please open the lesson again from the dashboard.' };
  }
  if (new Date(accessRow.expires_at).getTime() < Date.now()) {
    return { success: false, message: 'This link has expired. Please open the lesson again from the dashboard.' };
  }

  if (!isAdminPreview) {
    const { error: uerr } = await supabase
      .from('lesson_access').update({ used: true }).eq('token_hash', tokenHash);
    if (uerr) throw new Error(uerr.message);
  }

  const tutorToken = await _issueTutorToken(track, level, sessionNumber);
  return await _fetchDirectLessonContent(track, level, sessionNumber, tutorToken);
}

// ---------------------------------------------------------------------
// Unlock / preview tokens
// ---------------------------------------------------------------------
async function _unlockSession(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }
  const track = String(p.track || '');
  const level = String(p.level || '');
  const sessionNumber = String(p.sessionNumber || '');
  if (!track || !level || !sessionNumber) {
    return { success: false, message: 'Missing required fields.' };
  }

  if (session.user.role !== 'admin' && session.user.role !== 'instructor') {
    if (!(await _hasLevelAccess(session.user.id, track, level))) {
      return { success: false, message: 'You have not unlocked this level yet.' };
    }
  }
  const { data: found } = await supabase
    .from('sessions').select('link')
    .eq('track', track).eq('level', level).eq('session_number', sessionNumber)
    .maybeSingle();
  if (!found) return { success: false, message: 'This session has not been set up yet.' };

  const accessToken = _uuid();
  const tokenHash = _sha256(accessToken);
  const expiresAt = new Date(Date.now() + LESSON_TOKEN_LIFETIME_MS).toISOString();
  const { error } = await supabase.from('lesson_access').insert({
    token_hash: tokenHash,
    track: track,
    level: level,
    session_number: sessionNumber,
    expires_at: expiresAt,
    used: false,
    is_admin_preview: false,
    student_id: session.user.id
  });
  if (error) throw new Error(error.message);
  return { success: true, link: found.link, accessToken: accessToken };
}

async function _getPreviewToken(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const track = String(p.track || '');
  const level = String(p.level || '');
  const sessionNumber = String(p.sessionNumber || '');
  if (!track || !level || !sessionNumber) {
    return { success: false, message: 'Missing fields.' };
  }
  const { data: found } = await supabase
    .from('sessions').select('link')
    .eq('track', track).eq('level', level).eq('session_number', sessionNumber)
    .maybeSingle();
  if (!found) return { success: false, message: 'This session has not been set up yet.' };

  const accessToken = _uuid();
  const tokenHash = _sha256(accessToken);
  const expiresAt = new Date(Date.now() + LESSON_TOKEN_LIFETIME_MS).toISOString();
  const { error } = await supabase.from('lesson_access').insert({
    token_hash: tokenHash,
    track: track,
    level: level,
    session_number: sessionNumber,
    expires_at: expiresAt,
    used: false,
    is_admin_preview: true,
    student_id: gate.session.user.id
  });
  if (error) throw new Error(error.message);
  return { success: true, link: found.link, accessToken: accessToken };
}
// ---------------------------------------------------------------------
// Media upload / download (public 'zenglish-media' storage bucket)
// ---------------------------------------------------------------------
async function _uploadMedia(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const filename = String(p.filename || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
  const mimeType = String(p.mimeType || 'application/octet-stream');
  let dataBase64 = String(p.dataBase64 || '');

  if (!dataBase64) return { success: false, message: 'No file data received.' };

  const allowedPrefixes = ['image/', 'audio/', 'video/'];
  if (!allowedPrefixes.some(function (prefix) { return mimeType.startsWith(prefix); })) {
    return { success: false, message: 'Only image, audio, or video uploads are supported.' };
  }

  const isMedia = mimeType.startsWith('audio/') || mimeType.startsWith('video/');
  const ceiling = isMedia ? MAX_MEDIA_UPLOAD_BYTES : MAX_UPLOAD_BYTES;

  // Strip a data: URL prefix if present (e.g. "data:image/png;base64,....").
  if (dataBase64.indexOf('data:') === 0) {
    const commaIdx = dataBase64.indexOf(',');
    if (commaIdx !== -1) dataBase64 = dataBase64.slice(commaIdx + 1);
  }

  // Same guard heuristic as the .gs file (base64 length is ~1.37x binary size).
  if (dataBase64.length > ceiling * 1.4) {
    return {
      success: false,
      message: isMedia
        ? 'File is too large. Please keep audio/video under ' + Math.round(ceiling / 1024 / 1024) + 'MB.'
        : 'File is too large. Please keep images under 8MB.'
    };
  }

  let bytes;
  try {
    bytes = Buffer.from(dataBase64, 'base64');
  } catch (err) {
    return { success: false, message: 'Upload failed: ' + err.message };
  }
  if (bytes.length > ceiling) {
    return {
      success: false,
      message: isMedia
        ? 'File is too large. Please keep audio/video under ' + Math.round(ceiling / 1024 / 1024) + 'MB.'
        : 'File is too large. Please keep images under 8MB.'
    };
  }

  const key = Date.now() + '_' + filename;
  try {
    const { error: upErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(key, bytes, { contentType: mimeType });
    if (upErr) throw new Error(upErr.message);

    const { data: pubData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key);
    const url = pubData && pubData.publicUrl ? pubData.publicUrl : '';

    const { error: insErr } = await supabase.from('media').insert({
      id: key,
      url: url,
      mime_type: mimeType,
      filename: filename
    });
    if (insErr) throw new Error(insErr.message);

    return { success: true, url: url, fileId: key };
  } catch (err) {
    return { success: false, message: 'Upload failed: ' + err.message };
  }
}

async function _getMedia(p) {
  let id = String(p.id || '').trim();
  if (!id) return { success: false, message: 'No file ID provided' };

  // If a full Drive URL or ID was provided, extract the clean file ID
  const driveMatch = id.match(/\/file\/d\/([-\w]+)/) || id.match(/id=([-\w]+)/) || id.match(/([-\w]{25,})/);
  const cleanDriveId = driveMatch ? (driveMatch[1] || driveMatch[0]) : id;

  try {
    // 1. Try Supabase storage
    const { data: row } = await supabase
      .from('media').select('*').or(`id.eq.${id},id.eq.${cleanDriveId}`).maybeSingle();
    
    const lookupId = (row && row.id) ? row.id : id;
    let data = null, error = null;
    try {
      const res = await supabase.storage.from(STORAGE_BUCKET).download(lookupId);
      data = res.data;
      error = res.error;
    } catch (e) {
      error = e;
    }

    if (!error && data) {
      const buf = Buffer.from(await data.arrayBuffer());
      const mimeType = (row && row.mime_type) ? row.mime_type : 'audio/mpeg';
      return { success: true, base64: buf.toString('base64'), mimeType: mimeType };
    }

    // 2. Fallback: Google Drive or external URL download
    const candidateUrls = [];
    if (id.startsWith('http://') || id.startsWith('https://')) {
      candidateUrls.push(id);
    }
    candidateUrls.push(
      `https://drive.usercontent.google.com/download?id=${cleanDriveId}&export=download&confirm=t`,
      `https://drive.google.com/uc?export=download&id=${cleanDriveId}&confirm=t`,
      `https://docs.google.com/uc?export=download&id=${cleanDriveId}`
    );

    for (const fetchUrl of candidateUrls) {
      try {
        const extResp = await fetch(fetchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          redirect: 'follow'
        });

        if (extResp.ok) {
          const ct = extResp.headers.get('content-type') || '';
          if (!ct.includes('text/html')) {
            const buf = Buffer.from(await extResp.arrayBuffer());
            const mimeType = ct || (row && row.mime_type) || 'audio/mpeg';
            return { success: true, base64: buf.toString('base64'), mimeType: mimeType };
          } else {
            const html = await extResp.text();
            const confirmMatch = html.match(/href="(\/uc\?export=download[^"]+)"/) || html.match(/href="(https:\/\/[^"]+confirm=[^"]+)"/);
            if (confirmMatch) {
              let nextUrl = confirmMatch[1].replace(/&amp;/g, '&');
              if (nextUrl.startsWith('/')) nextUrl = 'https://drive.google.com' + nextUrl;
              const res2 = await fetch(nextUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                redirect: 'follow'
              });
              if (res2.ok && !res2.headers.get('content-type')?.includes('text/html')) {
                const buf2 = Buffer.from(await res2.arrayBuffer());
                const mimeType2 = res2.headers.get('content-type') || 'audio/mpeg';
                return { success: true, base64: buf2.toString('base64'), mimeType: mimeType2 };
              }
            }
          }
        }
      } catch (fetchErr) {
        // Continue to next candidate URL
      }
    }

    return { success: false, message: 'Media not found in storage or external source.' };
  } catch (err) {
    return { success: false, message: 'Failed to fetch media: ' + err.message };
  }
}
// ---------------------------------------------------------------------
// Community: posts / likes / comments
// ---------------------------------------------------------------------
async function _createPost(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired. Please log in again.' };
  }
  const content = String(p.content || '').trim();
  if (!content) return { success: false, message: 'Post content is empty.' };

  const id = _uuid();
  const { error } = await supabase.from('posts').insert({
    id: id,
    author_id: session.user.id,
    author: session.user.name,
    role: session.user.role,
    gender: session.user.gender,
    content: content,
    is_pinned: false,
    date: _nowIso()
  });
  if (error) throw new Error(error.message);
  return { success: true, id: id };
}

async function _getLikesForPosts(postIds) {
  const { data, error } = await supabase
    .from('likes').select('post_id, user_id').in('post_id', postIds);
  if (error) throw new Error(error.message);
  return data || [];
}

async function _getCommentsForPosts(postIds) {
  const { data, error } = await supabase
    .from('comments').select('post_id').in('post_id', postIds);
  if (error) throw new Error(error.message);
  return data || [];
}

// IMPORTANT QUIRK: returns the RAW ARRAY of posts (not wrapped) — the
// frontend does `Array.isArray(data) ? data : data.posts`.
async function _getPosts(p) {
  const session = await _validateSession(p.token);
  if (p.token && (!session || session.expired)) {
    return { success: false, expired: true };
  }

  const { data, error } = await supabase
    .from('posts').select('*').order('is_pinned', { ascending: false }).order('date', { ascending: false });
  if (error) throw new Error(error.message);

  let posts = (data || []).map(function (r) {
    return {
      id: r.id,
      authorId: r.author_id,
      author: r.author,
      role: r.role,
      gender: r.gender,
      content: r.content,
      isPinned: !!r.is_pinned,
      date: r.date
    };
  });

  if (session && session.user && session.user.role !== 'admin' && session.user.role !== 'instructor') {
    posts = posts.filter(function (post) {
      return post.role === 'admin' || post.role === 'instructor' ||
        post.gender === '' || post.gender === session.user.gender;
    });
  } else if (!session) {
    posts = [];
  }

  const userId = session && session.user ? session.user.id : null;
  const postIds = posts.map(function (post) { return post.id; });
  const likeRows = postIds.length ? await _getLikesForPosts(postIds) : [];
  const commentRows = postIds.length ? await _getCommentsForPosts(postIds) : [];

  const likeCounts = {};
  const likedByUser = {};
  for (const like of likeRows) {
    const pid = String(like.post_id);
    likeCounts[pid] = (likeCounts[pid] || 0) + 1;
    if (userId && String(like.user_id) === String(userId)) likedByUser[pid] = true;
  }
  const commentCounts = {};
  for (const comment of commentRows) {
    const pid = String(comment.post_id);
    commentCounts[pid] = (commentCounts[pid] || 0) + 1;
  }

  posts = posts.map(function (post) {
    const pid = String(post.id);
    return Object.assign({}, post, {
      likeCount: likeCounts[pid] || 0,
      likedByMe: !!likedByUser[pid],
      commentCount: commentCounts[pid] || 0
    });
  });

  return posts;
}

async function _deletePost(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }
  if (session.user.role !== 'admin') {
    return { success: false, message: 'Only admins can delete posts.' };
  }
  const postId = p.postId;
  const { data: found } = await supabase
    .from('posts').select('id').eq('id', postId).maybeSingle();
  if (!found) return { success: false, message: 'Post not found.' };

  await supabase.from('likes').delete().eq('post_id', postId);
  await supabase.from('comments').delete().eq('post_id', postId);
  await supabase.from('posts').delete().eq('id', postId);
  return { success: true };
}

async function _toggleLike(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }
  const postId = String(p.postId || '');
  if (!postId) return { success: false, message: 'Missing postId.' };
  const userId = session.user.id;

  const { data: existing } = await supabase
    .from('likes').select('post_id').eq('post_id', postId).eq('user_id', userId).maybeSingle();

  let liked;
  if (existing) {
    const { error } = await supabase
      .from('likes').delete().eq('post_id', postId).eq('user_id', userId);
    if (error) throw new Error(error.message);
    liked = false;
  } else {
    const { error } = await supabase.from('likes').insert({ post_id: postId, user_id: userId });
    if (error) throw new Error(error.message);
    liked = true;
  }

  const { count } = await supabase
    .from('likes').select('post_id', { count: 'exact', head: true }).eq('post_id', postId);
  return { success: true, liked: liked, likeCount: count || 0 };
}

async function _createComment(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }
  const postId = p.postId;
  const parentCommentId = p.parentCommentId || '';
  const content = String(p.content || '').trim();
  if (!postId || !content) return { success: false, message: 'Missing required fields.' };

  if (parentCommentId) {
    const { data: parent } = await supabase
      .from('comments').select('id').eq('id', parentCommentId).maybeSingle();
    if (!parent) return { success: false, message: 'Parent comment not found.' };
  }

  const date = _nowIso();
  const { data, error } = await supabase
    .from('comments')
    .insert({
      id: _uuid(),
      post_id: postId,
      parent_comment_id: parentCommentId,
      author_id: session.user.id,
      author: session.user.name,
      role: session.user.role,
      gender: session.user.gender,
      content: content,
      date: date
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  const c = data;
  return {
    success: true,
    comment: {
      id: c.id,
      postId: c.post_id,
      parentCommentId: c.parent_comment_id,
      authorId: c.author_id,
      author: c.author,
      role: c.role,
      gender: c.gender,
      content: c.content,
      date: c.date
    }
  };
}

async function _getComments(p) {
  const session = await _validateSession(p.token);
  const postId = p.postId;
  if (!postId) return { success: false, message: 'Missing postId.' };

  const { data, error } = await supabase
    .from('comments').select('*').eq('post_id', postId);
  if (error) throw new Error(error.message);

  let comments = (data || []).map(function (r) {
    return {
      id: r.id,
      postId: r.post_id,
      parentCommentId: r.parent_comment_id || '',
      authorId: r.author_id,
      author: r.author,
      role: r.role,
      gender: r.gender,
      content: r.content,
      date: r.date
    };
  });

  const isAdminOrInstructor = session && !session.expired &&
    (session.user.role === 'admin' || session.user.role === 'instructor');
  if (!session || session.expired) {
    comments = [];
  } else if (!isAdminOrInstructor) {
    comments = comments.filter(function (c) {
      return c.role === 'admin' || c.role === 'instructor' || c.gender === session.user.gender;
    });
  }

  comments.sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  return { success: true, comments: comments };
}

async function _deleteComment(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }
  const id = p.id;
  const { data: found } = await supabase
    .from('comments').select('*').eq('id', id).maybeSingle();
  if (!found) return { success: false, message: 'Comment not found.' };

  const isOwner = String(found.author_id) === String(session.user.id);
  if (session.user.role !== 'admin' && !isOwner) {
    return { success: false, message: 'You can only delete your own comments.' };
  }
  await supabase.from('comments').delete().eq('id', id);
  return { success: true };
}

// ---------------------------------------------------------------------
// Contact form (DB only for now — the Apps Script emailed instead)
// ---------------------------------------------------------------------
async function _contactMessage(p) {
  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim();
  const message = String(p.message || '').trim();

  if (!name || !email || !message) {
    return { success: false, message: 'Missing required fields.' };
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return { success: false, message: 'Please provide a valid email address.' };
  }

  const { error } = await supabase.from('contact_messages').insert({
    name: name,
    email: email,
    message: message
  });
  if (error) throw new Error(error.message);
  return { success: true };
}
// ---------------------------------------------------------------------
// Custom sessions (practice sections beyond Basic/Advanced)
// ---------------------------------------------------------------------
async function _createCategory(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const label = String(p.label || '').trim();
  const type = String(p.type || 'custom').trim() || 'custom';
  if (!label) return { success: false, message: 'Category label is required.' };

  const { count } = await supabase
    .from('categories').select('id', { count: 'exact', head: true });
  const id = 'cat_' + _randomAlnum(6);
  const { error } = await supabase.from('categories').insert({
    id: id,
    label: label,
    type: type,
    position: (count || 0) + 1,
    is_active: true
  });
  if (error) throw new Error(error.message);
  return { success: true, id: id };
}

async function _listCategories(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }

  let query = supabase.from('categories').select('*').order('position', { ascending: true });
  if (session.user.role !== 'admin') {
    query = query.eq('is_active', true);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const categories = (data || []).map(function (r) {
    return {
      id: r.id,
      label: r.label,
      type: r.type,
      order: r.position,
      isActive: !!r.is_active,
      createdAt: r.created_at
    };
  });
  return { success: true, categories: categories };
}

async function _deleteCategory(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const id = p.id;
  const { data: found } = await supabase
    .from('categories').select('id').eq('id', id).maybeSingle();
  if (!found) return { success: false, message: 'Category not found.' };

  // Soft delete: sessions inside it stop being listed, history preserved.
  const { error } = await supabase.from('categories').update({ is_active: false }).eq('id', id);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _createCustomSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const categoryId = String(p.categoryId || '').trim();
  const title = String(p.title || '').trim();
  const link = String(p.link || '').trim();
  const password = String(p.password || '');
  // The schema check constraint only allows 'temporary' | 'permanent';
  // the frontend always sends 'permanent'. Anything else is clamped.
  const sessionMode = p.sessionMode === 'temporary' ? 'temporary' : 'permanent';
  const maxUses = parseInt(p.maxUses, 10);
  const maxUsesInt = isNaN(maxUses) || maxUses < 0 ? 0 : maxUses;

  if (!categoryId || !title) {
    return { success: false, message: 'Missing required fields.' };
  }

  let expiresAt = null;
  if (p.expiresAt) {
    const d = new Date(p.expiresAt);
    expiresAt = isNaN(d.getTime()) ? null : d.toISOString();
  }

  const id = 'CS-' + _randomAlnum(6);
  const { error } = await supabase.from('custom_sessions').insert({
    id: id,
    category_id: categoryId,
    title: title,
    link: link,
    password_hash: password ? _sha256(password) : '',
    salt: '',
    session_mode: sessionMode,
    expires_at: expiresAt,
    max_uses: maxUsesInt,
    use_count: 0,
    is_active: true
  });
  if (error) throw new Error(error.message);
  return { success: true, id: id };
}

async function _listCustomSessions(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }

  const categoryId = String(p.categoryId || '').trim();
  if (!categoryId) return { success: false, message: 'Missing categoryId.' };

  let query = supabase
    .from('custom_sessions').select('*').eq('category_id', categoryId);
  if (session.user.role !== 'admin') {
    query = query.eq('is_active', true);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const now = Date.now();
  const isAdmin = session.user.role === 'admin';
  const sessions = (data || []).map(function (r) {
    const expired = !!r.expires_at && new Date(r.expires_at).getTime() < now;
    const row = {
      id: r.id,
      categoryId: r.category_id,
      title: r.title,
      hasPassword: !!(r.password_hash && r.password_hash.length > 0),
      sessionMode: r.session_mode,
      expiresAt: r.expires_at,
      maxUses: r.max_uses,
      useCount: r.use_count,
      isActive: !!r.is_active && !expired,
      expired: expired
    };
    if (isAdmin) row.link = r.link;
    return row;
  });

  return { success: true, sessions: sessions };
}

async function _deleteCustomSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const id = p.id;
  const { data: found } = await supabase
    .from('custom_sessions').select('id').eq('id', id).maybeSingle();
  if (!found) return { success: false, message: 'Session not found.' };

  const { error } = await supabase.from('custom_sessions').update({ is_active: false }).eq('id', id);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _unlockCustomSession(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Session expired.' };
  }

  const id = p.id;
  const password = String(p.password || '');
  const { data: cs, error } = await supabase
    .from('custom_sessions').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!cs) return { success: false, message: 'Session not found.' };

  if (!cs.is_active) {
    return { success: false, message: 'This session is no longer active.' };
  }
  if (cs.expires_at && new Date(cs.expires_at).getTime() < Date.now()) {
    return { success: false, expired: true, message: 'This session has expired.' };
  }
  if (cs.max_uses > 0 && cs.use_count >= cs.max_uses) {
    return { success: false, message: 'This session has reached its maximum number of uses.' };
  }
  if (cs.password_hash && _sha256(password) !== cs.password_hash) {
    return { success: false, message: 'Incorrect password.' };
  }

  const { error: uerr } = await supabase
    .from('custom_sessions').update({ use_count: (cs.use_count || 0) + 1 }).eq('id', id);
  if (uerr) throw new Error(uerr.message);
  return { success: true, link: cs.link };
}
// ---------------------------------------------------------------------
// Temporary sessions (code-protected, admin-authorized students only)
// ---------------------------------------------------------------------
function _hoursFromNowIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function _publishTempSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const name = String(p.name || '').trim();
  const slidesJson = String(p.slidesJson || '');
  const hours = parseFloat(p.expiresInHours);
  const hoursNum = isNaN(hours) || hours <= 0 ? 24 : hours;
  if (!slidesJson) return { success: false, message: 'Missing slidesJson.' };
  try { JSON.parse(slidesJson); } catch (err) {
    return { success: false, message: 'slidesJson is not valid JSON.' };
  }

  const id = _generateShortCode('T-');
  const { error } = await supabase.from('temp_sessions').insert({
    id: id,
    name: name || 'Untitled Temporary Session',
    slides_json: slidesJson,
    expires_at: _hoursFromNowIso(hoursNum),
    authorized_students: []
  });
  if (error) throw new Error(error.message);
  return { success: true, tempId: id };
}

async function _listTempSessions(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const { data, error } = await supabase
    .from('temp_sessions').select('id, name, expires_at').order('expires_at', { ascending: false });
  if (error) throw new Error(error.message);

  const now = Date.now();
  const sessions = (data || []).map(function (r) {
    return { id: r.id, name: r.name, expiresAt: r.expires_at, expired: new Date(r.expires_at).getTime() < now };
  });
  return { success: true, sessions: sessions };
}

async function _updateTempSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const tempId = String(p.tempId || '').trim();
  const hours = parseFloat(p.expiresInHours);
  if (!tempId) return { success: false, message: 'Missing tempId.' };
  if (isNaN(hours) || hours <= 0) return { success: false, message: 'Invalid expiresInHours.' };

  const { data: found, error: ferr } = await supabase
    .from('temp_sessions').select('expires_at').eq('id', tempId).maybeSingle();
  if (ferr) throw new Error(ferr.message);
  if (!found) return { success: false, message: 'Temporary session not found.' };

  // ADD hours to the CURRENT expiry (not now) — matches the frontend.
  const current = found.expires_at ? new Date(found.expires_at).getTime() : Date.now();
  const next = new Date(current + hours * 60 * 60 * 1000).toISOString();
  const { error: uerr } = await supabase
    .from('temp_sessions').update({ expires_at: next }).eq('id', tempId);
  if (uerr) throw new Error(uerr.message);
  return { success: true };
}

async function _updateTempSessionContent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const tempId = String(p.tempId || '').trim();
  const slidesJson = String(p.slidesJson || '');
  if (!tempId || !slidesJson) return { success: false, message: 'Missing required fields.' };
  try { JSON.parse(slidesJson); } catch (err) {
    return { success: false, message: 'slidesJson is not valid JSON.' };
  }
  const { error } = await supabase
    .from('temp_sessions').update({ slides_json: slidesJson }).eq('id', tempId);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _deleteTempSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const tempId = String(p.tempId || '').trim();
  if (!tempId) return { success: false, message: 'Missing tempId.' };
  const { error } = await supabase.from('temp_sessions').delete().eq('id', tempId);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _getTempSessionAccess(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const tempId = String(p.tempId || '').trim();
  if (!tempId) return { success: false, message: 'Missing tempId.' };
  const { data, error } = await supabase
    .from('temp_sessions').select('authorized_students').eq('id', tempId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { success: false, message: 'Temporary session not found.' };
  return { success: true, authorizedStudents: data.authorized_students || [] };
}

async function _toggleTempSessionAccess(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const tempId = String(p.tempId || '').trim();
  const studentId = String(p.studentId || '').trim();
  const hasAccess = String(p.hasAccess || 'false') === 'true';
  if (!tempId || !studentId) return { success: false, message: 'Missing required fields.' };

  const { data, error } = await supabase
    .from('temp_sessions').select('authorized_students').eq('id', tempId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { success: false, message: 'Temporary session not found.' };

  let list = Array.isArray(data.authorized_students) ? data.authorized_students : [];
  list = list.map(function (s) { return String(s); });
  const idx = list.indexOf(studentId);
  if (hasAccess && idx === -1) list.push(studentId);
  if (!hasAccess && idx !== -1) list.splice(idx, 1);

  const { error: uerr } = await supabase
    .from('temp_sessions').update({ authorized_students: list }).eq('id', tempId);
  if (uerr) throw new Error(uerr.message);
  return { success: true };
}

// ---------------------------------------------------------------------
// Public sessions (anyone with the code, optional room limit)
// ---------------------------------------------------------------------
async function _publishPublicSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const name = String(p.name || '').trim();
  const slidesJson = String(p.slidesJson || '');
  const hours = parseFloat(p.expiresInHours);
  const hoursNum = isNaN(hours) || hours <= 0 ? 24 : hours;
  const maxStudents = parseInt(p.maxStudents, 10);
  const maxNum = isNaN(maxStudents) || maxStudents < 0 ? 0 : maxStudents;
  if (!slidesJson) return { success: false, message: 'Missing slidesJson.' };
  try { JSON.parse(slidesJson); } catch (err) {
    return { success: false, message: 'slidesJson is not valid JSON.' };
  }

  const id = _generateShortCode('');
  const { error } = await supabase.from('public_sessions').insert({
    id: id,
    name: name || 'Untitled Public Session',
    slides_json: slidesJson,
    expires_at: _hoursFromNowIso(hoursNum),
    participant_data: { max: maxNum, joined: [] }
  });
  if (error) throw new Error(error.message);
  return { success: true, publicId: id };
}

async function _listPublicSessions(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const { data, error } = await supabase
    .from('public_sessions').select('id, name, expires_at, participant_data')
    .order('expires_at', { ascending: false });
  if (error) throw new Error(error.message);

  const now = Date.now();
  const sessions = (data || []).map(function (r) {
    return {
      publicId: r.id,
      name: r.name,
      expiresAt: r.expires_at,
      expired: new Date(r.expires_at).getTime() < now,
      // The frontend JSON.parses this field, so it MUST be a string.
      authData: JSON.stringify(r.participant_data || { max: 0, joined: [] })
    };
  });
  return { success: true, sessions: sessions };
}

async function _updatePublicSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const publicId = String(p.publicId || '').trim();
  const hours = parseFloat(p.expiresInHours);
  if (!publicId) return { success: false, message: 'Missing publicId.' };
  if (isNaN(hours) || hours <= 0) return { success: false, message: 'Invalid expiresInHours.' };

  const { data: found, error: ferr } = await supabase
    .from('public_sessions').select('expires_at').eq('id', publicId).maybeSingle();
  if (ferr) throw new Error(ferr.message);
  if (!found) return { success: false, message: 'Public session not found.' };

  // ADD hours to the CURRENT expiry (not now) — matches the frontend.
  const current = found.expires_at ? new Date(found.expires_at).getTime() : Date.now();
  const next = new Date(current + hours * 60 * 60 * 1000).toISOString();
  const { error: uerr } = await supabase
    .from('public_sessions').update({ expires_at: next }).eq('id', publicId);
  if (uerr) throw new Error(uerr.message);
  return { success: true };
}

async function _updatePublicSessionContent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const publicId = String(p.publicId || '').trim();
  const slidesJson = String(p.slidesJson || '');
  if (!publicId || !slidesJson) return { success: false, message: 'Missing required fields.' };
  try { JSON.parse(slidesJson); } catch (err) {
    return { success: false, message: 'slidesJson is not valid JSON.' };
  }
  const { error } = await supabase
    .from('public_sessions').update({ slides_json: slidesJson }).eq('id', publicId);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _deletePublicSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const publicId = String(p.publicId || '').trim();
  if (!publicId) return { success: false, message: 'Missing publicId.' };
  const { error } = await supabase.from('public_sessions').delete().eq('id', publicId);
  if (error) throw new Error(error.message);
  return { success: true };
}
// ---------------------------------------------------------------------
// Test sessions (code-gated exams with submissions)
// ---------------------------------------------------------------------
async function _publishTestSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const name = String(p.name || '').trim();
  const slidesJson = String(p.slidesJson || '');
  if (!slidesJson) return { success: false, message: 'Missing slidesJson.' };
  try { JSON.parse(slidesJson); } catch (err) {
    return { success: false, message: 'slidesJson is not valid JSON.' };
  }

  const id = _uuid();
  const { error } = await supabase.from('test_sessions').insert({ id: id, name: name || 'Untitled Test', slides_json: slidesJson });
  if (error) throw new Error(error.message);
  return { success: true, testId: id };
}

async function _updateTestSessionContent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const testId = String(p.testId || '').trim();
  const slidesJson = String(p.slidesJson || '');
  if (!testId || !slidesJson) return { success: false, message: 'Missing required fields.' };
  try { JSON.parse(slidesJson); } catch (err) {
    return { success: false, message: 'slidesJson is not valid JSON.' };
  }
  const { error } = await supabase
    .from('test_sessions').update({ slides_json: slidesJson }).eq('id', testId);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _getTestSessionContent(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const testId = String(p.testId || '').trim();
  if (!testId) return { success: false, message: 'Missing testId.' };
  const { data, error } = await supabase
    .from('test_sessions').select('slides_json').eq('id', testId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { success: false, message: 'Test session not found.' };
  return { success: true, slides: JSON.parse(data.slides_json || '[]') };
}

async function _listTestSessions(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const { data, error } = await supabase
    .from('test_sessions').select('id, name').order('name');
  if (error) throw new Error(error.message);
  const sessions = (data || []).map(function (r) { return { id: r.id, name: r.name }; });
  return { success: true, sessions: sessions };
}

async function _deleteTestSession(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const testId = String(p.testId || '').trim();
  if (!testId) return { success: false, message: 'Missing testId.' };
  await supabase.from('test_codes').delete().eq('test_id', testId);
  await supabase.from('test_submissions').delete().eq('test_id', testId);
  await supabase.from('test_sessions').delete().eq('id', testId);
  return { success: true };
}

async function _generateTestCodes(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const testId = String(p.testId || '').trim();
  const count = parseInt(p.count, 10);
  const countNum = isNaN(count) || count < 1 ? 1 : Math.min(count, 1000);
  if (!testId) return { success: false, message: 'Missing testId.' };

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const { data: existing, error: exErr } = await supabase
    .from('test_codes').select('code').eq('test_id', testId);
  if (exErr) throw new Error(exErr.message);
  const usedCodes = {};
  for (const row of existing || []) usedCodes[row.code] = true;

  const codes = [];
  let attempts = 0;
  while (codes.length < countNum && attempts < countNum * 25) {
    attempts++;
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (usedCodes[code]) continue;
    usedCodes[code] = true;
    codes.push(code);
  }
  if (codes.length === 0) return { success: false, message: 'Could not generate unique codes. Try again.' };

  const { error: insErr } = await supabase.from('test_codes').insert(
    codes.map(function (code) { return { code: code, test_id: testId, used: false }; })
  );
  if (insErr) throw new Error(insErr.message);
  return { success: true, codes: codes };
}

async function _listTestCodes(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  let query = supabase.from('test_codes').select('*').order('code');
  if (p.testId) query = query.eq('test_id', p.testId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const codes = (data || []).map(function (r) {
    return {
      code: r.code,
      testId: r.test_id,
      used: !!r.used,
      studentName: r.student_name || '',
      submittedAt: r.submitted_at
    };
  });
  return { success: true, codes: codes };
}

async function _deleteTestCode(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const code = String(p.code || '').trim().toUpperCase();
  if (!code) return { success: false, message: 'Missing code.' };
  const { error } = await supabase.from('test_codes').delete().eq('code', code);
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _validateTestCode(p) {
  const code = String(p.code || '').trim().toUpperCase();
  if (!code) return { success: false, message: 'Invalid test code.' };

  const { data: tc, error } = await supabase
    .from('test_codes').select('*').eq('code', code).maybeSingle();
  if (error) throw new Error(error.message);
  if (!tc) return { success: false, message: 'Invalid test code.' };
  if (tc.used) return { success: false, message: 'This code has already been used.' };

  const { data: ts, error: tsErr } = await supabase
    .from('test_sessions').select('id, slides_json').eq('id', tc.test_id).maybeSingle();
  if (tsErr) throw new Error(tsErr.message);
  if (!ts) return { success: false, message: 'The test for this code no longer exists.' };

  return { success: true, testId: ts.id, slides: JSON.parse(ts.slides_json || '[]') };
}

async function _submitTest(p) {
  const code = String(p.code || '').trim().toUpperCase();
  const sessionId = String(p.sessionId || '').trim();
  const studentName = String(p.studentName || '').trim();
  const answersJson = String(p.answersJson || '');

  if (!studentName || !answersJson) return { success: false, message: 'Missing required fields.' };
  try { JSON.parse(answersJson); } catch (err) {
    return { success: false, message: 'answersJson is not valid JSON.' };
  }

  let resolvedTestId = sessionId;
  if (code) {
    const { data: tc, error: tcErr } = await supabase
      .from('test_codes').select('*').eq('code', code).maybeSingle();
    if (tcErr) throw new Error(tcErr.message);
    if (tc) {
      if (tc.used) return { success: false, message: 'This code has already been used.' };
      const { error: markErr } = await supabase
        .from('test_codes')
        .update({ used: true, student_name: studentName, submitted_at: _nowIso() })
        .eq('code', code);
      if (markErr) throw new Error(markErr.message);
      resolvedTestId = tc.test_id;
    }
  }
  if (!resolvedTestId) return { success: false, message: 'Missing sessionId.' };

  const { error } = await supabase.from('test_submissions').insert({
    test_id: resolvedTestId,
    code: code,
    student_name: studentName,
    answers_json: answersJson,
    submitted_at: _nowIso()
  });
  if (error) throw new Error(error.message);
  return { success: true };
}

async function _listTestSubmissions(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  let query = supabase.from('test_submissions').select('*').order('submitted_at', { ascending: false });
  if (p.testId) query = query.eq('test_id', p.testId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const submissions = (data || []).map(function (r) {
    return {
      testId: r.test_id,
      code: r.code,
      studentName: r.student_name,
      submittedAt: r.submitted_at,
      answersJson: r.answers_json
    };
  });
  return { success: true, submissions: submissions };
}

async function _deleteTestSubmission(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const code = String(p.code || '').trim().toUpperCase();
  if (!code) return { success: false, message: 'Missing code.' };
  const { error } = await supabase.from('test_submissions').delete().eq('code', code);
  if (error) throw new Error(error.message);
  return { success: true };
}
// ---------------------------------------------------------------------
// AI Tutor (Gemini) — prompts ported verbatim from backend_Code.gs.local
// ---------------------------------------------------------------------
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

// Slides are stored as arrays of objects; stringify before stripping so the
// tutor sees real content instead of "[object Object]".
function _slideToText(slide) {
  if (typeof slide === 'string') return _stripHtmlToText(slide);
  try { return _stripHtmlToText(JSON.stringify(slide)); } catch (err) { return ''; }
}

// Digest of every slide in one session for the in-lesson tutor.
async function _getSessionContextText(track, level, sessionNumber) {
  const slidesJson = await _loadLessonContent(track, level, sessionNumber);
  if (!slidesJson) return '';
  let slides;
  try { slides = JSON.parse(slidesJson); } catch (err) { return ''; }
  if (!Array.isArray(slides)) return '';
  let out = '';
  for (let idx = 0; idx < slides.length; idx++) {
    const text = _slideToText(slides[idx]);
    if (!text) continue;
    const piece = 'Slide ' + (idx + 1) + ': ' + text + '\n\n';
    if ((out.length + piece.length) > TUTOR_MAX_SESSION_CONTEXT_CHARS) break;
    out += piece;
  }
  return out.trim();
}

// Digest across every track/level/session the user is allowed to see.
async function _getAllSessionsContextText(user) {
  const { data, error } = await supabase
    .from('lesson_content').select('track, level, session_number, slides_json');
  if (error) throw new Error(error.message);

  let allowed = null;
  if (user && user.role !== 'admin' && user.role !== 'instructor') {
    const unlocked = await _getUnlockedLevels(user.id);
    allowed = {};
    for (const u of unlocked || []) allowed[String(u.track) + '||' + String(u.level)] = true;
  }

  let out = '';
  for (const row of data || []) {
    const track = row.track, level = row.level, sessionNumber = row.session_number, slidesJson = row.slides_json;
    if (!track || !level || !sessionNumber || !slidesJson) continue;
    if (allowed && !allowed[String(track) + '||' + String(level)]) continue;

    let slides;
    try { slides = JSON.parse(slidesJson); } catch (err) { continue; }
    if (!Array.isArray(slides)) continue;

    let header = '\n=== ' + track + ' Level ' + level + ' Session ' + sessionNumber + ' ===\n';
    let body = '';
    for (let idx = 0; idx < slides.length; idx++) {
      const text = _slideToText(slides[idx]);
      if (text) body += 'Slide ' + (idx + 1) + ': ' + text + '\n';
    }
    if (!body) continue;
    if ((out.length + header.length + body.length) > SITE_TUTOR_MAX_CONTEXT_CHARS) break;
    out += header + body;
  }
  return out.trim();
}

// Validate the in-lesson tutor token against tutor_sessions.
async function _validateTutorToken(tutorToken, track, level, sessionNumber) {
  if (!tutorToken) {
    return { error: { success: false, message: 'Invalid tutor session. Please reopen this lesson from the dashboard.' } };
  }
  const tokenHash = _sha256(tutorToken);
  const { data, error } = await supabase
    .from('tutor_sessions').select('*').eq('token_hash', tokenHash).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    return { error: { success: false, message: 'Invalid tutor session. Please reopen this lesson from the dashboard.' } };
  }
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return { error: { success: false, message: 'This tutor session has expired. Please reopen the lesson from the dashboard.' } };
  }
  if (String(data.track) !== String(track) ||
      String(data.level) !== String(level) ||
      String(data.session_number) !== String(sessionNumber)) {
    return { error: { success: false, message: 'Invalid tutor session. Please reopen this lesson from the dashboard.' } };
  }
  if ((data.message_count || 0) >= TUTOR_MAX_MESSAGES) {
    return { error: { success: false, message: "You've reached the question limit for this lesson session. Please ask your instructor, or reopen the lesson to start a fresh session." } };
  }
  return { state: data };
}

// Shared Gemini call. Throws on API failure so callers can decide the message.
async function _callGemini(systemInstruction, contents, opts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('The tutor is not configured yet. An administrator needs to set GEMINI_API_KEY.');
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + encodeURIComponent(apiKey);

  const generationConfig = {
    maxOutputTokens: (opts && opts.maxOutputTokens) || 8192,
    temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.7
  };
  if (opts && opts.jsonMode) generationConfig.responseMimeType = 'application/json';

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents: contents,
      generationConfig: generationConfig
    })
  });
  if (resp.status !== 200) {
    const errText = (await resp.text()).slice(0, 500);
    throw new Error('Gemini API error (' + resp.status + '): ' + errText);
  }
  const data = await resp.json();
  const candidate = (data.candidates || [])[0];
  const reply = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map(function (part) { return part.text || ''; }).join('\n').trim()
    : '';
  if (!reply) throw new Error('Gemini returned no response.');
  return reply;
}

// Normalize conversation history from the frontend into Gemini contents.
function _historyToContents(historyRaw, maxTurns) {
  let history = [];
  try {
    const parsed = typeof historyRaw === 'string' ? JSON.parse(historyRaw || '[]') : historyRaw;
    if (Array.isArray(parsed)) {
      history = parsed
        .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
        .slice(-maxTurns)
        .map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', content: String(m.content).slice(0, 600) }; });
    }
  } catch (err) { history = []; }
  return history.map(function (m) { return { role: m.role, parts: [{ text: m.content }] }; });
}

function _cleanMarkdownReply(reply) {
  return reply.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').trim();
}

async function _askTutor(p) {
  const track = String(p.track || '').trim().toLowerCase();
  const level = String(p.level || '').trim();
  const sessionNumber = String(p.sessionNumber || '').trim();
  const tutorToken = String(p.tutorToken || '').trim();
  const slideIndex = String(p.slideIndex || '').trim();
  let question = String(p.question || '').trim();
  let slideContext = String(p.slideContext || '').trim();

  if (!track || !level || !sessionNumber || !tutorToken || !question) {
    return { success: false, message: 'Missing required fields.' };
  }

  const tokenState = await _validateTutorToken(tutorToken, track, level, sessionNumber);
  if (tokenState.error) return tokenState.error;

  const audioBase64 = String(p.audioBase64 || '').trim();
  const audioMime = String(p.audioMime || '').trim();
  const hasAudio = audioBase64.length > 0 && audioMime.length > 0;

  // Trim inputs to sane bounds regardless of what the client sent.
  if (question.length > TUTOR_MAX_QUESTION_CHARS) question = question.slice(0, TUTOR_MAX_QUESTION_CHARS);
  if (slideContext.length > TUTOR_MAX_SLIDE_CONTEXT_CHARS) slideContext = slideContext.slice(0, TUTOR_MAX_SLIDE_CONTEXT_CHARS);

  const historyContents = _historyToContents(p.history, TUTOR_MAX_HISTORY_TURNS);
  const sessionContext = await _getSessionContextText(track, level, sessionNumber);

  const systemPrompt =
    'You are "Z-AI", a friendly, encouraging English tutor built into a Z-English lesson session ' +
    '(Track: ' + track + ', Level: ' + level + ', Session: ' + sessionNumber + ').\n\n' +
    'Full material for this lesson session, slide by slide:\n"""\n' + (sessionContext || '(no extra material available)') + '\n"""\n\n' +
    (slideContext ? 'The student is currently looking at this slide (visible text):\n"""\n' + slideContext + '\n"""\n\n' : '') +
    (slideIndex ? 'They are on slide ' + slideIndex + ' of the session.\n\n' : '') +
    'Strict rules you must always follow:\n' +
    "1. ONLY discuss this lesson's material and general English-language learning (grammar, vocabulary, spelling, pronunciation, usage, writing). " +
    'If asked about anything else — other subjects, personal advice, current events, coding, etc. — politely decline in one short sentence and steer back to English or this lesson. Do this every time, even if asked repeatedly or told it is allowed.\n' +
    "2. If the student asks for a quiz, practice questions (including radio select, wordbank, and fill-in-the-blank), or extra exercises, generate short original questions drawn from this session's material, and you may give the correct answers for those NEW questions you write yourself when asked.\n" +
    "3. For any fill-in-the-blank, matching, or radio select question that already appears on the lesson slides above, never reveal its exact correct answer — instead give a hint and explain the relevant rule, encouraging the student to try it themselves.\n" +
    '4. Reply in plain text only — never use markdown symbols such as **, *, #, or backticks for formatting. Use plain sentences or simple dashes for lists.\n' +
    '5. Keep replies short and warm: 2-4 sentences normally, a bit longer only when writing a quiz or list.\n' +
    "6. Reply in whichever language the student writes in. If the student writes or speaks in Arabic, you MUST reply using the Egyptian Arabic dialect (اللهجة المصرية) and act as a friendly Egyptian male tutor.\n" +
    '7. CRITICAL: If the student types their message, strictly correct ANY spelling, grammar, or capitalization mistakes. HOWEVER, if they send a voice recording, DO NOT correct capitalization or punctuation (since spoken words don\'t have capital letters!). For voice recordings, ONLY correct their pronunciation and spoken grammar. Point out mispronounced words and explain how they should sound. You MUST NOT ignore any valid mistakes. Always use a warm, friendly, and encouraging tone (e.g. "Great job! Just a quick tip..."). After correcting them strictly but nicely, answer their question.';

  const contents = historyContents.slice();
  const userParts = [{ text: question }];
  if (hasAudio) {
    userParts.push({ inlineData: { mimeType: audioMime, data: audioBase64 } });
  }
  contents.push({ role: 'user', parts: userParts });

  try {
    const reply = await _callGemini(systemPrompt, contents, { temperature: 0.7 });
    // Only count a successful exchange against the cap.
    await supabase
      .from('tutor_sessions')
      .update({ message_count: (tokenState.state.message_count || 0) + 1 })
      .eq('token_hash', _sha256(tutorToken));
    return { success: true, reply: _cleanMarkdownReply(reply) };
  } catch (err) {
    console.error('Tutor call failed: ' + err.message);
    return { success: false, message: "Couldn't reach the tutor. Please try again." };
  }
}

async function _askSiteTutor(p) {
  const session = await _validateSession(p.token);
  if (!session || session.expired) {
    return { success: false, expired: true, message: 'Please sign in to use the AI Tutor.' };
  }

  let question = String(p.question || '').trim();
  if (!question) return { success: false, message: 'Missing question.' };
  if (question.length > SITE_TUTOR_MAX_QUESTION_CHARS) question = question.slice(0, SITE_TUTOR_MAX_QUESTION_CHARS);

  const audioBase64 = String(p.audioBase64 || '').trim();
  const audioMime = String(p.audioMime || '').trim();
  const hasAudio = audioBase64.length > 0 && audioMime.length > 0;

  const historyContents = _historyToContents(p.history, SITE_TUTOR_MAX_HISTORY_TURNS);
  const curriculumContext = await _getAllSessionsContextText(session.user);

  const systemPrompt =
    'You are "Z-AI", the site-wide English tutor for Z-English, talking to ' + session.user.name +
    ' (' + session.user.role + ').\n\n' +
    'Here is the full curriculum content across every track/level/session currently uploaded:\n"""\n' +
    (curriculumContext || '(no lesson content has been uploaded yet)') + '\n"""\n\n' +
    'Rules:\n' +
    '1. Only discuss English learning (grammar, vocabulary, pronunciation, usage, writing) and this curriculum. Politely decline anything unrelated and steer back, even if asked repeatedly.\n' +
    '2. You may reference which level/session a topic comes from to help the student find it.\n' +
    '3. You may write NEW original quiz/practice questions on any topic and give answers to those.\n' +
    "4. For fill-in-the-blank questions that already exist verbatim on a lesson slide, don't reveal the exact stored answer — hint instead.\n" +
    '5. Plain text only, no markdown symbols.\n' +
    '6. Keep replies short and warm; reply in whichever language the student uses.\n' +
    "7. CRITICAL: If the student types their message, strictly correct ANY spelling, grammar, or capitalization mistakes. HOWEVER, if they send a voice recording, DO NOT correct capitalization or punctuation (since spoken words don't have capital letters!). For voice recordings, ONLY correct their pronunciation and spoken grammar. Point out mispronounced words and explain how they should sound. You MUST NOT ignore any valid mistakes. Always use a warm, friendly, and encouraging tone (e.g. \"Great job! Just a quick tip...\"). After correcting them strictly but nicely, answer their question.";

  const contents = historyContents.slice();
  const userParts = [{ text: question }];
  if (hasAudio) {
    userParts.push({ inlineData: { mimeType: audioMime, data: audioBase64 } });
  }
  contents.push({ role: 'user', parts: userParts });

  try {
    const reply = await _callGemini(systemPrompt, contents, { temperature: 0.7 });
    return { success: true, reply: _cleanMarkdownReply(reply) };
  } catch (err) {
    console.error('Site tutor call failed: ' + err.message);
    return { success: false, message: "Couldn't reach the tutor. Please try again." };
  }
}

// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Auto-fix (editor AI helpers)
// ---------------------------------------------------------------------
const FIXER_SHARED_RULES =
  '## ELEMENT KINDS (the "kind" property inside "elements" array)\n\n' +
  '### 1. kind: "paragraph"\n' +
  '{ "id": "ai_p123", "kind": "paragraph", "pos": null, "text": "Your text here.\\nSecond line.", "size": 16, "color": "", "bold": false, "align": "left", "font": "" }\n' +
  'Use \\n for line breaks inside "text".\n\n' +
  '### 2. kind: "image" (PICK RELATED IMAGES FROM INTERNET)\n' +
  '{ "id": "ai_img12", "kind": "image", "pos": null, "url": "https://image.pollinations.ai/prompt/[detailed_english_description_with_spaces_replaced_by_%20]?width=600&height=400&nologo=true", "caption": "Optional caption" }\n' +
  'RULE FOR IMAGES: Whenever a slide introduces vocabulary, a story, a dialogue, or a concept, ALWAYS include a kind:"image" element with a vivid, specific descriptive prompt.\n' +
  'Example: "https://image.pollinations.ai/prompt/a%20happy%20family%20eating%20dinner%20together%20in%20a%20cozy%20kitchen?width=600&height=400&nologo=true"\n\n' +
  '### 3. kind: "speaking"\n' +
  '{ "id": "ai_spk1", "kind": "speaking", "pos": null, "text": "Practice saying: Where is the train station?", "color": "#1E6FA6", "bgColor": "#EAF4FC", "bold": true }\n\n' +
  '### 4. kind: "list"\n' +
  '{ "id": "ai_lst1", "kind": "list", "pos": null, "items": [{ "text": "Item 1" }, { "text": "Item 2" }], "font": "" }\n\n' +
  '### 5. kind: "question" (INTERACTIVE EXERCISES)\n' +
  'Schema: { "id": "ai_q123", "kind": "question", "pos": null, "prompt": "Question text with [blank] placeholder", "font": "", "blanks": [{ "qtype": "...", "answer": "...", "altAnswers": [], "options": [] }] }\n' +
  'The "prompt" contains the question text. Use [blank] to mark where the interactive input goes.\n\n' +
  '#### Supported Question Types ("qtype"):\n' +
  '- "text": free text input. Example: { "qtype": "text", "answer": "goes", "altAnswers": ["Goes"], "options": [] }\n' +
  '- "select": dropdown menu. Example: { "qtype": "select", "answer": "apples", "altAnswers": [], "options": ["apples", "banana", "bread"] }\n' +
  '- "radio": single choice clickable buttons. Example: { "qtype": "radio", "answer": "blue", "altAnswers": [], "options": ["red", "blue", "green"] }\n' +
  '- "checkbox": multi-select checkboxes. "answer" is comma-separated correct keys. Example: { "qtype": "checkbox", "answer": "dog,cat", "altAnswers": [], "options": ["dog", "cat", "chair", "table"] }\n' +
  '- "match": matching pairs. "options" is array of "left|right". Example: { "qtype": "match", "answer": "", "altAnswers": [], "options": ["sun|daytime", "moon|night", "rain|water"] }\n' +
  '- "schedule": put items in order. "options" is correct order array. Example: { "qtype": "schedule", "answer": "", "altAnswers": [], "options": ["First step", "Second step", "Third step"] }\n' +
  '- "wordbank": arrange words into sentence. "answer" is full sentence, "options" is list of words. Example: { "qtype": "wordbank", "answer": "She is reading a book", "altAnswers": [], "options": ["She", "is", "reading", "a", "book", "plays"] }\n\n';

const FIXER_SYSTEM_PROMPT =
  'You are an expert educational slide fixer for the Z-English learning platform.\n' +
  'You receive a JSON object representing a SINGLE SLIDE with: { "id": "...", "type": "content"|"activity", "title": "...", "elements": [...] }\n\n' +
  FIXER_SHARED_RULES +
  '## YOUR TASK RULES\n' +
  '1. Fix grammar, formatting, and layout. Add relevant images using pollinations.ai URLs for vocabulary and topics.\n' +
  '2. Convert raw text questions into interactive kind:"question" elements.\n' +
  '3. Generate unique IDs for new elements using "ai_" followed by 6 random alphanumeric characters.\n' +
  '4. Preserve existing element IDs where applicable. Keep the slide "id" unchanged.\n' +
  '5. If the slide is obsolete or user requested deletion, return: { "delete": true }\n\n' +
  'CRITICAL: You MUST think inside <think> ... </think> first. After that, output ONLY a valid JSON object ```json { ... } ``` or ```json { "delete": true } ```.';

const FIXER_SESSION_SYSTEM_PROMPT =
  'You are an expert educational curriculum creator and slide designer for the Z-English learning platform.\n' +
  'You receive a JSON array of existing slides (which may be empty or contain 1 or more slides) along with user instructions.\n' +
  'You must return a complete, professional, beautifully-structured JSON ARRAY of SLIDES: [ { "id": "...", "type": "content"|"activity", "title": "...", "elements": [...] }, ... ]\n\n' +
  '## CORE POWERS:\n' +
  '1. CREATE NEW SLIDES: If the user asks for a new session (e.g. "Create 10 slides about..."), or asks to add practice/quiz/dialogue/reading slides, CREATE AS MANY SLIDES AS REQUESTED OR NEEDED!\n' +
  '2. PICK / GENERATE RELEVANT IMAGES: Include kind:"image" elements with vivid, educational prompts (e.g. "https://image.pollinations.ai/prompt/a%20modern%20doctor%20talking%20to%20a%20patient%20in%20a%20clinic?width=600&height=400&nologo=true") for vocabulary and concepts.\n' +
  '3. INTERACTIVE ACTIVITIES: Create interactive exercises (matching pairs, radio buttons, select dropdowns, wordbank sentence builders, fill-in-the-blanks) and speaking practice blocks.\n' +
  '4. EDIT / EXPAND EXISTING SLIDES: Polish, expand, or reorganize existing slides according to the instructions.\n\n' +
  FIXER_SHARED_RULES +
  '## SLIDE STRUCTURE:\n' +
  'Each slide object must have: { "id": "slide_xxx", "type": "content"|"activity", "title": "Slide Title", "elements": [...] }\n\n' +
  'CRITICAL: You MUST think inside <think> ... </think> first. Then output ONLY a valid JSON array enclosed in ```json [ ... ] ```.';

const PPTX_CONVERTER_SYSTEM_PROMPT =
  'You are an expert PowerPoint to Z-English interactive educational slide converter.\n' +
  'You convert raw slides, text, speaker notes, and extracted media from PowerPoint (.pptx) into rich, interactive Z-English slides.\n\n' +
  FIXER_SHARED_RULES +
  '## CRITICAL RULES FOR PPTX CONVERSION:\n' +
  '1. INTELLIGENT QUESTION & OCR EXTRACTION:\n' +
  '   - Differentiate between ILLUSTRATIVE GRAPHICS and QUESTION/WORKSHEET IMAGES.\n' +
  '   - If an image or text contains a question, quiz, exercise, fill-in-the-blank, multiple choice, matching pairs, or reordering task:\n' +
  '     * Transcribe and OCR ALL questions and answers into native interactive kind: "question" elements!\n' +
  '     * DO NOT include the worksheet screenshot image in elements — the interactive question elements REPLACE the image!\n' +
  '     * If an image or text has MULTIPLE questions (e.g. 1 to 5), create a SEPARATE kind: "question" element for EACH question!\n' +
  '     * Each kind: "question" element MUST have: "prompt" (containing [blank] if fill-in-the-blank), and blanks array [{ "qtype": "radio"|"select"|"text"|"match"|"wordbank"|"schedule", "answer": "...", "options": [...] }]\n' +
  '     * Use appropriate "qtype":\n' +
  '       - "radio" for multiple choice (provide options array like ["A. apple", "B. banana", ...], and correct answer)\n' +
  '       - "select" for dropdown choices in sentences\n' +
  '       - "text" for typing in blanks marked by [blank] in prompt text\n' +
  '       - "match" for matching pairs (format each item in options array as "left|right")\n' +
  '       - "wordbank" for sentence reconstruction\n' +
  '       - "schedule" for sequencing steps\n' +
  '     * Only include kind: "image" with url: "[IMAGE:0]" if there is a separate educational illustration/diagram (e.g. a chart, diagram, or story picture) that students need to look at.\n' +
  '2. PRESERVE RELEVANT MEDIA & GRAPHICS:\n' +
  '   - For illustrative photos, diagrams, and figures, use kind: "image" with url: "[IMAGE:0]" (or index/name) so the client attaches the high-res image.\n' +
  '   - For audio clips, use kind: "audio" with url: "[MEDIA:filename]".\n' +
  '3. DIALOGUE & PRONUNCIATION:\n' +
  '   - Convert dialogue practice or "Say / Repeat" prompts into kind: "speaking" with text and practicePrompt.\n' +
  '4. OUTPUT STRUCTURE:\n' +
  '   - For a single slide: return a JSON object: { "id": "slide_xxx", "type": "content"|"activity", "title": "Slide Title", "elements": [...] }\n' +
  '   - For a session: return a JSON array: [ { "id": "slide_1", ... }, { "id": "slide_2", ... } ]\n\n' +
  'CRITICAL: You MUST think inside <think> ... </think> first. Then output ONLY valid JSON.';

// Extract the JSON payload out of a Gemini text reply (strip <think> blocks
// and markdown fences; fall back to first {...} / [...] substring).
function _extractJsonFromGemini(fixedText, wantArray) {
  let text = fixedText.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
  const fenceMatch = text.match(/```(?:json)?\n?([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    const open = wantArray ? '[' : '{';
    const close = wantArray ? ']' : '}';
    const first = text.indexOf(open);
    const last = text.lastIndexOf(close);
    if (first !== -1 && last !== -1) text = text.substring(first, last + 1).trim();
  }
  return JSON.parse(text);
}

async function _autoFixSlide(p) {
  const session = await _validateSession(p.token);
  if (!session) return { success: false, message: 'Authentication required.' };
  if (session.expired) return { success: false, expired: true, message: 'Session expired.' };

  const slideJsonStr = String(p.slideJson || '').trim();
  const customInstructions = String(p.instructions || '').trim();
  if (!slideJsonStr) return { success: false, message: 'Missing slide JSON.' };

  let userPrompt = 'Slide JSON:\n' + slideJsonStr;
  if (customInstructions) {
    userPrompt = 'USER INSTRUCTIONS:\n"""\n' + customInstructions + '\n"""\n\n' + userPrompt;
  }

  try {
    const fixedText = await _callGemini(FIXER_SYSTEM_PROMPT,
      [{ role: 'user', parts: [{ text: userPrompt }] }],
      { maxOutputTokens: 16384, temperature: 0.3 });
    const fixedSlide = _extractJsonFromGemini(fixedText, false);
    return { success: true, slide: fixedSlide };
  } catch (err) {
    console.error('AutoFixSlide failed: ' + err.message);
    return { success: false, message: 'AI returned invalid JSON: ' + err.message };
  }
}

async function _autoFixSession(p) {
  const session = await _validateSession(p.token);
  if (!session) return { success: false, message: 'Authentication required.' };
  if (session.expired) return { success: false, expired: true, message: 'Session expired.' };

  const slides = p.slides || [];
  const customInstructions = String(p.instructions || '').trim();
  if (!Array.isArray(slides) || slides.length === 0) {
    return { success: false, message: 'No slides provided.' };
  }

  // Auto-Fix uses per-slide parallel workers with FIXER_SYSTEM_PROMPT
  if (slides.length > 0) {
    const CONCURRENCY = 3;
    const fixedSlides = new Array(slides.length);
    let nextSlide = 0;

    async function worker() {
      while (true) {
        const i = nextSlide++;
        if (i >= slides.length) return;
        const slideStr = typeof slides[i] === 'string' ? slides[i] : JSON.stringify(slides[i]);
        let userPrompt = 'Input Slide JSON:\n' + slideStr + '\n\n';
        if (customInstructions) {
          userPrompt += '\nUSER INSTRUCTIONS:\n"""\n' + customInstructions + '\n"""\nPlease process this slide.';
        }
        const fixedText = await _callGemini(FIXER_SYSTEM_PROMPT,
          [{ role: 'user', parts: [{ text: userPrompt }] }],
          { maxOutputTokens: 16384, temperature: 0.3 });
        fixedSlides[i] = _extractJsonFromGemini(fixedText, false);
      }
    }

    const workerCount = Math.min(CONCURRENCY, slides.length);
    try {
      await Promise.all(Array.from({ length: workerCount }, function () { return worker(); }));
      const keptSlides = fixedSlides.filter(function (s) { return s && s.delete !== true; });
      return { success: true, slides: keptSlides };
    } catch (err) {
      console.error('AutoFixSession failed: ' + err.message);
      return { success: false, message: 'AI returned invalid JSON: ' + err.message };
    }
  }

  return { success: false, message: 'No slides generated.' };
}

async function _analyzePPTXImage(p) {
  const session = await _validateSession(p.token);
  if (!session) return { success: false, message: 'Authentication required.' };
  if (session.expired) return { success: false, expired: true, message: 'Session expired.' };

  const mimeType = String(p.mimeType || 'image/png');
  const imageBase64 = String(p.imageBase64 || '').trim();
  if (!imageBase64) return { success: false, message: 'Missing image data.' };

  const systemPrompt =
    'You are analyzing an image that was extracted from a PowerPoint slide in the Z-English editor.\n' +
    'Decide whether the image contains LESSON TEXT (explanations, sentences, vocabulary) or a QUESTION/EXERCISE.\n' +
    'Transcribe all visible text accurately. Then reply with ONLY a JSON object in this exact shape:\n' +
    '{ "type": "text" | "question", "content": "<the full transcribed text>" }\n' +
    'Use "question" if the image contains a question, fill-in-the-blank, choices, or an exercise. ' +
    'Use "text" for plain lesson content. No markdown, no extra words, JSON only.';

  try {
    const reply = await _callGemini(systemPrompt, [{
      role: 'user',
      parts: [
        { text: 'Analyze this image and return the JSON classification of its content.' },
        { inlineData: { mimeType: mimeType, data: imageBase64 } }
      ]
    }], { maxOutputTokens: 4096, temperature: 0.2, jsonMode: true });

    let parsed = null;
    try { parsed = JSON.parse(reply); } catch (err) { parsed = null; }
    if (!parsed) {
      try { parsed = _extractJsonFromGemini(reply, false); } catch (err2) { parsed = null; }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { success: true, result: { type: 'question', content: reply } };
    }
    const type = parsed.type === 'text' ? 'text' : 'question';
    const content = String(parsed.content || reply);
    return { success: true, result: { type: type, content: content } };
  } catch (err) {
    console.error('analyzePPTXImage failed: ' + err.message);
    return { success: false, message: 'Could not analyze the image. Please try again.' };
  }
}

async function _convertPptxSlide(p) {
  const session = await _validateSession(p.token);
  if (!session) return { success: false, message: 'Authentication required.' };
  if (session.expired) return { success: false, expired: true, message: 'Session expired.' };

  let slideData = p.slideData || {};
  if (typeof slideData === 'string') {
    try { slideData = JSON.parse(slideData); } catch (e) { slideData = {}; }
  }
  const customInstructions = String(p.instructions || '').trim();
  const parts = [];

  let promptText = 'Convert this PowerPoint slide into a native Z-English interactive slide JSON:\n\n' +
    'Slide Title: ' + (slideData.title || 'Untitled') + '\n' +
    'Slide Text Content:\n' + (slideData.text || '(none)') + '\n' +
    'Speaker Notes:\n' + (slideData.notes || '(none)') + '\n';

  if (slideData.media && Array.isArray(slideData.media) && slideData.media.length > 0) {
    promptText += '\nAttached Media Items (' + slideData.media.length + '):\n';
    slideData.media.forEach((m, idx) => {
      promptText += '- Media ' + (idx + 1) + ': Name: ' + (m.name || '') + ', Tag: [IMAGE:' + idx + '] or [MEDIA:' + (m.name || '') + '], Type: ' + (m.type || '') + '\n';
    });
  }

  if (slideData.images && Array.isArray(slideData.images) && slideData.images.length > 0) {
    promptText += '\nAttached Slide Images (' + slideData.images.length + ' image(s) provided below for multimodal analysis).\n' +
      'Check if any image contains exercises/questions/quizzes/worksheets: If yes, OCR and extract ALL questions into native kind: "question" elements!\n' +
      'If an image is an educational illustration or needed diagram, include kind: "image" with url: "[IMAGE:0]" (or respective index).\n';
  }

  if (customInstructions) {
    promptText = 'USER INSTRUCTIONS:\n"""\n' + customInstructions + '\n"""\n\n' + promptText;
  }

  parts.push({ text: promptText });

  // If there are images provided with base64 for OCR analysis, attach them to the multimodal request (up to 4 images)
  if (slideData.images && Array.isArray(slideData.images)) {
    slideData.images.slice(0, 4).forEach(img => {
      if (img.base64) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType || 'image/png',
            data: img.base64.replace(/^data:[^;]+;base64,/, '')
          }
        });
      }
    });
  }

  try {
    const fixedText = await _callGemini(PPTX_CONVERTER_SYSTEM_PROMPT,
      [{ role: 'user', parts: parts }],
      { maxOutputTokens: 16384, temperature: 0.3 });
    const fixedSlide = _extractJsonFromGemini(fixedText, false);
    return { success: true, slide: fixedSlide };
  } catch (err) {
    console.error('convertPptxSlide failed: ' + err.message);
    return { success: false, message: 'AI conversion failed: ' + err.message };
  }
}

async function _convertPptxSession(p) {
  const session = await _validateSession(p.token);
  if (!session) return { success: false, message: 'Authentication required.' };
  if (session.expired) return { success: false, expired: true, message: 'Session expired.' };

  let pptxSlides = p.slides;
  if (typeof pptxSlides === 'string') {
    try { pptxSlides = JSON.parse(pptxSlides); } catch (e) { pptxSlides = []; }
  }
  if (!Array.isArray(pptxSlides) || pptxSlides.length === 0) {
    return { success: false, message: 'No slides provided.' };
  }

  const customInstructions = String(p.instructions || '').trim();
  const summaryList = pptxSlides.map((s, i) => {
    return {
      slideIndex: i + 1,
      title: s.title || '',
      text: s.text || '',
      notes: s.notes || '',
      media: (s.media || []).map(m => ({ name: m.name, type: m.type, url: m.url }))
    };
  });

  let promptText = 'Convert this complete PowerPoint deck (' + summaryList.length + ' slides) into a full interactive Z-English session JSON array.\n\n' +
    'PPTX Slides Outline:\n' + JSON.stringify(summaryList, null, 2);

  if (customInstructions) {
    promptText = 'USER INSTRUCTIONS FOR SESSION CONVERSION:\n"""\n' + customInstructions + '\n"""\n\n' + promptText;
  }

  try {
    const fixedText = await _callGemini(PPTX_CONVERTER_SYSTEM_PROMPT,
      [{ role: 'user', parts: [{ text: promptText }] }],
      { maxOutputTokens: 16384, temperature: 0.3 });
    const resultSlides = _extractJsonFromGemini(fixedText, true);
    if (Array.isArray(resultSlides)) {
      return { success: true, slides: resultSlides };
    }
    throw new Error('AI did not return a valid slides array');
  } catch (err) {
    console.error('convertPptxSession failed: ' + err.message);
    return { success: false, message: 'AI session conversion failed: ' + err.message };
  }
}
// ---------------------------------------------------------------------
// Paymob payment links (mirrors api/paymob.js)
// ---------------------------------------------------------------------
async function _createPaymobLink(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const price = parseFloat(p.price);
  const expirationIso = p.expirationDate;
  const studentName = String(p.studentName || 'Student').trim();
  const studentContact = String(p.studentContact || '').trim();
  const description = String(p.description || 'Z-English Course Access').trim();
  const apiKey = p.apiKey || process.env.PAYMOB_API_KEY;
  const integrationId = p.integrationId || process.env.PAYMOB_INTEGRATION_ID;
  const iframeId = p.iframeId || process.env.PAYMOB_IFRAME_ID;

  if (isNaN(price) || price <= 0 || !expirationIso || !apiKey || !integrationId || !iframeId) {
    return { success: false, message: 'Invalid price or missing Paymob configuration.' };
  }

  const expirationDate = new Date(expirationIso);
  const priceCents = Math.round(price * 100);

  // Step 1: Obtain auth token.
  const authResp = await fetch('https://accept.paymob.com/api/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey })
  });
  const authData = await authResp.json();
  const authToken = authData.token;
  if (!authToken) {
    return { success: false, message: 'Failed to authenticate with Paymob. Check API Key.' };
  }

  // Step 2: Register the order.
  const orderResp = await fetch('https://accept.paymob.com/api/ecommerce/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: authToken,
      delivery_needed: 'false',
      amount_cents: String(priceCents),
      currency: 'EGP',
      items: []
    })
  });
  const orderData = await orderResp.json();
  const orderId = orderData.id;
  if (!orderId) {
    return { success: false, message: 'Failed to create Paymob order.' };
  }

  // Step 3: Generate the payment key.
  const keyResp = await fetch('https://accept.paymob.com/api/acceptance/payment_keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: authToken,
      amount_cents: String(priceCents),
      expiration: Math.max(60, Math.floor((expirationDate.getTime() - Date.now()) / 1000)),
      order_id: String(orderId),
      billing_data: {
        first_name: studentName.split(' ')[0] || 'Student',
        last_name: studentName.split(' ').slice(1).join(' ') || 'User',
        phone_number: studentContact,
        email: studentContact
      },
      currency: 'EGP',
      integration_id: Number(integrationId),
      lock_order_when_paid: 'false'
    })
  });
  const keyData = await keyResp.json();
  if (!keyData.token) {
    return { success: false, message: 'Failed to obtain Paymob payment key.' };
  }

  const paymentUrl = 'https://accept.paymob.com/api/acceptance/iframes/' + iframeId +
    '?payment_token=' + keyData.token;

  const id = _uuid();
  const { error } = await supabase.from('payment_links').insert({
    id: id,
    student_name: studentName,
    student_contact: studentContact,
    price: price,
    expiry_date: expirationDate.toISOString(),
    description: description,
    payment_url: paymentUrl,
    created_at: _nowIso()
  });
  if (error) throw new Error(error.message);
  return { success: true, linkId: id, paymentUrl: paymentUrl };
}

async function _listPaymobLinks(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const { data, error } = await supabase
    .from('payment_links').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);

  const links = (data || []).map(function (r) {
    return {
      id: r.id,
      studentName: r.student_name,
      studentContact: r.student_contact,
      price: r.price,
      expiryDate: r.expiry_date,
      description: r.description,
      paymentUrl: r.payment_url,
      createdAt: r.created_at
    };
  });
  return { success: true, links: links };
}

async function _deletePaymobLink(p) {
  const gate = await _requireAdminSession(p.token);
  if (gate.error) return gate.error;

  const linkId = p.linkId;
  if (!linkId) return { success: false, message: 'Missing linkId.' };
  const { error } = await supabase.from('payment_links').delete().eq('id', linkId);
  if (error) throw new Error(error.message);
  return { success: true };
}

// =====================================================================
// Public session content (mirrors getLessonContent for public sessions)
// =====================================================================
async function _getPublicSessionContent(p) {
  const publicId = String(p.publicId || '').trim();
  const userToken = String(p.userToken || p.token || '').trim();
  if (!publicId) return { success: false, message: 'Missing publicId.' };

  // Look up the public session record first.
  const { data: pub, error: pubErr } = await supabase
    .from('public_sessions')
    .select('*')
    .eq('id', publicId)
    .maybeSingle();
  if (pubErr) throw new Error(pubErr.message);
  if (!pub) return { success: false, message: 'Public session not found.' };

  // Validate that the user/student has access.
  if (!pub.is_public) {
    // Restricted — require a valid session token.
    const session = await _validateSession(userToken);
    if (!session || session.expired) {
      return { success: false, message: 'Access denied. Please log in to view this session.' };
    }
  }

  // Load the lesson content using track/level/session_number from the public_session row.
  const slides = await _loadLessonContent(pub.track, pub.level, pub.session_number);
  return {
    success: true,
    title: pub.title || '',
    track: pub.track,
    level: pub.level,
    sessionNumber: pub.session_number,
    slides: slides
  };
}

// =====================================================================
// Dispatcher
// =====================================================================
const actions = {
  login: _login,
  googleLogin: _googleLogin,
  createStudent: _createStudent,
  listStudents: _listStudents,
  deleteStudent: _deleteStudent,
  freeDeviceSlot: _freeDeviceSlot,
  grantLevelAccess: _grantLevelAccess,
  revokeLevelAccess: _revokeLevelAccess,
  setSessionContent: _setSessionContent,
  listSessions: _listSessions,
  setLessonContent: _setLessonContent,
  getLessonContentForEdit: _getLessonContentForEdit,
  listLessonContentSessions: _listLessonContentSessions,
  getLessonContent: _getLessonContent,
  unlockSession: _unlockSession,
  getPreviewToken: _getPreviewToken,
  uploadMedia: _uploadMedia,
  getMedia: _getMedia,
  createPost: _createPost,
  getPosts: _getPosts,
  deletePost: _deletePost,
  toggleLike: _toggleLike,
  createComment: _createComment,
  getComments: _getComments,
  deleteComment: _deleteComment,
  contactMessage: _contactMessage,
  createCategory: _createCategory,
  listCategories: _listCategories,
  deleteCategory: _deleteCategory,
  createCustomSession: _createCustomSession,
  listCustomSessions: _listCustomSessions,
  deleteCustomSession: _deleteCustomSession,
  unlockCustomSession: _unlockCustomSession,
  publishTempSession: _publishTempSession,
  listTempSessions: _listTempSessions,
  updateTempSession: _updateTempSession,
  updateTempSessionContent: _updateTempSessionContent,
  deleteTempSession: _deleteTempSession,
  getTempSessionAccess: _getTempSessionAccess,
  toggleTempSessionAccess: _toggleTempSessionAccess,
  publishPublicSession: _publishPublicSession,
  listPublicSessions: _listPublicSessions,
  updatePublicSession: _updatePublicSession,
  updatePublicSessionContent: _updatePublicSessionContent,
  deletePublicSession: _deletePublicSession,
  publishTestSession: _publishTestSession,
  updateTestSessionContent: _updateTestSessionContent,
  getTestSessionContent: _getTestSessionContent,
  listTestSessions: _listTestSessions,
  deleteTestSession: _deleteTestSession,
  generateTestCodes: _generateTestCodes,
  listTestCodes: _listTestCodes,
  deleteTestCode: _deleteTestCode,
  validateTestCode: _validateTestCode,
  submitTest: _submitTest,
  listTestSubmissions: _listTestSubmissions,
  deleteTestSubmission: _deleteTestSubmission,
  askTutor: _askTutor,
  askSiteTutor: _askSiteTutor,
  autoFixSlide: _autoFixSlide,
  autoFixSession: _autoFixSession,
  analyzePPTXImage: _analyzePPTXImage,
  convertPptxSlide: _convertPptxSlide,
  convertPptxSession: _convertPptxSession,
  createPaymobLink: _createPaymobLink,
  listPaymobLinks: _listPaymobLinks,
  deletePaymobLink: _deletePaymobLink,
  getPublicSessionContent: _getPublicSessionContent
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const params = _parseParams(req);
    const action = String(params.action || '');
    if (!action) {
      return res.status(200).json({ success: false, message: 'Missing action.' });
    }
    const fn = actions[action];
    if (!fn) {
      return res.status(200).json({ success: false, message: 'Unknown action' });
    }
    const result = await fn(params);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Z-English backend error:', err);
    return res.status(200).json({ success: false, message: 'Server error: ' + err.message });
  }
};




