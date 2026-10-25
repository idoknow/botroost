BEGIN;
-- A single "QQ offline" observation used to open an incident immediately, so a probe that timed
-- out once paged the operator and recovered seconds later. The reconciler now holds the first
-- moment QQ was seen logged out and only opens the incident once that sample survives the
-- workspace grace window; 'offline-pending' records the held state so the console can tell
-- "logged out" from "suspected, waiting for the grace window".
ALTER TABLE qq_login_notification_state DROP CONSTRAINT qq_login_notification_state_state_check;
ALTER TABLE qq_login_notification_state ADD CONSTRAINT qq_login_notification_state_state_check CHECK(state IN ('unknown','online','offline','offline-pending'));
ALTER TABLE qq_login_notification_state ADD COLUMN offline_since timestamptz;
COMMIT;
