import { describe, expect, it } from "vitest";
import { peerStateSchema } from "../src/lib/club/rpm-rent";

describe("RPM Rent booking state", () => {
  it("accepts PostgreSQL timestamp values returned as Date objects", () => {
    const updatedAt = new Date("2026-10-19T15:51:43.588Z");

    expect(
      peerStateSchema.parse({
        id: "booking-1",
        number: 65,
        status: "NEW",
        note: null,
        updated_at: updatedAt,
      }).updated_at,
    ).toBe(updatedAt);
  });
});
