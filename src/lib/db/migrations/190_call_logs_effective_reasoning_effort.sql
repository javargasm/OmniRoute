-- 186: persist Kiro's effective upstream reasoning effort for call-log list rows.
-- NULL preserves the distinction between unavailable telemetry and an explicit effort.

ALTER TABLE call_logs ADD COLUMN effective_reasoning_effort TEXT DEFAULT NULL;
