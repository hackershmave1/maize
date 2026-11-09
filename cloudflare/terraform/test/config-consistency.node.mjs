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

const terraformFile = (name) =>
  readFile(new URL(`../${name}`, import.meta.url), "utf8");
const resourceBody = (terraform, type, name) =>
  terraform.match(new RegExp(`resource "${type}" "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
const variableBody = (terraform, name) =>
  terraform.match(new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";

nodeTest("staging origin is opt-in and uploads only the configured private static Worker", async () => {
  const main = await terraformFile("main.tf");
  const origin = resourceBody(main, "cloudflare_workers_script", "staging_origin");
  assert.match(origin, /count\s*=\s*var\.create_staging_origin \? 1 : 0/);
  assert.match(origin, /account_id\s*=\s*var\.account_id/);
  assert.match(origin, /script_name\s*=\s*var\.staging_origin_worker_name/);
  assert.match(origin, /content\s*=\s*replace\(file\("\$\{path\.module\}\/\.\.\/staging-origin\/worker\.js"\), "@@MOQESH_STAGING_ORIGIN_OWNER@@", local\.staging_origin_owner_marker\)/);
  assert.doesNotMatch(origin, /\b(content_file|content_sha256)\s*=/);
  const worker = await readFile(new URL("../../staging-origin/worker.js", import.meta.url), "utf8");
  assert.match(worker, /^\/\/ @@MOQESH_STAGING_ORIGIN_OWNER@@\n/);
  assert.match(origin, /main_module\s*=\s*"worker\.js"/);
  assert.match(origin, /compatibility_date\s*=\s*"2026-11-08"/);
  assert.match(origin, /assets\s*=\s*\{\s*directory\s*=\s*"\$\{path\.module\}\/\.\.\/staging-origin\/site"/);
  assert.match(origin, /config\s*=\s*\{\s*binding\s*=\s*"ASSETS"\s*run_worker_first\s*=\s*true\s*not_found_handling\s*=\s*"404-page"/);
  assert.match(origin, /depends_on\s*=\s*\[terraform_data\.deployment_preflight\]/);
});

nodeTest("staging origin ownership is checked from existing source before any managed upload", async () => {
  const main = await terraformFile("main.tf");
  const scripts = main.match(/data "cloudflare_workers_scripts" "staging_origin_candidates" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(scripts, /count\s*=\s*var\.create_staging_origin \? 1 : 0/);
  assert.match(scripts, /account_id\s*=\s*var\.account_id/);
  assert.match(scripts, /max_items\s*=\s*1000/);
  assert.doesNotMatch(scripts, /\btags\s*=/);
  assert.match(main, /staging_origin_owner_marker\s*=\s*"moqesh-staging-origin-owner:\$\{sha256\(var\.installation_id\)\}"/);
  assert.match(main, /staging_origin_collision_names\s*=\s*var\.create_staging_origin \? \[\s*for script in data\.cloudflare_workers_scripts\.staging_origin_candidates\[0\]\.result : script\.id\s*if script\.id == var\.staging_origin_worker_name\s*\] : \[\]/);
  const existing = main.match(/data "cloudflare_workers_script" "existing_staging_origin" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(existing, /count\s*=\s*var\.create_staging_origin && length\(local\.staging_origin_collision_names\) > 0 \? 1 : 0/);
  assert.match(existing, /account_id\s*=\s*var\.account_id/);
  assert.match(existing, /script_name\s*=\s*var\.staging_origin_worker_name/);
  const preflight = resourceBody(main, "terraform_data", "deployment_preflight");
  assert.match(preflight, /condition\s*=\s*var\.create_staging_origin \? length\(data\.cloudflare_workers_scripts\.staging_origin_candidates\[0\]\.result\) < 1000 : true/);
  assert.match(preflight, /condition\s*=\s*!var\.create_staging_origin \|\| \(\s*length\(trimspace\(var\.installation_id\)\) > 0 && length\(local\.staging_origin_owner_marker\) > 0 &&\s*alltrue\(\[\s*for script in data\.cloudflare_workers_script\.existing_staging_origin :\s*strcontains\(coalesce\(script\.script, " "\), "\/\/ \$\{local\.staging_origin_owner_marker\}\\n"\)\s*\]\)\s*\)/);
  assert.match(preflight, /error_message\s*=\s*"[^"]*refusing to overwrite[^"]*"/);
  assert.match(resourceBody(main, "cloudflare_workers_script", "staging_origin"), /depends_on\s*=\s*\[terraform_data\.deployment_preflight\]/);
});

nodeTest("staging name inequality is enforced only when origin creation is enabled", async () => {
  const variables = await terraformFile("variables.tf");
  const stagingName = variableBody(variables, "staging_origin_worker_name");
  assert.match(stagingName, /&& \(!var\.create_staging_origin \|\| var\.staging_origin_worker_name != var\.worker_name\)/);
  assert.doesNotMatch(stagingName, /&& var\.staging_origin_worker_name != var\.worker_name/);
});

nodeTest("ORIGIN selects the managed service and production environment only with explicit opt-in", async () => {
  const main = await terraformFile("main.tf");
  const app = resourceBody(main, "cloudflare_workers_script", "app");
  assert.match(app, /name\s*=\s*"ORIGIN"\s*type\s*=\s*"service"\s*service\s*=\s*var\.create_staging_origin \? cloudflare_workers_script\.staging_origin\[0\]\.script_name : var\.origin_service_name\s*environment\s*=\s*var\.create_staging_origin \? "production" : var\.origin_service_environment/);
  assert.match(app, /condition\s*=\s*\(var\.create_staging_origin \? var\.staging_origin_worker_name : var\.origin_service_name\) != var\.worker_name/);
  const outputs = await terraformFile("outputs.tf");
  assert.match(outputs, /output "origin_service_name" \{\s*description\s*=\s*"[^"]+"\s*value\s*=\s*var\.create_staging_origin \? cloudflare_workers_script\.staging_origin\[0\]\.script_name : var\.origin_service_name\s*\}/);
});

nodeTest("staging inputs default off and validate selected origin self-binding semantics", async () => {
  const variables = await terraformFile("variables.tf");
  assert.match(variableBody(variables, "create_staging_origin"), /type\s*=\s*bool\s*default\s*=\s*false/);
  const stagingName = variableBody(variables, "staging_origin_worker_name");
  assert.match(stagingName, /default\s*=\s*"moqesh-staging-origin"/);
  const nameRule = variableBody(variables, "worker_name").match(/regex\("([^"]+)"/)?.[1];
  assert.ok(nameRule);
  assert.ok(stagingName.includes(`regex("${nameRule}", var.staging_origin_worker_name)`));
  assert.match(stagingName, /var\.staging_origin_worker_name != var\.worker_name/);
  assert.match(variableBody(variables, "origin_service_name"), /condition\s*=\s*var\.create_staging_origin \|\| \(length\(trimspace\(var\.origin_service_name\)\) > 0 && var\.origin_service_name != var\.worker_name\)/);
  assert.match(variableBody(variables, "origin_service_environment"), /default\s*=\s*"production"/);
});

nodeTest("staging origin has no workers.dev or preview URL before the public route is attached", async () => {
  const main = await terraformFile("main.tf");
  const disabled = resourceBody(main, "cloudflare_workers_script_subdomain", "staging_origin_disabled");
  assert.match(disabled, /count\s*=\s*var\.create_staging_origin \? 1 : 0/);
  assert.match(disabled, /account_id\s*=\s*var\.account_id/);
  assert.match(disabled, /script_name\s*=\s*var\.staging_origin_worker_name/);
  assert.match(disabled, /\benabled\s*=\s*false/);
  assert.match(disabled, /\bpreviews_enabled\s*=\s*false/);
  assert.match(disabled, /depends_on\s*=\s*\[cloudflare_workers_script\.staging_origin\]/);
  assert.match(
    resourceBody(main, "cloudflare_workers_route", "public"),
    /depends_on\s*=\s*\[[^\]]*cloudflare_workers_script_subdomain\.staging_origin_disabled/,
  );
});

nodeTest("binding checker rejects missing or unsafe staging origin subdomain controls", async () => {
  const main = await terraformFile("main.tf");
  const disabled = resourceBody(main, "cloudflare_workers_script_subdomain", "staging_origin_disabled");
  const unsafeBodies = [
    "",
    disabled.replace(/count\s*=\s*var\.create_staging_origin \? 1 : 0/, "count = 1"),
    disabled.replace(/\benabled\s*=\s*false/, "enabled = true"),
    disabled.replace(/\bpreviews_enabled\s*=\s*false/, "previews_enabled = true"),
  ];
  for (const unsafe of unsafeBodies) {
    const invalid = disabled ? main.replace(disabled, unsafe) : main;
    const errors = configModule.checkDeploymentBindings({}, invalid);
    assert.ok(errors.some((error) => /staging origin.*workers\.dev.*preview/i.test(error)));
  }
});

nodeTest("examples keep production defaults safe and isolate the approved Kurocyber staging resources", async () => {
  const basic = await terraformFile("examples/basic.tfvars.example");
  assert.match(basic, /^create_staging_origin\s*=\s*false$/m);
  const staging = await terraformFile("examples/kurocyber-staging.tfvars.example");
  const expected = {
    protected_hostname: '"staging.kurocyber.com"',
    admin_hostname: '"admin-staging.kurocyber.com"',
    worker_name: '"moqesh-kurocyber-staging"',
    d1_database_name: '"moqesh-kurocyber-staging-events"',
    create_staging_origin: "true",
    staging_origin_worker_name: '"moqesh-staging-origin"',
    origin_service_name: '""',
    enable_public_route: "false",
  };
  for (const [name, value] of Object.entries(expected)) {
    const configured = staging.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"))?.[1];
    assert.equal(configured, value, name);
  }
  for (const name of ["account_id", "zone_id", "access_team_domain", "access_allowed_emails", "installation_id"]) {
    const assignment = new RegExp(`^${name}\\s*=\\s*(.+)$`, "m");
    assert.equal(staging.match(assignment)?.[1], basic.match(assignment)?.[1], `${name} retains its non-secret placeholder`);
  }
  const variables = await terraformFile("variables.tf");
  for (const [, name, body] of variables.matchAll(/variable "([^"]+)" \{([\s\S]*?)\n\}/g)) {
    if (!/\bdefault\s*=/.test(body)) {
      assert.match(staging, new RegExp(`^${name}\\s*=`, "m"), `${name} is required`);
    }
  }
});
