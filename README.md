# framer-ab-mcp

**The first MCP server for Framer A/B test analytics.** Ask your AI assistant "how is my A/B test doing?" and get real numbers — visitors, conversions, uplift and statistical significance per variant — straight from your data.

Framer has **no analytics API** ([the community has been asking since 2024](https://www.framer.community/c/support/analytics-export)). This server closes the gap **without scraping and without private APIs**, using a detail most people miss:

> Framer decides the variant at the edge and reports it back in a **`Server-Timing` response header** — readable by your own page through the standard Navigation Timing API. A 15-line snippet writes it into the URL, and from there **GA4 tracks every variant separately**, through an official Google API.

See [Native A/B tests](#native-ab-tests-same-url) for the one-time setup.

## Tools

| Tool | What it answers |
|---|---|
| `list_ab_tests` | "Which A/B tests are running?" — auto-detects every page with `framer_variant` traffic, zero config |
| `get_test_results` | "How is the test on /pricing doing?" — visitors, conversions, rate per variant + z-test verdict |
| `check_significance` | "Is this result significant?" — two-proportion z-test on any numbers (95% confidence, uplift, sample size needed) |
| `get_top_pages` | "How are my landing pages doing?" — top pages with visitors, views and conversion rate |

## Native A/B tests (same URL)

Framer's built-in A/B test serves every variant on the **same URL** — so out of the box GA4 sees one page, not three. Framer does expose the assignment, though, in the response headers:

```
server-timing: route;desc="id=HzCk8JwdA&locale=default",
               abtests;desc="fTtDReMMT=HzCk8JwdA&ZC0Z4uM6O=U8HpLpLm1"
```

`route → id=` is the variant served on this page; `abtests` lists `testId=variantId` for every running test. Paste [`snippet/framer-variant-to-url.js`](snippet/framer-variant-to-url.js) into **Site Settings → Custom Code → Start of `<head>`** and it stamps `?framer_variant=<id>` on the URL *before* GA4 fires its page view. No GA4 configuration, no custom dimensions.

- Pages that aren't under test are left untouched.
- Framer already preserves this parameter across internal links (its own `data-preserve-internal-params` script handles `framer_variant` by name), so you're using a parameter the platform understands.
- Trade-off: the parameter becomes visible in the address bar, and sharing that link forces the recipient into that variant — Framer's own behaviour for variant links.

Verified in a headless browser: the assignment is readable during `<head>` execution, before the analytics page view.

## Requirements

- A Framer site with **Google Analytics 4** connected (Site Settings → Integrations)
- Node 18+
- GA4 API credentials (2 minutes, below)

## Setup

### 1. GA4 credentials — pick one

**Service account (recommended):**
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project → enable the **Google Analytics Data API** → create a **Service Account** → download the JSON key.
2. In GA4 → Admin → Property access management → add the service account email as **Viewer**.
3. Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`.

**OAuth refresh token** (if you already have one): set `GA4_CLIENT_ID`, `GA4_CLIENT_SECRET`, `GA4_REFRESH_TOKEN`.

Either way, also set `GA4_PROPERTY_ID` (the numeric id in GA4 → Admin → Property details).

### 2. Add to your MCP client

**Claude Code** (`claude mcp add`) or any client, config style:

```json
{
  "mcpServers": {
    "framer-ab": {
      "command": "npx",
      "args": ["-y", "framer-ab-mcp"],
      "env": {
        "GA4_PROPERTY_ID": "123456789",
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/key.json"
      }
    }
  }
}
```

### 3. Ask

> *"List my running A/B tests"* · *"Is variant B beating control on the pricing page?"* · *"How many more visitors until this test is conclusive?"*

## How it works (and what it can't do)

```
Framer A/B test ──► visitor URL gets ?framer_variant=<id>
                          │
                          ▼
GA4 landingPagePlusQueryString  ──►  this MCP server  ──►  your AI client
(official Google API)                (variant split + z-test)
```

- **Conversions** are GA4 key events. Mark your lead/purchase event as a key event in GA4 and the numbers here match your funnel.
- **Baseline traffic** (visitors without a `framer_variant` stamp, e.g. from before the test) is reported separately and used as control by default — you can override with `controlVariantId`.
- **Not covered**: Framer's panel-only metrics (native funnels, per-CTA click tracking). Those have no API; this project deliberately doesn't scrape them.

## Development

```bash
npm install
npm run dev     # runs the server on stdio via tsx
npm run build   # compiles to dist/
```

MIT © Victor Alexandre
