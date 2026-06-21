-- Snorkel RAG Evaluation Pipeline — Supabase Schema
-- Run this in your Supabase SQL editor before activating the workflow

-- Table: eval_results
-- Stores production-ready evaluation run summaries (pass rate >= 90%)
CREATE TABLE IF NOT EXISTS eval_results (
    id              BIGSERIAL PRIMARY KEY,
    eval_run_id     TEXT        NOT NULL,
    pass_rate       INTEGER     NOT NULL,
    average_score   INTEGER,
    total_questions INTEGER,
    passed_count    INTEGER,
    status          TEXT        NOT NULL DEFAULT 'PRODUCTION_READY',
    evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: expert_corrections
-- Golden dataset — expert-adjudicated corrections for failed eval runs (pass rate < 90%)
CREATE TABLE IF NOT EXISTS expert_corrections (
    id                      BIGSERIAL PRIMARY KEY,
    eval_run_id             TEXT        NOT NULL,
    pass_rate               TEXT,
    root_cause              TEXT,
    corrected_ground_truth  TEXT,
    update_training_set     TEXT,
    expert_notes            TEXT,
    status                  TEXT        NOT NULL DEFAULT 'EXPERT_REVIEWED',
    submitted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_eval_results_run_id    ON eval_results (eval_run_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_status    ON eval_results (status);
CREATE INDEX IF NOT EXISTS idx_expert_corrections_run ON expert_corrections (eval_run_id);

-- Enable Row Level Security (recommended for Supabase)
ALTER TABLE eval_results      ENABLE ROW LEVEL SECURITY;
ALTER TABLE expert_corrections ENABLE ROW LEVEL SECURITY;

-- Policy: service role has full access (used by n8n via service key)
CREATE POLICY "service_role_all" ON eval_results
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all" ON expert_corrections
    FOR ALL USING (auth.role() = 'service_role');
