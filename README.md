# Company Contact Details Extractor MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-company-contact-details-extractor)](https://smithery.ai/servers/mambabuilt/mcp-company-contact-details-extractor) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-company-contact-details-extractor/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-company-contact-details-extractor) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-company-contact-details-extractor%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-company-contact-details-extractor&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-company-contact-details-extractor)](https://www.npmjs.com/package/@mambalabsdev/mcp-company-contact-details-extractor) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-company-contact-details-extractor)](https://www.npmjs.com/package/@mambalabsdev/mcp-company-contact-details-extractor) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-company-contact-details-extractor)](https://github.com/mambalabsdev/mcp-company-contact-details-extractor/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-company-contact-details-extractor)

An MCP server that finds a company contact page and extracts role emails, a phone number and a postal address. It wraps the Mamba Labs Company Contact Details Extractor actor on Apify and returns a Clay-ready flat JSON row to any MCP client.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Inputs](#inputs)
- [Output](#output)
- [Example output](#example-output)
- [Features](#features)
- [Full actor documentation](#full-actor-documentation)
- [Mamba Labs GTM Suite](#mamba-labs-gtm-suite)
- [License](#license)

## What it does

Give it a company domain and it finds that company's contact page, then returns the role email addresses published on it, a main phone number in E.164 where the country resolves, and a postal address. One flat row per company.

Named individuals are never returned. An address is kept only when its domain belongs to the company and its local part is in the role vocabulary, so `info@`, `support@`, `sales@` and `privacy@` survive and a person's address is dropped by an allow list rather than by a name detector. The row reports how many addresses were found and how many were rejected and why, so a thin result is never mistaken for a site that publishes nothing.

All of the extraction runs on Apify. This package is a thin client that calls the actor and hands back the result unchanged.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mamba-company-contact-details-extractor": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-company-contact-details-extractor"],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Get your token at https://console.apify.com/account/integrations, paste it in, and restart Claude Desktop. The `extract_company_contact_details` tool will be available.

## Prerequisites

- Node.js 18 or newer
- An Apify account with an API token

## Example prompts

- "Find the contact details for stripe.com."
- "Get the sales email for figma.com and skip the phone number."
- "Pull contact details for this local plumbing company and allow free mailboxes."
- "Extract the support address for notion.com, reading a second page if the contact page has nothing."

## Inputs

- `company_domain` (optional): bare company domain, for example `stripe.com`. This is the lookup key and the join key for every other actor in the fleet.
- `company_name` (optional): used in the row and in logging. This tool gates addresses on the email domain rather than on the company name, so supplying a name does not change which addresses are kept.
- `emailTypes` (optional): which classes of role address to return. One of `all`, `general`, `support`, `sales`, `privacy`, `general_support` or `sales_only`. `all` is the default and returns general, support, sales and privacy. The narrower settings return only what they name and leave the other columns null, which is a different answer from not finding one.
- `includePhones` (optional): when true (the default) the contact page is scanned for a main phone number. Set false to skip phone extraction entirely.
- `includeAddress` (optional): when true (the default) a postal address is read from JSON-LD first and from the footer second. Set false to skip it.
- `allowFreeMailboxes` (optional): when false (the default) an address at Gmail, Outlook or another free provider is rejected, because it cannot be checked against the company domain. Set true for small business and local company lists, where a free mailbox on the contact page is often the real contact point.
- `crawlDepth` (optional): how many pages to read after the homepage. `1` (the default) reads the contact page. `2` also reads a support or legal page when the contact page yielded nothing. This is a cost and thoroughness dial, not a change of answer.
- `skipCache` (optional): when false (the default) a successful lookup is cached for seven days and reused. Set true to force a fresh fetch.

## Output

The tool returns the actor's flat JSON row for the company, with 25 snake_case fields and no nested objects. `emails_rejected_count` and `emails_rejected_reasons` account for what was dropped, `contact_page_method` says how the contact page was found, and `fetch_status` says whether the read succeeded. See the Apify Store page for the full output schema.

## Example output

```json
{
  "degraded": false,
  "degradation_reason": null,
  "company_domain": "stripe.com",
  "company_name": "Stripe",
  "contact_page_url": "https://stripe.com/contact/sales",
  "contact_page_method": "footer_anchor",
  "contact_page_confidence": 0.85,
  "email_general": null,
  "email_support": null,
  "email_sales": "sales@stripe.com",
  "email_privacy": null,
  "emails_found_count": 7,
  "emails_rejected_count": 6,
  "emails_rejected_reasons": "foreign_domain=5, not_a_role_address=1",
  "phone_main": null,
  "phone_source": null,
  "address_line": null,
  "address_city": null,
  "address_country": null,
  "contact_form_url": null,
  "pages_read": 2,
  "coverage": 0.2,
  "fetch_status": "ok",
  "run_date": "2026-08-22T19:23:48.675Z"
}
```

## Features

- Role email addresses only, never a named individual
- Main phone number and postal address when the company publishes them
- Contact page URL, plus how that page was found
- Rejection accounting in `emails_rejected_reasons`, so a thin read is visible
- Coverage reported per row
- 25 flat snake_case fields, one row per company

## Full actor documentation

This server is a thin client and holds no extraction logic. For the complete input and output reference, pricing, and run history, see the Apify Store page:

https://apify.com/mambalabs/company-contact-details-extractor

---

## Mamba Labs GTM Suite

This server is one of the Mamba Labs GTM Suite MCP servers. Every actor in the suite takes a domain or a company and returns one flat row, so they stack in the same Clay table without reshaping anything. The actor behind this server is the Company Contact Details Extractor, immutable Apify actor ID `4mMncKaJykiq94grz`.

> Built by [Mamba Labs](https://github.com/mambalabsdev) | [npm](https://www.npmjs.com/org/mambalabsdev) | [Apify Store](https://apify.com/mambalabs)

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs
