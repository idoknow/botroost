BEGIN;
-- The SnowLuma artifact id the connected agent's allowlist accepts, reported on claim.
-- Commands carrying the new runtime image are only dispatched to nodes whose agent has
-- reported this exact artifact; legacy agents leave it NULL and keep serving the old
-- runtime until they are upgraded, instead of failing every operation fleet-wide.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS snowluma_artifact text;
COMMIT;
