// =====================================================================
// Z-English Migration Script: Google Sheets → Supabase
// =====================================================================
// Usage:
//   1. Export each Google Sheets tab as CSV:
//      Google Sheets → File → Download → CSV (.csv)
//      Name each file: sheets/<sheet-name>.csv
//   2. Place files in the sheets/ directory.
//   3. Set env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
//   4. Run: node migrate/gs-to-supabase.js
//
// The script reads CSV files, maps Google Sheets columns to
// Supabase table schemas (handling the extra "header slots"),
// joins chunked slides_json columns, and inserts everything
// into Supabase via the service-role key.
// =====================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------
// Config — set via environment variables.
// ---------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.');
  console.error('  export SUPABASE_URL="https://your-project-ref.supabase.co"');
  console.error('  export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------
// Simple CSV parser — no external dependencies needed.
// Handles quoted fields, commas inside quotes, and newlines in fields.
// Returns array of arrays (rows), first row = headers.
// ---------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      currentField += ch;
      i++;
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        currentRow.push(currentField);
        currentField = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        // End of row
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          i++; // skip \n after \r
        }
        currentRow.push(currentField);
        if (currentRow.some(f => f.trim() !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        i++;
      } else {
        currentField += ch;
        i++;
      }
    }
  }

  // Handle last field/row
  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some(f => f.trim() !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------
// Helper: read a CSV file exported from Google Sheets
// ---------------------------------------------------------------------
function readSheetFile(sheetName) {
  const filePath = path.join(__dirname, '..', 'sheets', `${sheetName}.csv`);
  if (!fs.existsSync(filePath)) {
    console.warn(`WARNING: File not found: ${filePath} — skipping sheet "${sheetName}"`);
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = parseCSV(raw);
  if (!Array.isArray(data) || data.length === 0) {
    console.error(`ERROR: ${sheetName}.csv is empty or invalid.`);
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------
// Schema mapping: Google Sheets column index → Supabase column name
// Each sheet tab maps to a Supabase table.
// ---------------------------------------------------------------------
const MAPPINGS = {
  // Users sheet → users table
  // GS cols: 0=id, 1=name, 2=password_hash, 3=salt, 4=role, 5=gender,
  //          6=session_token_hash, 7=session_expiry, 8=provider,
  //          9=device1_hash, 10=device2_hash, 11=device1_name, 12=device2_name
  Users: {
    table: 'users',
    columns: [
      'id', 'name', 'password_hash', 'salt', 'role', 'gender',
      'session_token_hash', 'session_expiry', 'provider',
      'device1_hash', 'device2_hash', 'device1_name', 'device2_name'
    ],
    extra: { provider: 'password' },
    skipEmpty: true,
  },

  // UnlockedLevels sheet → unlocked_levels table
  // GS cols: 0=student_id, 1=track, 2=level
  UnlockedLevels: {
    table: 'unlocked_levels',
    columns: ['student_id', 'track', 'level'],
    skipEmpty: true,
  },

  // Sessions sheet → sessions table
  // GS cols: 0=track, 1=level, 2=session_number, 3=password_hash,
  //          4=password_salt, 5=link, 6=updated_at
  Sessions: {
    table: 'sessions',
    columns: ['track', 'level', 'session_number', 'password_hash', 'password_salt', 'link', 'updated_at'],
    skipEmpty: true,
  },

  // LessonContent sheet → lesson_content table
  // GS cols: 0=track, 1=level, 2=session_number, 3+=chunks of slides_json
  LessonContent: {
    table: 'lesson_content',
    columns: ['track', 'level', 'session_number'],
    jsonChunkCol: 3,
    jsonField: 'slides_json',
    skipEmpty: true,
  },

  // LessonAccess sheet → lesson_access table
  // GS cols: 0=token_hash, 1=track, 2=level, 3=session_number,
  //          4=expires_at, 5=used, 6=is_admin_preview, 7=student_id
  LessonAccess: {
    table: 'lesson_access',
    columns: ['token_hash', 'track', 'level', 'session_number', 'expires_at', 'used', 'is_admin_preview', 'student_id'],
    skipEmpty: true,
  },

  // TutorSessions sheet → tutor_sessions table
  // GS cols: 0=token_hash, 1=track, 2=level, 3=session_number, 4=expires_at, 5=message_count
  TutorSessions: {
    table: 'tutor_sessions',
    columns: ['token_hash', 'track', 'level', 'session_number', 'expires_at', 'message_count'],
    skipEmpty: true,
  },

  // Posts sheet → posts table
  // GS cols: 0=id, 1=author, 2=role, 3=gender, 4=content, 5=is_pinned, 6=date
  Posts: {
    table: 'posts',
    columns: ['id', 'author', 'role', 'gender', 'content', 'is_pinned', 'date'],
    skipEmpty: true,
  },

  // Likes sheet → likes table
  // GS cols: 0=post_id, 1=author_id → Supabase uses user_id
  Likes: {
    table: 'likes',
    columns: ['post_id', 'user_id'],
    columnMap: { 'author_id': 'user_id' },
    skipEmpty: true,
  },

  // Comments sheet → comments table
  // GS cols: 0=id, 1=post_id, 2=parent_comment_id, 3=author_id,
  //          4=author, 5=role, 6=gender, 7=content, 8=date
  Comments: {
    table: 'comments',
    columns: ['id', 'post_id', 'parent_comment_id', 'author_id', 'author', 'role', 'gender', 'content', 'date'],
    skipEmpty: true,
  },

  // Categories sheet → categories table
  // GS cols: 0=id, 1=label, 2=type, 3=order, 4=is_active, 5=created_at
  // Supabase uses 'position' instead of 'order'
  Categories: {
    table: 'categories',
    columns: ['id', 'label', 'type', 'position', 'is_active', 'created_at'],
    columnMap: { 'order': 'position' },
    skipEmpty: true,
  },

  // CustomSessions sheet → custom_sessions table
  // GS cols: 0=id, 1=category_id, 2=title, 3=link, 4=password_hash,
  //          5=salt, 6=session_mode, 7=expires_at, 8=max_uses,
  //          9=use_count, 10=is_active, 11=created_at
  CustomSessions: {
    table: 'custom_sessions',
    columns: ['id', 'category_id', 'title', 'link', 'password_hash', 'salt', 'session_mode', 'expires_at', 'max_uses', 'use_count', 'is_active', 'created_at'],
    skipEmpty: true,
  },

  // TempSessions sheet → temp_sessions table
  // GS cols: 0=id, 1=expires_at, 2=authorized_students, 3=name, 4+=chunks of slides_json
  TempSessions: {
    table: 'temp_sessions',
    columns: ['id', 'expires_at', 'authorized_students', 'name'],
    jsonChunkCol: 4,
    jsonField: 'slides_json',
    skipEmpty: true,
  },

  // PublicSessions sheet → public_sessions table
  // GS cols: 0=id, 1=expires_at, 2=participant_data, 3=name, 4+=chunks of slides_json
  PublicSessions: {
    table: 'public_sessions',
    columns: ['id', 'expires_at', 'participant_data', 'name'],
    jsonChunkCol: 4,
    jsonField: 'slides_json',
    skipEmpty: true,
  },

  // TestSessions sheet → test_sessions table
  // GS cols: 0=id, 1=name, 2=slides_json
  TestSessions: {
    table: 'test_sessions',
    columns: ['id', 'name', 'slides_json'],
    skipEmpty: true,
  },

  // TestCodes sheet → test_codes table
  // GS cols: 0=code, 1=test_id, 2=used, 3=student_name, 4=submitted_at
  TestCodes: {
    table: 'test_codes',
    columns: ['code', 'test_id', 'used', 'student_name', 'submitted_at'],
    skipEmpty: true,
  },

  // TestSubmissions sheet → test_submissions table
  // GS cols: 0=test_id, 1=code, 2=student_name, 3=submitted_at, 4=answers_json
  TestSubmissions: {
    table: 'test_submissions',
    columns: ['test_id', 'code', 'student_name', 'submitted_at', 'answers_json'],
    skipEmpty: true,
  },

  // PaymentLinks sheet → payment_links table
  // GS cols: 0=id, 1=student_name, 2=student_contact, 3=price,
  //          4=expiry_date, 5=description, 6=payment_url, 7=created_at
  PaymentLinks: {
    table: 'payment_links',
    columns: ['id', 'student_name', 'student_contact', 'price', 'expiry_date', 'description', 'payment_url', 'created_at'],
    skipEmpty: true,
  },
};

// ---------------------------------------------------------------------
// Helper: join JSON chunks (columns from jsonChunkCol onward)
// ---------------------------------------------------------------------
function joinJsonChunks(row, startCol) {
  const chunks = [];
  for (let i = startCol; i < row.length; i++) {
    const chunk = row[i];
    if (chunk !== undefined && chunk !== null && String(chunk).trim() !== '') {
      chunks.push(String(chunk));
    }
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------
// Helper: convert a GS row to a Supabase row object
// ---------------------------------------------------------------------
function mapRow(sheetName, row) {
  const mapping = MAPPINGS[sheetName];
  if (!mapping) return null;

  const obj = {};

  // Build a reverse map: GS column index → Supabase column name
  // Apply columnMap overrides if present
  const colMap = mapping.columnMap || {};
  for (let i = 0; i < mapping.columns.length; i++) {
    const value = row[i];
    if (value === undefined || value === null) continue;

    let supabaseCol = mapping.columns[i];
    // Apply column mapping override (e.g., 'order' → 'position')
    if (colMap[supabaseCol]) {
      supabaseCol = colMap[supabaseCol];
    }

    // Convert boolean strings
    if (supabaseCol === 'is_pinned' || supabaseCol === 'used' || supabaseCol === 'is_admin_preview' || supabaseCol === 'is_active') {
      obj[supabaseCol] = String(value).toLowerCase() === 'true';
    }
    // Convert numeric strings
    else if (supabaseCol === 'max_uses' || supabaseCol === 'use_count' || supabaseCol === 'message_count') {
      obj[supabaseCol] = parseInt(value, 10) || 0;
    }
    // Convert JSON strings (participant_data, authorized_students)
    else if (supabaseCol === 'participant_data' || supabaseCol === 'authorized_students') {
      try { obj[supabaseCol] = JSON.parse(String(value)); } catch { obj[supabaseCol] = value; }
    }
    // Convert numeric price
    else if (supabaseCol === 'price') {
      obj[supabaseCol] = parseFloat(value) || 0;
    }
    else {
      obj[supabaseCol] = String(value);
    }
  }

  // Handle JSON chunk columns (slides_json)
  if (mapping.jsonChunkCol !== undefined) {
    const chunks = joinJsonChunks(row, mapping.jsonChunkCol);
    if (chunks) {
      obj[mapping.jsonField] = chunks;
    }
  }

  // Add extra Supabase columns with defaults
  if (mapping.extra) {
    for (const [col, val] of Object.entries(mapping.extra)) {
      if (!(col in obj) || !obj[col]) {
        obj[col] = val;
      }
    }
  }

  return obj;
}

// ---------------------------------------------------------------------
// Helper: detect placeholder/demo posts
// ---------------------------------------------------------------------
function isPlaceholderPost(post) {
  const content = String(post.content || '').toLowerCase().trim();
  const author = String(post.author || '').toLowerCase().trim();
  const id = String(post.id || '').toLowerCase().trim();

  const placeholderPatterns = [
    'hello', 'welcome', 'test post', 'sample post', 'demo',
    'placeholder', 'lorem ipsum', 'this is a test', 'example post',
    'delete me', 'remove this', 'temp post', 'scratch',
    'dummy', 'fake post', 'mock', 'example content',
  ];

  return placeholderPatterns.some(p => content.includes(p)) ||
         placeholderPatterns.some(p => author.includes(p)) ||
         id.includes('placeholder') ||
         id.includes('demo') ||
         id.includes('test') ||
         id.includes('sample') ||
         id.includes('temp');
}

// ---------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------
async function migrate() {
  console.log('='.repeat(60));
  console.log('Z-English: Google Sheets → Supabase Migration');
  console.log('='.repeat(60));
  console.log('');
  console.log('Step 1: Export each Google Sheets tab as CSV.');
  console.log('  File → Download → CSV (.csv)');
  console.log('  Save each file as: sheets/<sheet-name>.csv');
  console.log('');
  console.log('Step 2: Make sure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  console.log('        are set as environment variables.');
  console.log('');
  console.log('='.repeat(60));

  const sheetNames = Object.keys(MAPPINGS);
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let placeholderPostsRemoved = 0;

  for (const sheetName of sheetNames) {
    const mapping = MAPPINGS[sheetName];
    console.log(`\n--- Processing sheet: ${sheetName} → table: ${mapping.table} ---`);

    const data = readSheetFile(sheetName);
    if (!data || data.length <= 1) {
      console.log(`  SKIPPED (no data or only headers)`);
      continue;
    }

    // First row is headers in CSV export; our mapping uses column indices
    const dataRows = data.slice(1);

    const batchSize = 50;
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < dataRows.length; i += batchSize) {
      const batch = dataRows.slice(i, i + batchSize);
      const records = [];

      for (const row of batch) {
        // Skip empty rows
        if (!row || row.length === 0 || (row.length === 1 && String(row[0]).trim() === '')) {
          skipped++;
          continue;
        }

        // Skip rows where the first column (usually id) is empty
        if (mapping.skipEmpty && (!row[0] || String(row[0]).trim() === '')) {
          skipped++;
          continue;
        }

        const mapped = mapRow(sheetName, row);
        if (!mapped) {
          skipped++;
          continue;
        }

        records.push(mapped);
      }

      if (records.length === 0) continue;

      // Special handling for Posts: detect and remove placeholder posts
      if (sheetName === 'Posts') {
        const realPosts = records.filter(p => !isPlaceholderPost(p));
        placeholderPostsRemoved += records.length - realPosts.length;
        records.length = 0;
        records.push(...realPosts);
      }

      if (records.length === 0) continue;

      try {
        const { error } = await supabase
          .from(mapping.table)
          .insert(records);

        if (error) {
          console.error(`  ERROR batch ${i / batchSize + 1}: ${error.message}`);
          errors += records.length;
        } else {
          inserted += records.length;
          console.log(`  Inserted batch ${i / batchSize + 1}: ${records.length} records`);
        }
      } catch (err) {
        console.error(`  EXCEPTION batch ${i / batchSize + 1}: ${err.message}`);
        errors += records.length;
      }
    }

    console.log(`  Sheet ${sheetName}: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
    totalInserted += inserted;
    totalSkipped += skipped;
    totalErrors += errors;
  }

  console.log('\n' + '='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`  Total inserted:          ${totalInserted}`);
  console.log(`  Total skipped:           ${totalSkipped}`);
  console.log(`  Total errors:            ${totalErrors}`);
  console.log(`  Placeholder posts removed: ${placeholderPostsRemoved}`);
  console.log('='.repeat(60));

  if (totalErrors > 0) {
    console.log('\n⚠️  Some records failed to insert. Check the errors above.');
  } else {
    console.log('\n✅ Migration complete!');
  }
}

migrate().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
