-- One-way broadcast submission and login-throttle identity.
-- Additive only. Does not rewrite 0001–0006.

ALTER TABLE launch_jobs
  ADD COLUMN IF NOT EXISTS submit_attempted_at TIMESTAMPTZ;

COMMENT ON COLUMN launch_jobs.submit_attempted_at IS
  'Set in the same statement that enters submitting, before the provider send. Immutable. A non-null value means the broadcast must never be submitted again automatically.';

CREATE OR REPLACE FUNCTION launch_jobs_protect_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.submit_attempted_at IS NOT NULL
     AND NEW.submit_attempted_at IS DISTINCT FROM OLD.submit_attempted_at THEN
    RAISE EXCEPTION 'submit_attempted_at is immutable once recorded';
  END IF;

  IF OLD.status = 'completed' AND NEW.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'a completed launch job cannot be reopened';
  END IF;

  IF OLD.status IN (
       'submitting', 'submission_unknown', 'reconciling',
       'completed', 'manual_review', 'cancelled'
     )
     AND NEW.status IN ('pending', 'running', 'ready_to_submit') THEN
    RAISE EXCEPTION 'launch job cannot return to a sendable state from %', OLD.status;
  END IF;

  IF OLD.submit_attempted_at IS NOT NULL
     AND NEW.status IN ('pending', 'running', 'ready_to_submit') THEN
    RAISE EXCEPTION 'a launch job with a recorded submission attempt cannot become sendable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS launch_jobs_protect_submission ON launch_jobs;
CREATE TRIGGER launch_jobs_protect_submission
  BEFORE UPDATE ON launch_jobs
  FOR EACH ROW
  EXECUTE FUNCTION launch_jobs_protect_submission();

ALTER TABLE login_attempts
  ADD COLUMN IF NOT EXISTS account_key TEXT;

CREATE INDEX IF NOT EXISTS login_attempts_account_time_idx
  ON login_attempts (account_key, attempted_at);
