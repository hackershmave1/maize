import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkStagingOriginOwnership } from "../scripts/check-staging-origin-ownership.mjs";

const accountId = "11111111111111111111111111111111";
const workerName = "moqesh-staging-origin-0123456789abcdef";
const ownerMarker = `moqesh-staging-origin-owner:${"a".repeat(64)}`;
const source = `// ${ownerMarker}\nexport default {};`;
const options = { accountId, workerName, ownerMarker, token: "test-token" };
const raw = (text = source, type = "application/javascript") =>
  new Response(text, { headers: { "content-type": type } });
const check = (response, overrides = {}) =>
  checkStagingOriginOwnership({ ...options, fetcher: async () => response, ...overrides });

function multipart(parts, headers = {}) {
  const body = parts.map(({ name, text, type = "application/javascript" }) =>
    `--fixture\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${text}\r\n`
  ).join("") + "--fixture--\r\n";
  return new Response(body, {
    headers: { "content-type": 'multipart/form-data; boundary="fixture"', ...headers },
  });
}

test("owned raw script permits reuse using only a bounded authenticated GET", async () => {
  assert.equal(await checkStagingOriginOwnership({
    ...options,
    fetcher: async (url, init) => {
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`);
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "Bearer test-token");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return raw();
    },
  }), "owned");
});

test("raw source accepts CRLF and media type parameters", async () => {
  assert.equal(await check(raw(source.replaceAll("\n", "\r\n"), "text/javascript; charset=utf-8")), "owned");
  assert.equal(await check(raw(source, "application/javascript+module")), "owned");
});

test("unmarked, differently owned, and embedded markers refuse overwrite", async () => {
  for (const text of ["export default {};", source.replace("aaaa", "bbbb"), `const bait = \`// ${ownerMarker}\n\`;`]) {
    await assert.rejects(check(raw(text)), /ownership marker.*refusing to overwrite/i);
  }
});

test("multipart checks metadata-selected main module rather than an unrelated marked module", async () => {
  const metadata = { main_module: "entry.js" };
  assert.equal(await check(multipart([
    { name: "metadata", text: JSON.stringify(metadata), type: "application/json" },
    { name: "entry.js", text: source },
    { name: "worker.js", text: "export default {};" },
  ])), "owned");
  await assert.rejects(check(multipart([
    { name: "metadata", text: JSON.stringify(metadata), type: "application/json" },
    { name: "entry.js", text: "export default {};" },
    { name: "worker.js", text: source },
  ])), /ownership marker.*refusing to overwrite/i);
});

test("multipart without metadata checks the downloaded entrypoint or expected worker.js", async () => {
  assert.equal(await check(multipart([{ name: "worker.js", text: source }])), "owned");
  assert.equal(await check(multipart([{ name: "entry.js", text: source }], { "cf-entrypoint": "entry.js" })), "owned");
});

test("multipart refuses malformed, missing, duplicate, or contradictory entrypoints", async () => {
  const json = (value) => ({ name: "metadata", text: JSON.stringify(value), type: "application/json" });
  for (const response of [
    multipart([{ name: "other.js", text: source }]),
    multipart([json({ main_module: "missing.js" }), { name: "worker.js", text: source }]),
    multipart([{ name: "metadata", text: "{", type: "application/json" }, { name: "worker.js", text: source }]),
    multipart([json({ main_module: 42 }), { name: "worker.js", text: source }]),
    multipart([json(null), { name: "worker.js", text: source }]),
    multipart([json({ main_module: "metadata", marker: source })]),
    multipart([{ name: "worker.js", text: source, type: "application/wasm" }]),
    multipart([json({ main_module: "worker.js" }), { name: "worker.js", text: source }], { "cf-entrypoint": "other.js" }),
    multipart([{ name: "worker.js", text: source }, { name: "worker.js", text: source }]),
    multipart([json({ main_module: "worker.js" }), json({ main_module: "worker.js" }), { name: "worker.js", text: source }]),
    raw("--fixture\r\nincomplete", "multipart/form-data; boundary=fixture"),
    raw(source, "multipart/form-data"),
  ]) {
    await assert.rejects(check(response), /multipart|metadata|entrypoint/i);
  }
});

test("missing script allows first create only for Cloudflare's specific missing-script response", async () => {
  const missing = () => Response.json({ success: false, errors: [{ code: 10007, message: "Worker not found" }] }, { status: 404 });
  assert.equal(await check(missing()), "missing");
  assert.equal(await check(missing()), "missing");
  assert.equal(await check(raw()), "owned");
  for (const response of [
    new Response("Not found", { status: 404 }),
    Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 404 }),
    Response.json({ success: true, errors: [{ code: 10007 }] }, { status: 404 }),
    Response.json({ success: false, errors: [{ code: 10007 }, { code: 10000 }] }, { status: 404 }),
    Response.json(null, { status: 404 }),
    Response.json({ success: false, errors: [] }, { status: 404 }),
  ]) await assert.rejects(check(response), /HTTP 404/);
});

test("HTTP, unexpected content, and transport failures fail closed without leaking API bodies or token", async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    await assert.rejects(check(new Response("test-token secret body", { status })), (error) =>
      error.message.includes(`HTTP ${status}`) && !error.message.includes("test-token"));
  }
  await assert.rejects(check(raw(source, "application/json")), /content.type/i);
  await assert.rejects(check(raw(source, "text/html")), /content.type/i);
  await assert.rejects(check(raw(), { fetcher: async () => { throw new Error("test-token transport detail"); } }), (error) =>
    /request failed/i.test(error.message) && !error.message.includes("test-token"));
  await assert.rejects(check(new Response(new ReadableStream({
    start(controller) { controller.error(new Error("body failed")); },
  }), { headers: { "content-type": "application/javascript" } })), /response.*read/i);
});

test("invalid inputs and missing token fail before making any request", async () => {
  const fetcher = async () => assert.fail("must not fetch for invalid configuration");
  for (const [field, value, message] of [
    ["accountId", "", "MOQESH_ACCOUNT_ID"],
    ["workerName", "../worker", "MOQESH_WORKER_NAME"],
    ["ownerMarker", "", "MOQESH_OWNER_MARKER"],
    ["token", "", "CLOUDFLARE_API_TOKEN"],
  ]) await assert.rejects(check(raw(), { [field]: value, fetcher }), new RegExp(message));
});

test("oversized or invalid UTF-8 downloads fail closed", async () => {
  const headers = { "content-type": "application/javascript" };
  await assert.rejects(check(new Response(new Uint8Array([0xff, 0xfe]), { headers })), /response.*UTF-8/i);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(check(new Response(stream, { headers })), /32 MiB/);
  assert.equal(cancelled, true);
});

test("CLI exits nonzero and explains required environment without network", () => {
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: "", MOQESH_ACCOUNT_ID: "", MOQESH_WORKER_NAME: "", MOQESH_OWNER_MARKER: "" };
  const result = spawnSync(process.execPath, [new URL("../scripts/check-staging-origin-ownership.mjs", import.meta.url).pathname], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MOQESH_ACCOUNT_ID/);
  assert.equal(result.stdout, "");
});
