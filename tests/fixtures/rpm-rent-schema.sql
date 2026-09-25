-- Schema-only fixture from deployed RPM Rent, 2026-09-25. No customer data.
--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: BookingStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."BookingStatus" AS ENUM (
    'NEW',
    'IN_PROGRESS',
    'CONFIRMED',
    'DECLINED',
    'COMPLETED',
    'CANCELLED'
);


--
-- Name: TelegramOperatorRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TelegramOperatorRole" AS ENUM (
    'ADMIN',
    'OPERATOR'
);


--
-- Name: Booking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Booking" (
    id text NOT NULL,
    "carId" text NOT NULL,
    "startAt" date NOT NULL,
    "endAt" date NOT NULL,
    "pickupMethod" text NOT NULL,
    "deliveryAddress" text,
    "customerName" text NOT NULL,
    phone text NOT NULL,
    telegram text,
    "birthDate" date,
    "drivingExperienceMonths" integer,
    "additionalServiceIds" jsonb NOT NULL,
    comment text,
    "rentalDays" integer NOT NULL,
    "rentalPrice" integer NOT NULL,
    "additionalServicesPrice" integer NOT NULL,
    deposit integer NOT NULL,
    source text NOT NULL,
    utm jsonb,
    referrer text,
    "idempotencyKey" text NOT NULL,
    status public."BookingStatus" DEFAULT 'NEW'::public."BookingStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "carTitle" text NOT NULL,
    "licenseIssuedOn" date,
    "driverAgeAtStart" integer,
    "minimumAgeApplied" integer,
    "minimumExperienceApplied" integer,
    "minimumRentalDaysApplied" integer,
    "additionalServicesSnapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "pricePerDaySnapshot" integer NOT NULL,
    "privacyConsentAt" timestamp(3) without time zone,
    "integrityProtected" boolean DEFAULT true NOT NULL,
    "bookingNumber" integer NOT NULL,
    "originDomain" text,
    "managerComment" text,
    CONSTRAINT "Booking_deliveryAddress_required" CHECK ((("pickupMethod" <> 'delivery'::text) OR (length(TRIM(BOTH FROM COALESCE("deliveryAddress", ''::text))) >= 5))),
    CONSTRAINT "Booking_driver_snapshots_valid" CHECK (((("driverAgeAtStart" IS NULL) OR (("driverAgeAtStart" >= 18) AND ("driverAgeAtStart" <= 100))) AND ("drivingExperienceMonths" >= 0) AND (("minimumAgeApplied" IS NULL) OR (("minimumAgeApplied" >= 18) AND ("minimumAgeApplied" <= 100))) AND (("minimumExperienceApplied" IS NULL) OR ("minimumExperienceApplied" >= 0)) AND (("minimumRentalDaysApplied" IS NULL) OR (("minimumRentalDaysApplied" >= 1) AND ("minimumRentalDaysApplied" <= 366))))),
    CONSTRAINT "Booking_money_nonnegative" CHECK ((("pricePerDaySnapshot" >= 0) AND ("rentalPrice" >= 0) AND ("additionalServicesPrice" >= 0) AND (deposit >= 0))),
    CONSTRAINT "Booking_originDomain_check" CHECK ((("originDomain" IS NULL) OR ("originDomain" = ANY (ARRAY['rpm-rent.ru'::text, 'rpmrent.ru'::text])))),
    CONSTRAINT "Booking_period_valid" CHECK (("endAt" > "startAt")),
    CONSTRAINT "Booking_pickupMethod_valid" CHECK (("pickupMethod" = ANY (ARRAY['office'::text, 'delivery'::text]))),
    CONSTRAINT "Booking_rentalDays_valid" CHECK ((("rentalDays" >= 1) AND ("rentalDays" <= 366)))
);


--
-- Name: Booking_bookingNumber_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."Booking_bookingNumber_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: Booking_bookingNumber_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."Booking_bookingNumber_seq" OWNED BY public."Booking"."bookingNumber";


--
-- Name: Car; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Car" (
    id text NOT NULL,
    slug text NOT NULL,
    brand text NOT NULL,
    model text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    "bodyType" text NOT NULL,
    "vehicleClass" text NOT NULL,
    year integer,
    transmission text,
    engine text,
    horsepower integer,
    "driveType" text,
    seats integer,
    "shortDescription" text NOT NULL,
    description text NOT NULL,
    "pricePerDay" integer NOT NULL,
    "oldPrice" integer,
    deposit integer NOT NULL,
    "minimumAge" integer,
    "minimumDrivingExperience" integer,
    "mileageLimit" integer,
    "extraMileagePrice" integer,
    insurance text,
    features jsonb NOT NULL,
    "rentalConditions" jsonb NOT NULL,
    available boolean DEFAULT true NOT NULL,
    published boolean DEFAULT false NOT NULL,
    "isNew" boolean DEFAULT false NOT NULL,
    "isPromotion" boolean DEFAULT false NOT NULL,
    "isDemo" boolean DEFAULT true NOT NULL,
    "recommendedOrder" integer DEFAULT 0 NOT NULL,
    "seoTitle" text,
    "seoDescription" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "minimumRentalDays" integer,
    CONSTRAINT "Car_bookable_policy_complete" CHECK (((NOT (published AND available)) OR (("minimumAge" IS NOT NULL) AND ("minimumDrivingExperience" IS NOT NULL) AND ("minimumRentalDays" IS NOT NULL)))),
    CONSTRAINT "Car_deposit_nonnegative" CHECK ((deposit >= 0)),
    CONSTRAINT "Car_minimumAge_valid" CHECK ((("minimumAge" IS NULL) OR (("minimumAge" >= 18) AND ("minimumAge" <= 100)))),
    CONSTRAINT "Car_minimumExperience_valid" CHECK ((("minimumDrivingExperience" IS NULL) OR (("minimumDrivingExperience" >= 0) AND ("minimumDrivingExperience" <= 1200)))),
    CONSTRAINT "Car_minimumRentalDays_valid" CHECK ((("minimumRentalDays" IS NULL) OR (("minimumRentalDays" >= 1) AND ("minimumRentalDays" <= 366)))),
    CONSTRAINT "Car_oldPrice_nonnegative" CHECK ((("oldPrice" IS NULL) OR ("oldPrice" >= 0))),
    CONSTRAINT "Car_pricePerDay_nonnegative" CHECK ((("pricePerDay" >= 0) AND ("pricePerDay" <= 5000000))),
    CONSTRAINT "Car_vehicleClass_supported_check" CHECK (("vehicleClass" = ANY (ARRAY['Спорт'::text, 'Бизнес'::text, 'Премиум'::text])))
);


--
-- Name: TelegramOperator; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."TelegramOperator" (
    id text NOT NULL,
    "telegramUserId" text,
    username text NOT NULL,
    role public."TelegramOperatorRole" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: Booking bookingNumber; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Booking" ALTER COLUMN "bookingNumber" SET DEFAULT nextval('public."Booking_bookingNumber_seq"'::regclass);


--
-- Name: Booking Booking_no_overlapping_active_periods; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Booking"
    ADD CONSTRAINT "Booking_no_overlapping_active_periods" EXCLUDE USING gist ("carId" WITH =, daterange("startAt", "endAt", '[)'::text) WITH &&) WHERE ((("integrityProtected" = true) AND (status = ANY (ARRAY['NEW'::public."BookingStatus", 'IN_PROGRESS'::public."BookingStatus", 'CONFIRMED'::public."BookingStatus"]))));


--
-- Name: Booking Booking_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Booking"
    ADD CONSTRAINT "Booking_pkey" PRIMARY KEY (id);


--
-- Name: Car Car_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Car"
    ADD CONSTRAINT "Car_pkey" PRIMARY KEY (id);


--
-- Name: TelegramOperator TelegramOperator_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."TelegramOperator"
    ADD CONSTRAINT "TelegramOperator_pkey" PRIMARY KEY (id);


--
-- Name: Booking_bookingNumber_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Booking_bookingNumber_key" ON public."Booking" USING btree ("bookingNumber");


--
-- Name: Booking_carId_startAt_endAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Booking_carId_startAt_endAt_idx" ON public."Booking" USING btree ("carId", "startAt", "endAt");


--
-- Name: Booking_idempotencyKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Booking_idempotencyKey_key" ON public."Booking" USING btree ("idempotencyKey");


--
-- Name: Car_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Car_slug_key" ON public."Car" USING btree (slug);


--
-- Name: TelegramOperator_telegramUserId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "TelegramOperator_telegramUserId_key" ON public."TelegramOperator" USING btree ("telegramUserId");


--
-- Name: TelegramOperator_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "TelegramOperator_username_key" ON public."TelegramOperator" USING btree (username);


--
-- Name: Booking Booking_carId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Booking"
    ADD CONSTRAINT "Booking_carId_fkey" FOREIGN KEY ("carId") REFERENCES public."Car"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
