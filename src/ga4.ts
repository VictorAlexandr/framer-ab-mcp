/**
 * GA4 Data API client — the entire data layer of framer-ab-mcp.
 *
 * Why GA4? Framer stamps `?framer_variant=<id>` on the URL of every visitor
 * assigned to an A/B variant, so GA4's `landingPagePlusQueryString` dimension
 * already separates variants. No Framer private API, no scraping.
 */
import { GoogleAuth, UserRefreshClient } from "google-auth-library";

const API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export function propertyId(): string {
  const id = process.env.GA4_PROPERTY_ID?.trim();
  if (!id) throw new Error("Set GA4_PROPERTY_ID (the numeric GA4 property id).");
  return id.replace(/^properties\//, "");
}

/** OAuth refresh token trio (personal) or Application Default Credentials (service account). */
async function accessToken(): Promise<string> {
  const { GA4_CLIENT_ID, GA4_CLIENT_SECRET, GA4_REFRESH_TOKEN } = process.env;
  if (GA4_REFRESH_TOKEN) {
    const client = new UserRefreshClient(GA4_CLIENT_ID, GA4_CLIENT_SECRET, GA4_REFRESH_TOKEN);
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Could not exchange GA4_REFRESH_TOKEN for an access token.");
    return token;
  }
  const auth = new GoogleAuth({ scopes: [SCOPE] });
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error(
      "No GA4 credentials. Either set GA4_CLIENT_ID/GA4_CLIENT_SECRET/GA4_REFRESH_TOKEN " +
        "or point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON with Viewer access to the property.",
    );
  }
  return token;
}

interface ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

export async function runReport(body: Record<string, unknown>): Promise<ReportRow[]> {
  const token = await accessToken();
  const res = await fetch(`${API}/properties/${propertyId()}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = (await res.json()) as { rows?: ReportRow[] };
  return data.rows ?? [];
}

const n = (v: string | undefined) => Number(v ?? 0) || 0;

export interface VariantTraffic {
  /** Framer variant id from the URL (e.g. "dXmgUoIf7"), or "(baseline)" for the bare path. */
  variantId: string;
  landingPage: string;
  visitors: number;
  conversions: number;
}

export interface DetectedTest {
  basePath: string;
  variants: VariantTraffic[];
  totalVariantVisitors: number;
}

/** Landing pages carrying ?framer_variant=, grouped by base path → running A/B tests. */
export async function detectTests(days: number): Promise<DetectedTest[]> {
  const rows = await runReport({
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [{ name: "totalUsers" }, { name: "conversions" }],
    dimensionFilter: {
      filter: {
        fieldName: "landingPagePlusQueryString",
        stringFilter: { matchType: "CONTAINS", value: "framer_variant" },
      },
    },
    limit: "1000",
  });

  const byPath = new Map<string, Map<string, VariantTraffic>>();
  for (const row of rows) {
    const landing = row.dimensionValues?.[0]?.value ?? "";
    const m = landing.match(/^([^?]*)\?.*framer_variant=([^&]+)/);
    if (!m) continue;
    const [, basePath, variantId] = m;
    const path = basePath || "/";
    const perVariant = byPath.get(path) ?? new Map<string, VariantTraffic>();
    // Same variant can appear under many query combos (utm, fbclid…) — aggregate.
    const cur = perVariant.get(variantId) ?? {
      variantId,
      landingPage: `${path}?framer_variant=${variantId}`,
      visitors: 0,
      conversions: 0,
    };
    cur.visitors += n(row.metricValues?.[0]?.value);
    cur.conversions += n(row.metricValues?.[1]?.value);
    perVariant.set(variantId, cur);
    byPath.set(path, perVariant);
  }

  return Array.from(byPath.entries())
    .map(([basePath, perVariant]) => {
      const variants = Array.from(perVariant.values()).sort((a, b) => b.visitors - a.visitors);
      return {
        basePath,
        variants,
        totalVariantVisitors: variants.reduce((s, v) => s + v.visitors, 0),
      };
    })
    .sort((a, b) => b.totalVariantVisitors - a.totalVariantVisitors);
}

/**
 * Full traffic split of one tested page: every framer_variant + the baseline
 * (visitors landing on the page with no variant stamp).
 */
export async function testResults(basePath: string, days: number): Promise<VariantTraffic[]> {
  const path = basePath.split("?")[0].replace(/\/+$/, "") || "/";
  const rows = await runReport({
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [{ name: "totalUsers" }, { name: "conversions" }],
    dimensionFilter: {
      filter: {
        fieldName: "landingPagePlusQueryString",
        stringFilter: { matchType: "BEGINS_WITH", value: path },
      },
    },
    limit: "5000",
  });

  const acc = new Map<string, VariantTraffic>();
  for (const row of rows) {
    const landing = row.dimensionValues?.[0]?.value ?? "";
    const rowPath = (landing.split("?")[0] || "/").replace(/\/+$/, "") || "/";
    if (rowPath !== path) continue; // BEGINS_WITH also matches sub-paths — drop them
    const variantId = landing.match(/framer_variant=([^&]+)/)?.[1] ?? "(baseline)";
    const cur = acc.get(variantId) ?? {
      variantId,
      landingPage: variantId === "(baseline)" ? path : `${path}?framer_variant=${variantId}`,
      visitors: 0,
      conversions: 0,
    };
    cur.visitors += n(row.metricValues?.[0]?.value);
    cur.conversions += n(row.metricValues?.[1]?.value);
    acc.set(variantId, cur);
  }
  return Array.from(acc.values()).sort((a, b) => b.visitors - a.visitors);
}

export interface PageStats {
  path: string;
  visitors: number;
  pageViews: number;
  conversions: number;
  conversionRatePct: number;
}

/** Top landing pages of the property — the "how is the site doing" tool. */
export async function topPages(days: number, limit: number): Promise<PageStats[]> {
  const rows = await runReport({
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
    dimensions: [{ name: "landingPage" }],
    metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
    limit: String(limit),
  });
  return rows
    .map((row) => {
      const visitors = n(row.metricValues?.[0]?.value);
      const conversions = n(row.metricValues?.[2]?.value);
      return {
        path: row.dimensionValues?.[0]?.value ?? "/",
        visitors,
        pageViews: n(row.metricValues?.[1]?.value),
        conversions,
        conversionRatePct: visitors > 0 ? Math.round((conversions / visitors) * 1000) / 10 : 0,
      };
    })
    .filter((p) => p.path !== "(not set)");
}
