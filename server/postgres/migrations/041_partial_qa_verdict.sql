-- Qase PostgreSQL migration 041: completed QA sampling with coverage gaps.
ALTER TABLE qa_reports DROP CONSTRAINT qa_reports_verdict_valid;
ALTER TABLE qa_reports ADD CONSTRAINT qa_reports_verdict_valid
  CHECK (verdict IN ('pass', 'pass_with_issues', 'partial', 'fail', 'blocked'));
