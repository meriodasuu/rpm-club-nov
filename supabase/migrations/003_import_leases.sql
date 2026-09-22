ALTER TABLE import_batches ADD COLUMN lease_token text;
CREATE INDEX import_rows_pending_idx ON import_rows(batch_id,status);
CREATE UNIQUE INDEX users_crm_customer_unique ON users(crm_customer_id) WHERE crm_customer_id IS NOT NULL;
