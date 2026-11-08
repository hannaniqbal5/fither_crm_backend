-- 015_phase17_voice_transcript.sql
-- Phase 17 — store transcripts of voice notes so they can be re-read,
-- searched, and used as Fiza's input text without re-transcribing.

ALTER TABLE messages
  ADD COLUMN voice_transcript      TEXT NULL
    COMMENT 'Gemini-generated transcript of audio/voice messages',
  ADD COLUMN voice_transcript_lang VARCHAR(10) NULL
    COMMENT 'Detected language: ur, en, mixed, etc.',
  ADD COLUMN voice_confidence      DECIMAL(4,3) NULL
    COMMENT 'Gemini confidence 0..1 for the transcript',
  ADD COLUMN voice_transcribed_at  DATETIME NULL;

-- Flag on ai_replies so the UI can highlight drafts that came from voice
ALTER TABLE ai_replies
  ADD COLUMN source_was_voice BOOLEAN NOT NULL DEFAULT 0
    COMMENT 'TRUE if the inbound message was a voice note (Tier 2 forced)';
