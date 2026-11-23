-- 037: Number upload batches — ad-lead number management system.
--
-- Managers upload Excel/CSV files of phone numbers from ad campaigns.
-- Each upload is a "batch". Numbers inside are categorised as paid/unpaid.

CREATE TABLE IF NOT EXISTS number_batches (
  id              INT          NOT NULL AUTO_INCREMENT,
  name            VARCHAR(200) NOT NULL COMMENT 'Batch label, e.g. "Nov FB Ads"',
  category        ENUM('paid','unpaid') NOT NULL DEFAULT 'unpaid' COMMENT 'Default category for all numbers in this batch',
  original_file   VARCHAR(300) NULL COMMENT 'Original uploaded filename',
  total_numbers   INT          NOT NULL DEFAULT 0,
  paid_count      INT          NOT NULL DEFAULT 0,
  unpaid_count    INT          NOT NULL DEFAULT 0,
  notes           TEXT         NULL,
  created_by      INT          NULL COMMENT 'Admin who uploaded',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_nb_created (created_at),
  INDEX idx_nb_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS number_entries (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  batch_id        INT          NOT NULL,
  phone           VARCHAR(30)  NOT NULL COMMENT 'Phone number as imported (cleaned of spaces/dashes)',
  phone_last10    VARCHAR(10)  NOT NULL COMMENT 'Last 10 digits for dedup/search',
  name            VARCHAR(150) NULL COMMENT 'Name from the spreadsheet if available',
  category        ENUM('paid','unpaid') NOT NULL DEFAULT 'unpaid',
  extra_data      JSON         NULL COMMENT 'Any other columns from the spreadsheet',
  notes           VARCHAR(500) NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ne_batch (batch_id),
  INDEX idx_ne_phone (phone_last10),
  INDEX idx_ne_category (category),
  INDEX idx_ne_batch_cat (batch_id, category),
  CONSTRAINT fk_ne_batch FOREIGN KEY (batch_id) REFERENCES number_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
