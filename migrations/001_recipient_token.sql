-- Apply before deploying the recipient-token API changes.
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS recipient_token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS gifts_recipient_token_hash_key
  ON public.gifts (recipient_token_hash)
  WHERE recipient_token_hash IS NOT NULL;

-- Existing gifts have no recoverable recipient token. Handle them individually
-- before use; do not derive a token from gift_id.
