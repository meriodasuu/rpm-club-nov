-- Apply only to RPM Rent's database as its owner. The login is provisioned separately.
BEGIN;
CREATE SCHEMA IF NOT EXISTS rpm_club_catalog;
REVOKE ALL ON SCHEMA rpm_club_catalog FROM PUBLIC;
CREATE OR REPLACE VIEW rpm_club_catalog.cars AS
SELECT jsonb_build_object(
  'id',c.id,'slug',c.slug,'title',c.title,'brand',c.brand,'model',c.model,
  'bodyType',c."bodyType",'vehicleClass',c."vehicleClass",'year',c.year,
  'transmission',c.transmission,'engine',c.engine,'horsepower',c.horsepower,
  'driveType',c."driveType",'seats',c.seats,
  'shortDescription',c."shortDescription",'description',c.description,
  'pricePerDay',c."pricePerDay",'minimumRentalDays',c."minimumRentalDays",
  'minimumAge',c."minimumAge",'minimumDrivingExperience',c."minimumDrivingExperience",'mileageLimit',c."mileageLimit",
  'extraMileagePrice',c."extraMileagePrice",'insurance',c.insurance,
  'features',c.features,'rentalConditions',c."rentalConditions",
  'available',c.available,'published',c.published,'isDemo',c."isDemo",
  'recommendedOrder',c."recommendedOrder",
  'images',coalesce((SELECT jsonb_agg(jsonb_build_object('url',i.url,'alt',i.alt) ORDER BY i."sortOrder",i.id) FROM public."CarImage" i WHERE i."carId"=c.id),'[]'::jsonb)
) AS car FROM public."Car" c;
REVOKE ALL ON rpm_club_catalog.cars FROM PUBLIC;
GRANT USAGE ON SCHEMA rpm_club_catalog TO rpm_club_catalog_reader;
GRANT SELECT ON rpm_club_catalog.cars TO rpm_club_catalog_reader;
CREATE OR REPLACE FUNCTION rpm_club_catalog.changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('rpm_club_catalog_changed','');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION rpm_club_catalog.changed() FROM PUBLIC;
DROP TRIGGER IF EXISTS rpm_club_catalog_changed ON public."Car";
CREATE TRIGGER rpm_club_catalog_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public."Car" FOR EACH STATEMENT EXECUTE FUNCTION rpm_club_catalog.changed();
DROP TRIGGER IF EXISTS rpm_club_catalog_images_changed ON public."CarImage";
CREATE TRIGGER rpm_club_catalog_images_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public."CarImage" FOR EACH STATEMENT EXECUTE FUNCTION rpm_club_catalog.changed();
COMMIT;
