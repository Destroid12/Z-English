-- =====================================================================
-- Z-English Supabase schema
-- Replaces the Google Sheets backend (backend_Code.gs.local).
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New query).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Users (replaces the "Users" sheet)
-- id = student ID (e.g. STU-1042) or admin Google email
-- session_token_hash = sha256(raw token) — server validates sessions
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id                 text primary key,
  name               text not null default '',
  password_hash      text not null default '',
  salt               text not null default '',
  role               text not null default 'student' check (role in ('student','instructor','admin')),
  gender             text not null default 'male' check (gender in ('male','female')),
  provider           text not null default 'password' check (provider in ('password','google')),
  session_token_hash text not null default '',
  session_expiry     timestamptz,
  device1_hash       text not null default '',
  device2_hash       text not null default '',
  device1_name       text not null default '',
  device2_name       text not null default '',
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- UnlockedLevels (replaces the "UnlockedLevels" sheet)
-- ---------------------------------------------------------------------
create table if not exists public.unlocked_levels (
  id         bigint generated always as identity primary key,
  student_id text not null,
  track      text not null,
  level      text not null,
  granted_at timestamptz not null default now(),
  unique (student_id, track, level)
);
create index if not exists idx_unlocked_student on public.unlocked_levels (student_id);

-- ---------------------------------------------------------------------
-- Sessions (curriculum session links — replaces the "Sessions" sheet)
-- ---------------------------------------------------------------------
create table if not exists public.sessions (
  track          text not null,
  level          text not null,
  session_number text not null,
  password_hash  text not null default '',
  password_salt  text not null default '',
  link           text not null default '',
  updated_at     timestamptz not null default now(),
  primary key (track, level, session_number)
);

-- ---------------------------------------------------------------------
-- LessonContent (replaces the "LessonContent" sheet).
-- slides_json is the full JSON array of compiled slide HTML strings.
-- (Apps Script had to chunk this across columns; Supabase text holds up to 1GB.)
-- ---------------------------------------------------------------------
create table if not exists public.lesson_content (
  track          text not null,
  level          text not null,
  session_number text not null,
  slides_json    text not null default '',
  updated_at     timestamptz not null default now(),
  primary key (track, level, session_number)
);

-- ---------------------------------------------------------------------
-- LessonAccess (one-time lesson unlock / preview tokens)
-- ---------------------------------------------------------------------
create table if not exists public.lesson_access (
  id                bigint generated always as identity primary key,
  token_hash        text not null,
  track             text not null,
  level             text not null,
  session_number    text not null,
  expires_at        timestamptz not null,
  used              boolean not null default false,
  is_admin_preview  boolean not null default false,
  student_id        text not null default '',
  created_at        timestamptz not null default now()
);
create index if not exists idx_lesson_access_hash on public.lesson_access (token_hash);

-- ---------------------------------------------------------------------
-- TutorSessions (in-session AI tutor tokens + message caps)
-- ---------------------------------------------------------------------
create table if not exists public.tutor_sessions (
  id            bigint generated always as identity primary key,
  token_hash    text not null,
  track         text not null,
  level         text not null,
  session_number text not null,
  expires_at    timestamptz not null,
  message_count integer not null default 0
);
create index if not exists idx_tutor_sessions_hash on public.tutor_sessions (token_hash);

-- ---------------------------------------------------------------------
-- Posts (community feed)
-- ---------------------------------------------------------------------
create table if not exists public.posts (
  id        text primary key,
  author_id text not null default '',
  author    text not null,
  role      text not null default 'student',
  gender    text not null default 'male',
  content   text not null,
  is_pinned boolean not null default false,
  date      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Likes
-- ---------------------------------------------------------------------
create table if not exists public.likes (
  id         bigint generated always as identity primary key,
  post_id    text not null,
  user_id    text not null,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);
create index if not exists idx_likes_post on public.likes (post_id);

-- ---------------------------------------------------------------------
-- Comments (flat model; parent_comment_id links a reply to its parent)
-- ---------------------------------------------------------------------
create table if not exists public.comments (
  id                text primary key,
  post_id           text not null,
  parent_comment_id text not null default '',
  author_id         text not null default '',
  author            text not null,
  role              text not null default 'student',
  gender            text not null default 'male',
  content           text not null,
  date              timestamptz not null default now()
);
create index if not exists idx_comments_post on public.comments (post_id);

-- ---------------------------------------------------------------------
-- Categories (sections beyond Basic/Advanced)
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id         text primary key,
  label      text not null,
  type       text not null default 'custom',
  position   integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- CustomSessions (link-only practice sessions)
-- ---------------------------------------------------------------------
create table if not exists public.custom_sessions (
  id            text primary key,
  category_id   text not null,
  title         text not null,
  link          text not null default '',
  password_hash text not null default '',
  salt          text not null default '',
  session_mode  text not null default 'permanent' check (session_mode in ('temporary','permanent')),
  expires_at    timestamptz,
  max_uses      integer not null default 0,
  use_count     integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists idx_custom_cat on public.custom_sessions (category_id);

-- ---------------------------------------------------------------------
-- TempSessions (code-protected temporary sessions)
-- ---------------------------------------------------------------------
create table if not exists public.temp_sessions (
  id                  text primary key,
  expires_at          timestamptz not null,
  authorized_students jsonb not null default '[]'::jsonb,
  name                text not null default '',
  slides_json         text not null default ''
);

-- ---------------------------------------------------------------------
-- PublicSessions (join-by-code public sessions)
-- ---------------------------------------------------------------------
create table if not exists public.public_sessions (
  id               text primary key,
  expires_at       timestamptz not null,
  participant_data jsonb not null default '{"max":0,"joined":[]}'::jsonb,
  name             text not null default '',
  slides_json      text not null default ''
);

-- ---------------------------------------------------------------------
-- TestSessions / TestCodes / TestSubmissions
-- ---------------------------------------------------------------------
create table if not exists public.test_sessions (
  id          text primary key,
  name        text not null default '',
  slides_json text not null default ''
);

create table if not exists public.test_codes (
  code         text primary key,
  test_id      text not null,
  used         boolean not null default false,
  student_name text not null default '',
  submitted_at timestamptz
);
create index if not exists idx_test_codes_test on public.test_codes (test_id);

create table if not exists public.test_submissions (
  id           bigint generated always as identity primary key,
  test_id      text not null,
  code         text not null,
  student_name text not null,
  submitted_at timestamptz not null default now(),
  answers_json text not null default '[]'
);
create index if not exists idx_test_subs_test on public.test_submissions (test_id);

-- ---------------------------------------------------------------------
-- PaymentLinks (Paymob history)
-- ---------------------------------------------------------------------
create table if not exists public.payment_links (
  id             text primary key,
  student_name   text not null default '',
  student_contact text not null default '',
  price          numeric not null default 0,
  expiry_date    timestamptz,
  description    text not null default '',
  payment_url    text not null default '',
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- ContactMessages
-- ---------------------------------------------------------------------
create table if not exists public.contact_messages (
  id         bigint generated always as identity primary key,
  name       text not null,
  email      text not null,
  message    text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Media (registry for uploaded files; object lives in the storage bucket)
-- id = the storage object key/path
-- ---------------------------------------------------------------------
create table if not exists public.media (
  id         text primary key,
  url        text not null,
  mime_type  text not null default '',
  filename   text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Storage bucket for uploaded lesson media (images/audio/video)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('zenglish-media', 'zenglish-media', true)
on conflict (id) do nothing;

-- Allow public read + admin-only write via service role (we call from the
-- serverless API with the service role key, so no extra policies needed).
-- =====================================================================
-- Row Level Security: the app talks to Supabase ONLY through the Vercel
-- serverless API using the service-role key (bypasses RLS), so we enable
-- RLS but keep it locked down by default.
-- =====================================================================
alter table public.users              enable row level security;
alter table public.unlocked_levels    enable row level security;
alter table public.sessions           enable row level security;
alter table public.lesson_content     enable row level security;
alter table public.lesson_access      enable row level security;
alter table public.tutor_sessions     enable row level security;
alter table public.posts              enable row level security;
alter table public.likes              enable row level security;
alter table public.comments           enable row level security;
alter table public.categories         enable row level security;
alter table public.custom_sessions    enable row level security;
alter table public.temp_sessions      enable row level security;
alter table public.public_sessions    enable row level security;
alter table public.test_sessions      enable row level security;
alter table public.test_codes         enable row level security;
alter table public.test_submissions   enable row level security;
alter table public.payment_links      enable row level security;
alter table public.contact_messages   enable row level security;
alter table public.media              enable row level security;
