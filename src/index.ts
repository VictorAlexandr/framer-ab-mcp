#!/usr/bin/env node
/**
 * framer-ab-mcp — MCP server for Framer A/B test analytics.
 *
 * Framer has no analytics API, but it stamps `?framer_variant=<id>` on the URL
 * of every visitor assigned to an A/B variant — which means GA4 already has
 * every number you need, split by variant. This server turns that into MCP
 * tools any AI client (Claude, Cursor, …) can call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { detectTests, testResults, topPages } from "./ga4.js";
import { evaluate } from "./stats.js";

const server = new McpServer({ name: "framer-ab-mcp", version: "0.1.0" });

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

server.tool(
  "list_ab_tests",
  "Detect running Framer A/B tests automatically: finds every landing page receiving " +
    "traffic with ?framer_variant= in the URL, grouped by page, with visitors and " +
    "conversions per variant. No configuration needed.",
  { days: z.number().int().min(1).max(365).default(30).describe("Lookback window in days") },
  async ({ days }) => {
    try {
      const tests = await detectTests(days);
      if (tests.length === 0) {
        return json({
          tests: [],
          note:
            `No framer_variant traffic found in the last ${days} days. ` +
            "Either no A/B test is running, the test just started (GA4 lags a few hours), " +
            "or the site does not send data to this GA4 property.",
        });
      }
      return json({ days, tests });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_test_results",
  "Full result table for one tested page: visitors, conversions and conversion rate " +
    "for every framer_variant plus the baseline (visitors without a variant stamp), " +
    "and a statistical verdict (two-proportion z-test, 95% confidence).",
  {
    basePath: z
      .string()
      .describe('Page path being tested, e.g. "/pricing" (no query string needed)'),
    days: z.number().int().min(1).max(365).default(30).describe("Lookback window in days"),
    controlVariantId: z
      .string()
      .optional()
      .describe(
        "framer_variant id of the CONTROL. Defaults to the baseline (no-variant) traffic, " +
          "or the highest-traffic variant if there is no baseline.",
      ),
    includeBaseline: z
      .boolean()
      .default(true)
      .describe("Include visitors that landed without any framer_variant in the comparison"),
  },
  async ({ basePath, days, controlVariantId, includeBaseline }) => {
    try {
      let rows = await testResults(basePath, days);
      if (!includeBaseline) rows = rows.filter((r) => r.variantId !== "(baseline)");
      if (rows.length === 0) {
        return json({ note: `No traffic found for ${basePath} in the last ${days} days.` });
      }
      const controlId =
        controlVariantId ??
        (rows.some((r) => r.variantId === "(baseline)") ? "(baseline)" : rows[0].variantId);
      const verdict = evaluate(
        rows.map((r) => ({
          name: r.variantId,
          visitors: r.visitors,
          conversions: r.conversions,
          isControl: r.variantId === controlId,
        })),
      );
      return json({ basePath, days, control: controlId, results: rows, verdict });
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "check_significance",
  "Run the statistical verdict on numbers you already have (e.g. copied from the Framer " +
    "panel): two-proportion z-test per variant vs control, uplift, confidence, and how " +
    "many visitors are still needed. First variant is the control unless flagged.",
  {
    variants: z
      .array(
        z.object({
          name: z.string(),
          visitors: z.number().int().min(0),
          conversions: z.number().int().min(0),
          isControl: z.boolean().optional(),
        }),
      )
      .min(2)
      .describe("2+ variants with their visitor and conversion counts"),
    mdeRelative: z
      .number()
      .min(0.01)
      .max(2)
      .default(0.3)
      .describe("Minimum detectable effect (relative), for the sample-size estimate"),
  },
  async ({ variants, mdeRelative }) => {
    try {
      return json(evaluate(variants, mdeRelative));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_top_pages",
  "Top landing pages of the site by visitors, with page views, conversions and " +
    "conversion rate — the quick health check before and after a test.",
  {
    days: z.number().int().min(1).max(365).default(30).describe("Lookback window in days"),
    limit: z.number().int().min(1).max(100).default(15).describe("Max pages to return"),
  },
  async ({ days, limit }) => {
    try {
      return json({ days, pages: await topPages(days, limit) });
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
