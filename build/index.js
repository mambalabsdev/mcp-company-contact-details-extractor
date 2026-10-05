#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
// Drop undefined values so optional inputs are not sent to the actor at all.
function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
// The actor types its switches as strings ("true"/"false") for Clay
// compatibility, because Clay sends every input as a string and a boolean typed
// field silently receives "false" and reads it as truthy. The model gets a real
// boolean and the actor gets the string it validates.
function boolToString(v) {
    return v === undefined ? undefined : v ? "true" : "false";
}
// How long this wrapper waits for a run, in milliseconds. The run itself keeps
// the actor's own default timeout; past this wait the call returns the run id
// and console link instead of an error that hides a run still billing.
const WRAPPER_WAIT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = Number(process.env.MAMBA_POLL_INTERVAL_MS) || 3000;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// memory=512 is deliberate and matches the actor's declared
// defaultRunOptions.memoryMbytes, so the run is billed at the size the actor
// was built for rather than the API default.
//
// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it while
// the run goes on and keeps billing. Starting the run, polling it to a terminal
// status and then reading the dataset waits as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(actorPath, actorLabel, input) {
    const APIFY_TOKEN = process.env.APIFY_TOKEN;
    if (!APIFY_TOKEN) {
        return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
    }
    const headers = {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    };
    const httpError = async (response) => {
        let detail = "";
        try {
            const body = (await response.json());
            if (body?.error?.message)
                detail = ` ${body.error.message}`;
        }
        catch {
            detail = "";
        }
        switch (response.status) {
            case 400:
                return `The ${actorLabel} run was rejected as invalid input.${detail}`;
            case 401:
                return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
            case 402:
                return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
            default:
                return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
        }
    };
    // 1. Start the run.
    let started;
    try {
        started = await fetch(`https://api.apify.com/v2/acts/${actorPath}/runs?memory=512`, { method: "POST", headers, body: JSON.stringify(input) });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
    }
    if (!started.ok) {
        return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
    }
    let run;
    try {
        run = (await started.json()).data ?? {};
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
    }
    const runId = run.id;
    if (!runId) {
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
    }
    // 2. Poll to a terminal status.
    const deadline = Date.now() + WRAPPER_WAIT_MS;
    let status = run.status ?? "READY";
    let datasetId = run.defaultDatasetId;
    while (!TERMINAL.has(status)) {
        if (Date.now() >= deadline) {
            return {
                isError: true,
                content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
            };
        }
        await sleep(POLL_INTERVAL_MS);
        let poll;
        try {
            poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
        }
        if (!poll.ok) {
            return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
        }
        const body = (await poll.json());
        status = body.data?.status ?? status;
        datasetId = body.data?.defaultDatasetId ?? datasetId;
    }
    // 3. A run that did not succeed is a failure the caller must see, never an
    // empty success, so a crashed run never reads as "no results found".
    if (status !== "SUCCEEDED") {
        return {
            isError: true,
            content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
        };
    }
    if (!datasetId) {
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
    }
    // 4. Read the dataset.
    let ds;
    try {
        ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
    }
    if (!ds.ok) {
        return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
    }
    let items;
    try {
        items = await ds.json();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
    }
    if (!Array.isArray(items)) {
        const asObj = items;
        const detail = asObj?.error?.message
            ? `${asObj.error.message}`
            : JSON.stringify(items);
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}
const server = new McpServer({
    name: "mamba-company-contact-details-extractor",
    version: pkg.version,
});
// Company Contact Details Extractor (immutable actor ID 4mMncKaJykiq94grz)
server.registerTool("extract_company_contact_details", {
    title: "Extract Company Contact Details",
    description: "Find a company's contact page from its domain and extract classified ROLE email addresses (general, support, sales, privacy), a main phone number in E.164 where the country resolves, and a postal address. Returns one flat Clay ready row. Named individuals are NEVER returned: an address is kept only when its domain belongs to the company and its local part is in the role vocabulary, so a person's address is dropped by an allow list rather than by a name detector. The row reports how many addresses were found and how many were rejected and why, so a thin result is never mistaken for a site that publishes nothing. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
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
            .describe("Bare company domain, for example stripe.com. Needed on every call: the tool returns an error naming this field when it is missing. It is the join key for every other actor in the fleet."),
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
}, async ({ company_domain, company_name, emailTypes, includePhones, includeAddress, allowFreeMailboxes, crawlDepth, skipCache }) => {
    if (company_domain === undefined || company_domain.trim() === "") {
        return {
            isError: true,
            content: [{ type: "text", text: "company_domain is required: pass a bare company domain, for example stripe.com." }],
        };
    }
    return runActor("4mMncKaJykiq94grz", "Company Contact Details Extractor", compact({
        company_domain,
        company_name,
        emailTypes,
        includePhones: boolToString(includePhones),
        includeAddress: boolToString(includeAddress),
        allowFreeMailboxes: boolToString(allowFreeMailboxes),
        crawlDepth,
        skipCache: boolToString(skipCache),
    }));
});
const transport = new StdioServerTransport();
await server.connect(transport);
