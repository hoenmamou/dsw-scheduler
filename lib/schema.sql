-- DSW Scheduler: Recommended Supabase Schema
-- Run these statements in the Supabase SQL Editor.
-- Each statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS to be safe to re-run.

-- ============================================================
-- CORE TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'supervisor',
  pin         TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.staff (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  active          BOOLEAN DEFAULT TRUE,
  notes           TEXT DEFAULT '',
  restrictions    TEXT DEFAULT '',
  unavailable_dates TEXT DEFAULT '[]',
  training_expiration DATE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.clients (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL DEFAULT '',
  supervisor_id       TEXT REFERENCES public.users(id),
  coverage_start      TEXT DEFAULT '07:00',
  coverage_end        TEXT DEFAULT '23:00',
  hours_allotted      NUMERIC DEFAULT 40,
  biweekly_hours      NUMERIC DEFAULT NULL, -- NULL = 2x weekly
  assigned_staff_ids  TEXT DEFAULT '[]',
  is_24_hour          BOOLEAN DEFAULT FALSE,
  active              BOOLEAN DEFAULT TRUE,
  service_notes       TEXT DEFAULT '',
  critical_flags      TEXT DEFAULT '',
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shifts (
  id              TEXT PRIMARY KEY,
  client_id       TEXT REFERENCES public.clients(id),
  staff_id        TEXT REFERENCES public.staff(id),
  start_iso       TEXT NOT NULL,
  end_iso         TEXT NOT NULL,
  created_by      TEXT DEFAULT 'unknown',
  is_shared       BOOLEAN DEFAULT FALSE,
  shared_group_id TEXT DEFAULT '',
  is_call_out     BOOLEAN DEFAULT FALSE,
  call_out_reason TEXT DEFAULT '',
  call_out_at     TIMESTAMPTZ,
  replacement_staff_id TEXT DEFAULT '',
  worked_start_iso TEXT DEFAULT '',
  worked_end_iso   TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- CALL-OUTS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.call_outs (
  id                    TEXT PRIMARY KEY,
  shift_id              TEXT REFERENCES public.shifts(id),
  client_id             TEXT REFERENCES public.clients(id),
  original_staff_id     TEXT REFERENCES public.staff(id),
  replacement_staff_id  TEXT,
  date                  TEXT NOT NULL,
  reason                TEXT DEFAULT '',
  status                TEXT DEFAULT 'open',  -- open | filled | cancelled
  created_by            TEXT DEFAULT 'unknown',
  created_at            TIMESTAMPTZ DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);

-- ============================================================
-- AUDIT LOGS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,         -- create | edit | delete | call_out | reassign
  table_name  TEXT NOT NULL,         -- shifts | clients | staff | call_outs
  record_id   TEXT NOT NULL,
  old_values  JSONB DEFAULT '{}',
  new_values  JSONB DEFAULT '{}',
  user_id     TEXT DEFAULT 'unknown',
  user_name   TEXT DEFAULT '',
  reason      TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- RECURRING TEMPLATES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.recurring_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  client_id       TEXT REFERENCES public.clients(id),
  template_type   TEXT DEFAULT 'weekly',  -- weekly | biweekly | rotation
  shift_pattern   JSONB DEFAULT '[]',
  staff_assignments JSONB DEFAULT '{}',
  created_by      TEXT DEFAULT 'unknown',
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- SAFE COLUMN ADDITIONS (for existing tables)
-- ============================================================

-- Shifts: call-out and worked hours support
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS is_call_out BOOLEAN DEFAULT FALSE;
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS call_out_reason TEXT DEFAULT '';
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS call_out_at TIMESTAMPTZ;
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS replacement_staff_id TEXT DEFAULT '';
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS worked_start_iso TEXT DEFAULT '';
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS worked_end_iso TEXT DEFAULT '';

-- Clients: biweekly and service fields
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS biweekly_hours NUMERIC DEFAULT NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS service_notes TEXT DEFAULT '';
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS critical_flags TEXT DEFAULT '';

-- Staff: extended fields
ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS restrictions TEXT DEFAULT '';
ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS unavailable_dates TEXT DEFAULT '[]';
ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS training_expiration DATE;

-- ============================================================
-- ROW LEVEL SECURITY (recommended, adjust to your auth model)
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_templates ENABLE ROW LEVEL SECURITY;

-- Permissive policies for anon key (MVP; tighten before production)
CREATE POLICY IF NOT EXISTS "anon_all_users" ON public.users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_staff" ON public.staff FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_clients" ON public.clients FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_shifts" ON public.shifts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_call_outs" ON public.call_outs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_audit_logs" ON public.audit_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_templates" ON public.recurring_templates FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_shifts_client ON public.shifts(client_id);
CREATE INDEX IF NOT EXISTS idx_shifts_staff ON public.shifts(staff_id);
CREATE INDEX IF NOT EXISTS idx_shifts_start ON public.shifts(start_iso);
CREATE INDEX IF NOT EXISTS idx_call_outs_date ON public.call_outs(date);
CREATE INDEX IF NOT EXISTS idx_call_outs_status ON public.call_outs(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_record ON public.audit_logs(record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at);
