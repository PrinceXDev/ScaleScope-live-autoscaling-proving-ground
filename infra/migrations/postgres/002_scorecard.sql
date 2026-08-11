-- The Autoscaler Report Card: one jsonb projection of computeScorecard()
-- per run, written once at finalisation. Nullable because runs finalised
-- before this migration -- and any run a scorecard can't yet be computed
-- for -- simply have no card rather than a fabricated one.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS scorecard jsonb;
