ALTER TABLE club_content
  ADD COLUMN source text,
  ADD COLUMN source_id text,
  ADD COLUMN source_deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN source_synced_at timestamptz,
  ADD COLUMN image_urls jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN available boolean NOT NULL DEFAULT true,
  ADD COLUMN minimum_rental_days integer NOT NULL DEFAULT 1 CHECK(minimum_rental_days BETWEEN 1 AND 90),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX club_content_source ON club_content(source,source_id);
ALTER TABLE club_content ADD CONSTRAINT club_content_source_pair CHECK((source IS NULL)=(source_id IS NULL));
