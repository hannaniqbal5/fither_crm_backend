-- 014_phase15_welcome_assets.sql
-- Phase 15a — Admin-uploaded welcome assets.
-- Voice note (sent as msg 2 after a customer engages), poster image (sent as msg 3),
-- and optional caption text accompanying each.

CREATE TABLE IF NOT EXISTS welcome_assets (
  id            INT NOT NULL AUTO_INCREMENT,

  -- 'voice' — audio file (mp3/ogg/opus) sent as message #2 in first-touch flow
  -- 'poster' — image (jpg/png) sent as message #3 with class schedule + trainers
  asset_type    ENUM('voice','poster') NOT NULL,

  -- 'ur' = Roman Urdu speakers, 'en' = English speakers, 'both' = fallback
  language      ENUM('ur','en','both') NOT NULL DEFAULT 'both',

  -- Relative path under /uploads/welcome/ (e.g. "voice_ur_v3.ogg")
  file_name     VARCHAR(200) NOT NULL,
  file_path     VARCHAR(400) NOT NULL,   -- /uploads/welcome/<file_name>
  mime_type     VARCHAR(80)  NOT NULL,
  file_size     INT          NOT NULL,

  -- Caption text — accompanies the voice (so iPhone WhatsApp users see context if voice fails)
  -- or the poster (1-line description of what they're seeing)
  caption       VARCHAR(500) NULL,

  -- Only ONE asset of (type, language) can be active at a time
  is_active     BOOLEAN NOT NULL DEFAULT 0,

  uploaded_by   INT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_active_type_lang (is_active, asset_type, language)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tracking: how many leads have received each asset (lightweight log)
CREATE TABLE IF NOT EXISTS welcome_asset_sends (
  id            BIGINT NOT NULL AUTO_INCREMENT,
  asset_id      INT NOT NULL,
  lead_id       BIGINT NOT NULL,
  engagement_step TINYINT NOT NULL COMMENT '1=first, 2=voice, 3=poster',
  sent_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success       BOOLEAN NOT NULL DEFAULT 1,
  error_msg     VARCHAR(255) NULL,

  PRIMARY KEY (id),
  INDEX idx_lead (lead_id),
  INDEX idx_asset (asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add engagement_step to leads so we know where each lead is in the first-touch flow
ALTER TABLE leads
  ADD COLUMN engagement_step TINYINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT '0=no inbound yet, 1=first replied, 2=voice sent, 3=poster sent, 4+ = normal flow';
