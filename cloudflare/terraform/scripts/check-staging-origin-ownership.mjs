import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const SOURCE_TYPES = new Set([
  "application/javascript",
  "application/javascript+module",
  "text/javascript",
  "application/x-javascript",
  "text/plain",
]);

// Requires only Workers Scripts Read. No API writes, provider downloads, or shell commands.
export async function checkStagingOriginOwnership({
  accountId,
  workerName,
  ownerMarker,
  token = process.env.CLOUDFLARE_API_TOKEN,
  fetcher = fetch,
}) {
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "")) {
    throw new Error("MOQESH_ACCOUNT_ID must be a 32-character Cloudflare account ID");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(workerName ?? "")) {
    throw new Error("MOQESH_WORKER_NAME must be the derived staging origin Worker name");
  }
  if (!/^moqesh-staging-origin-owner:[a-f0-9]{64}$/.test(ownerMarker ?? "")) {
    throw new Error("MOQESH_OWNER_MARKER must contain the installation's SHA-256 ownership marker");
  }
  if (!token?.trim()) throw new Error("CLOUDFLARE_API_TOKEN is required (Workers Scripts Read permission)");

  let response;
  try {
    response = await fetcher(`${API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`Ownership request failed for ${workerName}; check connectivity, timeout, and CLOUDFLARE_API_TOKEN. Refusing to upload.`);
  }

  if (response.status === 404) {
    let missing;
    try {
      missing = JSON.parse(await readDownload(response));
    } catch {
      throw new Error(`Ownership check received an invalid HTTP 404 response for ${workerName}; refusing to upload.`);
    }
    if (missing?.success === false && Array.isArray(missing.errors) &&
        missing.errors.length > 0 && missing.errors.every((error) => error?.code === 10007)) {
      return "missing";
    }
  }
  if (response.status !== 200) {
    throw new Error(`Ownership check failed for ${workerName}: HTTP ${response.status}. Verify account, Workers Scripts Read permission, and API availability; refusing to upload.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  const body = await readDownload(response);
  let source;
  if (mediaType === "multipart/form-data") {
    source = await multipartSource(body, contentType, response.headers.get("cf-entrypoint"));
  } else if (SOURCE_TYPES.has(mediaType)) {
    source = body;
  } else {
    throw new Error(`Unsupported Worker download content-type "${mediaType}"; refusing to upload.`);
  }
  // Only an actual leading source comment is evidence, not a string or metadata occurrence.
  if (!source.startsWith(`// ${ownerMarker}\n`) && !source.startsWith(`// ${ownerMarker}\r\n`)) {
    throw new Error(`Worker ${workerName} lacks this installation's ownership marker; refusing to overwrite an unmanaged or differently owned Worker.`);
  }
  return "owned";
}

async function readDownload(response) {
  try {
    if (!response.body) throw new Error("empty body");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw new Error("download limit exceeded");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("Worker response could not be read as UTF-8 within the 32 MiB download limit; refusing to upload.");
  }
}

async function multipartSource(body, contentType, headerEntrypoint) {
  // Some MIME parsers accept truncated bodies. Require the closing delimiter as well.
  const boundary = contentType.match(/;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const delimiter = boundary?.[1] ?? boundary?.[2];
  if (!delimiter || !body.trimEnd().endsWith(`\r\n--${delimiter}--`)) {
    throw new Error("Malformed or truncated multipart Worker response; refusing to upload.");
  }
  let form;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new Error("Cannot parse multipart Worker response; refusing to upload.");
  }
  let entrypoint = headerEntrypoint || "worker.js";
  const metadataParts = form.getAll("metadata");
  if (metadataParts.length > 1) throw new Error("Duplicate multipart metadata; refusing to upload.");
  if (metadataParts.length === 1) {
    let metadata;
    try {
      const part = metadataParts[0];
      metadata = JSON.parse(typeof part === "string" ? part : await part.text());
    } catch {
      throw new Error("Invalid multipart metadata JSON; refusing to upload.");
    }
    if (!metadata || typeof metadata.main_module !== "string" || !metadata.main_module ||
        (headerEntrypoint && headerEntrypoint !== metadata.main_module)) {
      throw new Error("Missing or contradictory multipart metadata entrypoint; refusing to upload.");
    }
    entrypoint = metadata.main_module;
  }
  const entries = form.getAll(entrypoint);
  if (entrypoint === "metadata" || entries.length !== 1) {
    throw new Error("Missing or duplicate multipart entrypoint source; refusing to upload.");
  }
  const entry = entries[0];
  if (typeof entry !== "string" && !SOURCE_TYPES.has(entry.type.split(";")[0].toLowerCase())) {
    throw new Error("Unsupported multipart entrypoint content-type; refusing to upload.");
  }
  return typeof entry === "string" ? entry : await entry.text();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkStagingOriginOwnership({
    accountId: process.env.MOQESH_ACCOUNT_ID,
    workerName: process.env.MOQESH_WORKER_NAME,
    ownerMarker: process.env.MOQESH_OWNER_MARKER,
  }).then((status) => {
    console.log(`Staging origin ownership verified: ${status}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Staging origin ownership check failed; refusing to upload.");
    process.exitCode = 1;
  });
}
