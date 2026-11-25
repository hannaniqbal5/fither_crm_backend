-- 041_monitoring.sql — error monitoring, job locks/heartbeats, send-gate log.
-- All additive. The code also creates these tables if they are missing, so
-- deploy order doesn't matter.

-- One row per distinct error message (numbers/ids normalised), counted.
CREATE TABLE IF NOT EXISTS system_errors (
  sig_hash    CHAR(40)     NOT NULL PRIMARY KEY,
  signature   VARCHAR(255) NOT NULL,
  sample      TEXT         NULL,
  process     VARCHAR(40)  NULL,
  count       INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen  DATETIME     NOT NULL,
  last_seen   DATETIME     NOT NULL,
  INDEX idx_last_seen (last_seen)
);

-- A scheduled job runs in one process at a time (lease-style lock).
CREATE TABLE IF NOT EXISTS job_locks (
  name          VARCHAR(80)  NOT NULL PRIMARY KEY,
  owner         VARCHAR(120) NOT NULL,
  locked_until  DATETIME     NOT NULL
);

-- Last run of every job, per process.
CREATE TABLE IF NOT EXISTS job_heartbeats (
  name          VARCHAR(80)  NOT NULL,
  host          VARCHAR(80)  NOT NULL,
  role          VARCHAR(20)  NOT NULL,
  last_start    DATETIME     NULL,
  last_ok       DATETIME     NULL,
  last_error    VARCHAR(500) NULL,
  last_error_at DATETIME     NULL,
  last_ms       INT UNSIGNED NULL,
  runs          INT UNSIGNED NOT NULL DEFAULT 0,
  fails         INT UNSIGNED NOT NULL DEFAULT 0,
  skips         INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at    DATETIME     NOT NULL,
  PRIMARY KEY (name, host, role)
);

-- Every proactive send the gate looked at, with what it decided (and what it
-- WOULD have blocked in monitor mode), so the limits can be reviewed before
-- switching gate_mode to 'enforce'.
CREATE TABLE IF NOT EXISTS send_gate_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lead_id     INT UNSIGNED NULL,
  account_id  INT UNSIGNED NULL,
  source      VARCHAR(30)  NULL,
  mode        VARCHAR(20)  NOT NULL,
  allowed     TINYINT(1)   NOT NULL,
  reason      VARCHAR(60)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_reason (reason, created_at)
);
