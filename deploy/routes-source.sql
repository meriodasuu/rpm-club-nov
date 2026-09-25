-- Run as owner in RPM Rent. Uses the existing read-only catalog role.
BEGIN;
CREATE OR REPLACE VIEW rpm_club_catalog.routes AS
SELECT jsonb_build_object('id',id,'slug',slug,'title',title,'subtitle',subtitle,
  'description',description,'address',address,'mapUrl',"mapUrl",'directions',directions,
  'workingHours',"workingHours",'image',image,'images',images,'published',published,'sortOrder',"sortOrder") AS route
FROM public."Location";
REVOKE ALL ON rpm_club_catalog.routes FROM PUBLIC;
GRANT SELECT ON rpm_club_catalog.routes TO rpm_club_catalog_reader;
DROP TRIGGER IF EXISTS rpm_club_routes_changed ON public."Location";
CREATE TRIGGER rpm_club_routes_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public."Location"
  FOR EACH STATEMENT EXECUTE FUNCTION rpm_club_catalog.changed();
COMMIT;
