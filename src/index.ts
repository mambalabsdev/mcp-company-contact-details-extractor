#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

const APIFY_TOKEN = process.env.APIFY_TOKEN;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor at all.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// The actor types its switches as strings ("true"/"false") for Clay
// compatibility, because Clay sends every input as a string and a boolean typed
// field silently receives "false" and reads it as truthy. The model gets a real
// boolean and the actor gets the string it validates.
function boolToString(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? "true" : "false";
}

// actorPath is the actor's IMMUTABLE Apify actor id, not its slug, so a Store
// rename never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  // memory=512 is deliberate and matches the actor's declared
  // defaultRunOptions.memoryMbytes. run-sync-get-dataset-items runs at 2048 MB
  // unless told otherwise, and `apify-actor-start` bills once per GB with a
  // minimum of one, so leaving the default in place would charge the caller
  // more start events per run than the actor asks for. Keep this in step with
  // the actor's defaultRunOptions.
  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300&memory=512`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message = "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try again, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx normally carries the dataset array. Pass actor output through
  // unchanged: the wrapper must never reinterpret a status field, because
  // not_extractable, blocked and not_found are different answers and collapsing
  // them is exactly the defect the actor was built to avoid.
  const items = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-company-contact-details-extractor",
  version: pkg.version,
});

// Company Contact Details Extractor (immutable actor ID 4mMncKaJykiq94grz)
server.registerTool(
  "extract_company_contact_details",
  {
    title: "Extract Company Contact Details",
    description:
      "Find a company's contact page from its domain and extract classified ROLE email addresses (general, support, sales, privacy), a main phone number in E.164 where the country resolves, and a postal address. Returns one flat Clay ready row. Named individuals are NEVER returned: an address is kept only when its domain belongs to the company and its local part is in the role vocabulary, so a person's address is dropped by an allow list rather than by a name detector. The row reports how many addresses were found and how many were rejected and why, so a thin result is never mistaken for a site that publishes nothing. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Extract Company Contact Details",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      company_domain: z.string()
        .optional()
        .describe("Bare company domain, for example stripe.com. This is the only required input and it is the join key for every other actor in the fleet."),
      company_name: z.string()
        .optional()
        .describe("Optional. Used in the row and in logging. This actor gates addresses on the email DOMAIN rather than on the company name, so supplying a name does not change which addresses are kept."),
      emailTypes: z.enum(["all", "general", "support", "sales", "privacy", "general_support", "sales_only"])
        .optional()
        .describe("Which classes of role address to return. \"all\" (default) returns general, support, sales and privacy. The narrower settings return only what they name and leave the other columns null, which is a different answer from not finding one. Sent as a string for Clay compatibility."),
      includePhones: z.boolean()
        .optional()
        .describe("When \"true\" (default) the contact page is scanned for a main phone number. Set \"false\" to skip phone extraction entirely, which leaves the phone columns null. Sent as a string for Clay compatibility."),
      includeAddress: z.boolean()
        .optional()
        .describe("When \"true\" (default) a postal address is read from JSON-LD first and from the footer second. Set \"false\" to skip it. Sent as a string for Clay compatibility."),
      allowFreeMailboxes: z.boolean()
        .optional()
        .describe("When \"false\" (default) an address at gmail, outlook or another free provider is rejected, because it cannot be checked against the company domain. Set \"true\" for small business and local company lists, where a free mailbox on the contact page is often the real contact point. Sent as a string for Clay compatibility."),
      crawlDepth: z.enum(["1", "2"])
        .optional()
        .describe("How many pages to read after the homepage. \"1\" (default) reads the contact page. \"2\" also reads a support or legal page when the contact page yielded nothing. This is a cost and thoroughness dial, not a change of answer. Sent as a string for Clay compatibility."),
      skipCache: z.boolean()
        .optional()
        .describe("When \"false\" (default) a successful lookup is cached for seven days and reused, which costs you nothing on a repeated run. Set \"true\" to force a fresh fetch. Sent as a string for Clay compatibility."),
    },
  },
  async ({ company_domain, company_name, emailTypes, includePhones, includeAddress, allowFreeMailboxes, crawlDepth, skipCache }) => {
    return runActor(
      "4mMncKaJykiq94grz",
      "Company Contact Details Extractor",
      compact({
        company_domain,
        company_name,
        emailTypes,
        includePhones: boolToString(includePhones),
        includeAddress: boolToString(includeAddress),
        allowFreeMailboxes: boolToString(allowFreeMailboxes),
        crawlDepth,
        skipCache: boolToString(skipCache),
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
