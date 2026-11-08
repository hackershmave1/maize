import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test as nodeTest } from "node:test";

const configModule = await import("../scripts/check-bindings.mjs").catch(
  () => ({}),
);

nodeTest("binding checker exposes a deterministic config validation function", () => {
  assert.equal(typeof configModule.checkDeploymentBindings, "function");
});

nodeTest("Wrangler local and Terraform deployment bindings remain consistent", async () => {
  assert.equal(typeof configModule.checkDeploymentBindings, "function");
  const terraformDirectory = new URL("../", import.meta.url);
  const [wranglerText, terraformFiles] = await Promise.all([
    readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
    readdir(terraformDirectory),
  ]);
  const terraformText = (
    await Promise.all(
      terraformFiles
        .filter((name) => name.endsWith(".tf"))
        .sort()
        .map((name) => readFile(new URL(name, terraformDirectory), "utf8")),
    )
  ).join("\n");
  const result = configModule.checkDeploymentBindings(
    JSON.parse(wranglerText),
    terraformText,
  );
  assert.deepEqual(result, []);
});

nodeTest("binding checker rejects a deployment wired to Wrangler's local D1 placeholder", async () => {
  assert.equal(typeof configModule.checkDeploymentBindings, "function");
  const terraformDirectory = new URL("../", import.meta.url);
  const [wranglerText, terraformFiles] = await Promise.all([
    readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
    readdir(terraformDirectory),
  ]);
  const terraformText = (
    await Promise.all(
      terraformFiles
        .filter((name) => name.endsWith(".tf"))
        .sort()
        .map((name) => readFile(new URL(name, terraformDirectory), "utf8")),
    )
  ).join("\n");
  const invalidTerraform = terraformText.replace(
    "cloudflare_d1_database.events.id",
    '"00000000-0000-0000-0000-000000000001"',
  );
  const errors = configModule.checkDeploymentBindings(
    JSON.parse(wranglerText),
    invalidTerraform,
  );
  assert.ok(errors.some((error) => /local D1 placeholder/.test(error)));
});

nodeTest("binding checker requires the Terraform scheduled trigger to match Wrangler", async () => {
  const terraformDirectory = new URL("../", import.meta.url);
  const terraformFiles = await readdir(terraformDirectory);
  const terraformText = (
    await Promise.all(
      terraformFiles
        .filter((name) => name.endsWith(".tf"))
        .sort()
        .map((name) => readFile(new URL(name, terraformDirectory), "utf8")),
    )
  ).join("\n");
  const withoutCron = terraformText.replace(
    /resource "cloudflare_workers_cron_trigger" "scheduled" \{[\s\S]*?\n\}/,
    "",
  );
  const errors = configModule.checkDeploymentBindings({}, withoutCron);
  assert.ok(errors.some((error) => /scheduled trigger/.test(error)));

  const withWrongCron = terraformText.replace("* * * * *", "15 * * * *");
  const mismatchErrors = configModule.checkDeploymentBindings(
    { triggers: { crons: ["* * * * *"] } },
    withWrongCron,
  );
  assert.ok(mismatchErrors.some((error) => /scheduled trigger/.test(error)));
});
