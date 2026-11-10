import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";

export async function provisionWorkerSecrets({
  accountId,
  scriptName,
  token = process.env.CLOUDFLARE_API_TOKEN,
  lureKeySecret = process.env.MOQESH_LURE_KEY_SECRET,
  alertWebhookUrl = process.env.MOQESH_ALERT_WEBHOOK_URL,
  alertWebhookEnabled = process.env.MOQESH_ALERT_WEBHOOK_ENABLED !== "false",
  lureKeySecretName = process.env.MOQESH_LURE_KEY_SECRET_BINDING ?? "LURE_KEY_SECRET",
  alertWebhookSecretName = process.env.MOQESH_ALERT_WEBHOOK_SECRET_BINDING ?? "ALERT_WEBHOOK_URL",
  fetcher = fetch,
}) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("A valid Cloudflare account ID is required");
  }
  if (
    typeof scriptName !== "string"
    || !/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/i.test(scriptName)
  ) {
    throw new Error("A valid Worker script name is required");
  }
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  if (typeof lureKeySecret !== "string" || Buffer.byteLength(lureKeySecret) < 32) {
    throw new Error("MOQESH_LURE_KEY_SECRET must contain at least 32 bytes");
  }
  if (lureKeySecretName !== "LURE_KEY_SECRET") {
    throw new Error("The required lure secret binding name is LURE_KEY_SECRET");
  }
  if (alertWebhookSecretName !== "ALERT_WEBHOOK_URL") {
    throw new Error("The required webhook secret binding name is ALERT_WEBHOOK_URL");
  }
  if (alertWebhookEnabled) validateWebhookUrl(alertWebhookUrl);

  const scriptPath = `${API_BASE}/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`;
  const secrets = {
    [lureKeySecretName]: {
      name: lureKeySecretName,
      type: "secret_text",
      text: lureKeySecret,
    },
  };
  const requiredSecretNames = [lureKeySecretName];
  if (alertWebhookEnabled) {
    secrets[alertWebhookSecretName] = {
      name: alertWebhookSecretName,
      type: "secret_text",
      text: alertWebhookUrl,
    };
    requiredSecretNames.push(alertWebhookSecretName);
  }

  const updateResponse = await fetcher(`${scriptPath}/secrets-bulk`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ secrets }),
  });
  await assertSuccessfulResponse(updateResponse);

  const verificationResponse = await fetcher(`${scriptPath}/secrets`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const verification = await assertSuccessfulResponse(verificationResponse);
  const names = new Set(
    Array.isArray(verification.result)
      ? verification.result.map((secret) => secret?.name)
      : [],
  );
  const missing = requiredSecretNames.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Worker secret binding verification failed: ${missing.join(", ")}`);
  }
}

function validateWebhookUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("MOQESH_ALERT_WEBHOOK_URL is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MOQESH_ALERT_WEBHOOK_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("MOQESH_ALERT_WEBHOOK_URL must be an HTTPS URL without embedded credentials");
  }
}

async function assertSuccessfulResponse(response) {
  if (!response.ok) {
    throw new Error(`Cloudflare API request failed with HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare API returned an invalid response");
  }
  if (payload.success !== true) {
    throw new Error("Cloudflare API rejected the Worker secret operation");
  }
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  provisionWorkerSecrets({
    accountId: process.env.MOQESH_ACCOUNT_ID,
    scriptName: process.env.MOQESH_WORKER_NAME,
  }).then(() => {
    const names = process.env.MOQESH_ALERT_WEBHOOK_ENABLED === "false"
      ? "LURE_KEY_SECRET"
      : "LURE_KEY_SECRET, ALERT_WEBHOOK_URL";
    console.log(`Uploaded and verified Worker secret bindings: ${names}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Worker secret provisioning failed");
    process.exitCode = 1;
  });
}
