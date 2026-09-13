import { describe, expect, it } from "vitest";
import {
  badgeTone,
  freemiusCards,
  licenseState,
  safeLink,
} from "../src/shared/customer-data";
import { callbackFixture } from "./fixtures/customer-sidebar";
import { cleanHtml } from "../src/worker/mail";

describe("customer sidebar presentation", () => {
  it("extracts the customer, per-site entitlement, and exact environment fields from the sanitized callback", () => {
    const result = freemiusCards(cleanHtml(callbackFixture))!;
    expect(result.name).toBe("Elena Martin");
    expect(result.id).toBe("123");
    expect(result.facts).toEqual([
      { label: "Lifetime value", value: "$191.76" },
      {
        label: "Billing email",
        value: "elena@example.test",
        href: "mailto:elena@example.test",
      },
      { label: "Joined", value: "Mar 23, 2026 GMT" },
      {
        label: "",
        value: "Review link",
        href: "https://dashboard.freemius.com/review/12345/example",
      },
    ]);
    expect(result.sites).toHaveLength(6);
    expect(result.sites[0]).toMatchObject({
      id: "100",
      title: "Customer website",
      plan: "Professional Plan",
      license: "Active",
      edition: "Premium Version",
    });
    expect(result.sites[0].environment).toEqual([
      { label: "Plugin Version", value: "2.4.78" },
      { label: "PHP Version", value: "8.3.33" },
      { label: "WordPress Version", value: "7.1" },
      { label: "SDK Version", value: "2.13.4" },
      { label: "Language", value: "en-US" },
    ]);
    expect(result.sites[1].license).toBe("Active (lifetime)");
    expect(result.sites[2].license).toBe("Expired");
    expect(result.sites[5].plan).toBe("Free Plan");
    expect(result.additional).toEqual([]);
  });
  it("does not invent a plan or license and preserves additional provider details", () => {
    const html =
      callbackFixture.replaceAll(
        "<h4>License: <span>Active</span></h4>",
        "<h4>Quota: 3 websites</h4>",
      ) + "<h4>Account note: Email verified</h4>";
    const result = freemiusCards(html)!;
    expect(result.sites[0].license).toBeUndefined();
    expect(result.sites[0].facts).toContainEqual({
      label: "Quota",
      value: "3 websites",
    });
    expect(result.additional).toContainEqual({
      label: "Account note",
      value: "Email verified",
    });
    expect(freemiusCards("<p>Customer record changed format</p>")).toBeNull();
    expect(freemiusCards("<p>User doesn't exist.</p>")).toBeNull();
  });
  it("keeps inactive, expired, unsubscribed, trial and unknown statuses distinct", () => {
    expect(badgeTone("Inactive")).toBe("negative");
    expect(badgeTone("Expired / inactive")).toBe("negative");
    expect(badgeTone("Unsubscribed")).toBe("negative");
    expect(badgeTone("Renewal cancelled")).toBe("warning");
    expect(badgeTone("Trial")).toBe("warning");
    expect(badgeTone("Active (lifetime)")).toBe("positive");
    expect(badgeTone("Premium Version")).toBe("info");
    expect(badgeTone("Unknown")).toBe("neutral");
  });
  it("does not infer active licenses from invalid expiry dates or renewal cancellation", () => {
    expect(licenseState({ expiration: "not-a-date" })).toBeUndefined();
    expect(licenseState({})).toBeUndefined();
    expect(licenseState({ expiration: null })).toBe("Active (lifetime)");
    expect(
      licenseState(
        { expiration: "2030-01-01 00:00:00", canceled_at: "2026-09-01" },
        Date.UTC(2026, 8, 12),
      ),
    ).toBe("Active");
    expect(
      licenseState(
        { expiration: "2026-09-12 12:00:00" },
        Date.UTC(2026, 8, 12, 12),
      ),
    ).toBe("Expired");
    expect(licenseState({ expiration: null, is_cancelled: true })).toBe(
      "Inactive",
    );
  });
  it("rejects unsafe links and fake provider profiles while rendering untrusted labels only as text", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,test",
      "//evil.test",
      "#",
      "https://name:password@example.test",
    ])
      expect(safeLink(value)).toBeUndefined();
    expect(
      freemiusCards(
        callbackFixture.replaceAll(
          "dashboard.freemius.com",
          "freemius.example.test",
        ),
      ),
    ).toBeNull();
    const result = freemiusCards(
      cleanHtml(
        callbackFixture.replace(
          "Customer website (100)",
          "&lt;img src=x onerror=evil()&gt; (100)",
        ),
      ),
    )!;
    expect(result.sites[0].title).toBe("<img src=x onerror=evil()>");
  });
});
