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

nodeTest("HCP state uses the supported cloud integration and environment-based workspace selection", async () => {
  const versions = await terraformFile("versions.tf");
  assert.match(versions, /\bcloud\s*\{\s*\}/);
  assert.doesNotMatch(versions, /\bbackend\s+"cloud"/);
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(readme, /TF_CLOUD_ORGANIZATION=/);
  assert.match(readme, /TF_WORKSPACE=/);
  assert.doesNotMatch(readme, /-backend-config=/);
});

nodeTest("dashboard assets must be bound on the application Worker, not only the staging origin", async () => {
  const main = await terraformFile("main.tf");
  const app = resourceBody(main, "cloudflare_workers_script", "app");
  assert.match(app, /\{\s*name\s*=\s*"ASSETS"\s*type\s*=\s*"assets"\s*\}/);
  const invalidApps = [
    app.replace(/\{\s*name\s*=\s*"ASSETS"\s*type\s*=\s*"assets"\s*\},?/, ""),
    app.replace(/type\s*=\s*"assets"/, 'type = "plain_text"'),
  ];
  for (const invalid of invalidApps) {
    const errors = configModule.checkDeploymentBindings({}, main.replace(app, invalid));
    assert.ok(errors.some((error) => /dashboard.*ASSETS.*assets/.test(error)));
  }
});

nodeTest("staging origin is opt-in and uploads only the configured private static Worker", async () => {
  const main = await terraformFile("main.tf");
  const origin = resourceBody(main, "cloudflare_workers_script", "staging_origin");
  assert.match(origin, /count\s*=\s*var\.create_staging_origin \? 1 : 0/);
  assert.match(origin, /account_id\s*=\s*var\.account_id/);
  assert.match(origin, /script_name\s*=\s*local\.staging_origin_worker_name/);
  assert.match(origin, /content\s*=\s*replace\(file\("\$\{path\.module\}\/\.\.\/staging-origin\/worker\.js"\), "@@MOQESH_STAGING_ORIGIN_OWNER@@", local\.staging_origin_owner_marker\)/);
  assert.doesNotMatch(origin, /\b(content_file|content_sha256)\s*=/);
  const worker = await readFile(new URL("../../staging-origin/worker.js", import.meta.url), "utf8");
  assert.match(worker, /^\/\/ @@MOQESH_STAGING_ORIGIN_OWNER@@\n/);
  assert.match(origin, /main_module\s*=\s*"worker\.js"/);
  assert.match(origin, /compatibility_date\s*=\s*"2026-11-08"/);
  assert.match(origin, /assets\s*=\s*\{\s*directory\s*=\s*"\$\{path\.module\}\/\.\.\/staging-origin\/site"/);
  assert.match(origin, /config\s*=\s*\{\s*run_worker_first\s*=\s*true\s*not_found_handling\s*=\s*"404-page"/);
  assert.match(origin, /bindings\s*=\s*\[\s*\{\s*name\s*=\s*"ASSETS"\s*type\s*=\s*"assets"\s*\}/);
  assert.match(origin, /\{\s*name\s*=\s*"STAGING_HOSTNAME"\s*type\s*=\s*"plain_text"\s*text\s*=\s*var\.protected_hostname\s*\}/);
  assert.match(origin, /depends_on\s*=\s*\[terraform_data\.deployment_preflight\]/);
});

nodeTest("staging hostname binding is required by the checker and configured for local preview", async () => {
  const main = await terraformFile("main.tf");
  const origin = resourceBody(main, "cloudflare_workers_script", "staging_origin");
  const invalidOrigins = [
    origin.replace(/\{\s*name\s*=\s*"STAGING_HOSTNAME"[\s\S]*?\}/, ""),
    origin.replace(/text\s*=\s*var\.protected_hostname/, 'text = "unexpected.example"'),
  ];
  for (const invalid of invalidOrigins) {
    const errors = configModule.checkDeploymentBindings({}, main.replace(origin, invalid));
    assert.ok(errors.some((error) => /staging origin.*STAGING_HOSTNAME.*protected_hostname/.test(error)));
  }
  const local = JSON.parse(await readFile(new URL("../../staging-origin/wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(local.vars?.STAGING_HOSTNAME, "staging.example.com");
  assert.equal(local.assets.run_worker_first, true);
});

nodeTest("binding checker enforces the pinned provider staging assets schema", async () => {
  const main = await terraformFile("main.tf");
  const origin = resourceBody(main, "cloudflare_workers_script", "staging_origin");
  const withoutBinding = origin.replace(/bindings\s*=\s*\[[\s\S]*?\]/, "");
  const missingErrors = configModule.checkDeploymentBindings({}, main.replace(origin, withoutBinding));
  assert.ok(missingErrors.some((error) => /staging origin.*ASSETS.*assets/.test(error)));

  const wrongType = origin.replace(/type\s*=\s*"assets"/, 'type = "plain_text"');
  const wrongTypeErrors = configModule.checkDeploymentBindings({}, main.replace(origin, wrongType));
  assert.ok(wrongTypeErrors.some((error) => /staging origin.*ASSETS.*assets/.test(error)));

  const nestedBinding = origin.replace(/config\s*=\s*\{/, 'config = {\n      binding = "ASSETS"');
  const nestedErrors = configModule.checkDeploymentBindings({}, main.replace(origin, nestedBinding));
  assert.ok(nestedErrors.some((error) => /5\.28\.1.*assets\.config\.binding/.test(error)));
});

nodeTest("read-only staging ownership check gates uploads on every apply without the broken provider source read", async () => {
  const main = await terraformFile("main.tf");
  assert.doesNotMatch(main, /data "cloudflare_workers_script[s]?"/);
  assert.match(main, /staging_origin_owner_marker\s*=\s*module\.staging_origin_ownership\.owner_marker/);
  const ownership = main.match(/module "staging_origin_ownership" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(ownership, /source\s*=\s*"\.\/modules\/staging-origin-ownership"/);
  assert.match(ownership, /enabled\s*=\s*var\.create_staging_origin/);
  assert.match(ownership, /installation_id\s*=\s*var\.installation_id/);
  assert.match(ownership, /account_id\s*=\s*var\.account_id/);
  const guard = resourceBody(main, "terraform_data", "staging_origin_ownership");
  assert.match(guard, /count\s*=\s*var\.create_staging_origin \? 1 : 0/);
  assert.match(guard, /triggers_replace\s*=\s*\[timestamp\(\)\]/);
  assert.match(guard, /create_before_destroy\s*=\s*true/);
  assert.match(guard, /provisioner "local-exec"/);
  assert.match(guard, /command\s*=\s*"node \\".*scripts\/check-staging-origin-ownership\.mjs/);
  assert.match(guard, /MOQESH_ACCOUNT_ID\s*=\s*var\.account_id/);
  assert.match(guard, /MOQESH_WORKER_NAME\s*=\s*local\.staging_origin_worker_name/);
  assert.match(guard, /MOQESH_OWNER_MARKER\s*=\s*local\.staging_origin_owner_marker/);
  assert.doesNotMatch(guard, /on_failure\s*=\s*continue|CLOUDFLARE_API_TOKEN\s*=/);
  const preflight = resourceBody(main, "terraform_data", "deployment_preflight");
  assert.match(preflight, /depends_on\s*=\s*\[terraform_data\.staging_origin_ownership\]/);
  assert.match(preflight, /condition\s*=\s*module\.staging_origin_ownership\.safe/);
  assert.match(resourceBody(main, "cloudflare_workers_script", "staging_origin"), /depends_on\s*=\s*\[terraform_data\.deployment_preflight\]/);
});

nodeTest("staging name cannot be overridden and root uses the shared account/installation derivation", async () => {
  const variables = await terraformFile("variables.tf");
  assert.equal(variableBody(variables, "staging_origin_worker_name"), "");
  const main = await terraformFile("main.tf");
  assert.match(main, /staging_origin_worker_name\s*=\s*module\.staging_origin_ownership\.worker_name/);
  assert.doesNotMatch(main, /var\.staging_origin_worker_name/);
  const outputs = await terraformFile("outputs.tf");
  assert.match(outputs, /output "staging_origin_worker_name" \{[\s\S]*?value\s*=\s*var\.create_staging_origin \? local\.staging_origin_worker_name : null/);
  const origin = resourceBody(main, "cloudflare_workers_script", "staging_origin");
  const invalid = main.replace(origin, origin.replace(/script_name\s*=\s*local\.staging_origin_worker_name/, 'script_name = "moqesh-staging-origin"'));
  const errors = configModule.checkDeploymentBindings({}, invalid);
  assert.ok(errors.some((error) => /staging origin.*installation-derived/.test(error)));
});

nodeTest("ORIGIN selects the managed service and production environment only with explicit opt-in", async () => {
  const main = await terraformFile("main.tf");
  const app = resourceBody(main, "cloudflare_workers_script", "app");
  assert.match(app, /name\s*=\s*"ORIGIN"\s*type\s*=\s*"service"\s*service\s*=\s*var\.create_staging_origin \? cloudflare_workers_script\.staging_origin\[0\]\.script_name : var\.origin_service_name\s*environment\s*=\s*var\.create_staging_origin \? "production" : var\.origin_service_environment/);
  assert.match(app, /condition\s*=\s*var\.origin_type == "dns" \|\| \(var\.create_staging_origin \? local\.staging_origin_worker_name : var\.origin_service_name\) != var\.worker_name/);
  const outputs = await terraformFile("outputs.tf");
  assert.match(outputs, /output "origin_service_name" \{\s*description\s*=\s*"[^"]+"\s*value\s*=\s*var\.origin_type == "dns" \? null : \(var\.create_staging_origin \? cloudflare_workers_script\.staging_origin\[0\]\.script_name : var\.origin_service_name\)\s*\}/);
});

nodeTest("DNS origin mode omits the ORIGIN service binding and defaults to the Worker origin", async () => {
  const variables = await terraformFile("variables.tf");
  const originType = variableBody(variables, "origin_type");
  assert.match(originType, /type\s*=\s*string\s*default\s*=\s*"worker"/);
  assert.match(originType, /contains\(\["worker", "dns"\], var\.origin_type\)/);
  assert.match(originType, /!\(var\.create_staging_origin && var\.origin_type == "dns"\)/);

  const main = await terraformFile("main.tf");
  const app = resourceBody(main, "cloudflare_workers_script", "app");
  assert.match(app, /bindings\s*=\s*concat\(/);
  assert.match(app, /\[for binding in \[\{\s*name\s*=\s*"ORIGIN"[\s\S]*?\}\] : binding if var\.origin_type != "dns"\]/);

  const basic = await terraformFile("examples/basic.tfvars.example");
  assert.match(basic, /^origin_type\s*=\s*"dns"$/m);
  assert.match(basic, /^origin_service_name\s*=\s*""$/m);
});

nodeTest("staging inputs default off and validate selected origin self-binding semantics", async () => {
  const variables = await terraformFile("variables.tf");
  assert.match(variableBody(variables, "create_staging_origin"), /type\s*=\s*bool\s*default\s*=\s*false/);
  assert.match(variableBody(variables, "origin_service_name"), /condition\s*=\s*var\.create_staging_origin \|\| var\.origin_type == "dns" \|\| \(length\(trimspace\(var\.origin_service_name\)\) > 0 && var\.origin_service_name != var\.worker_name\)/);
  assert.match(variableBody(variables, "origin_service_environment"), /default\s*=\s*"production"/);
});

nodeTest("staging origin has no workers.dev or preview URL before the public route is attached", async () => {
  const main = await terraformFile("main.tf");
  const disabled = resourceBody(main, "cloudflare_workers_script_subdomain", "staging_origin_disabled");
  assert.match(disabled, /count\s*=\s*var\.create_staging_origin \? 1 : 0/);
  assert.match(disabled, /account_id\s*=\s*var\.account_id/);
  assert.match(disabled, /script_name\s*=\s*local\.staging_origin_worker_name/);
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

nodeTest("examples keep production defaults safe and isolate staging resources", async () => {
  const basic = await terraformFile("examples/basic.tfvars.example");
  assert.match(basic, /^create_staging_origin\s*=\s*false$/m);
  const staging = await terraformFile("examples/staging.tfvars.example");
  const expected = {
    protected_hostname: '"staging.example.com"',
    admin_hostname: '"admin-staging.example.com"',
    worker_name: '"moqesh-example-staging"',
    d1_database_name: '"moqesh-example-staging-events"',
    create_staging_origin: "true",
    origin_service_name: '""',
    enable_public_route: "false",
  };
  assert.doesNotMatch(staging, /^staging_origin_worker_name\s*=/m);
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

nodeTest("webhook alerts default enabled and the staging example disables delivery", async () => {
  const variables = await terraformFile("variables.tf");
  assert.match(variableBody(variables, "alert_webhook_enabled"), /type\s*=\s*bool\s*default\s*=\s*true/);

  const main = await terraformFile("main.tf");
  const app = resourceBody(main, "cloudflare_workers_script", "app");
  assert.match(app, /name\s*=\s*"ALERT_WEBHOOK_ENABLED"\s*type\s*=\s*"plain_text"\s*text\s*=\s*tostring\(var\.alert_webhook_enabled\)/);
  const secretProvisioner = resourceBody(main, "terraform_data", "worker_secrets");
  assert.match(secretProvisioner, /MOQESH_ALERT_WEBHOOK_ENABLED\s*=\s*tostring\(var\.alert_webhook_enabled\)/);
  assert.match(secretProvisioner, /var\.alert_webhook_enabled/);

  const staging = await terraformFile("examples/staging.tfvars.example");
  const basic = await terraformFile("examples/basic.tfvars.example");
  assert.match(staging, /^alert_webhook_enabled\s*=\s*false$/m);
  assert.doesNotMatch(basic, /^alert_webhook_enabled\s*=\s*false$/m);

  const outputs = await terraformFile("outputs.tf");
  assert.match(outputs, /output "secret_binding_names" \{[\s\S]*?value\s*=\s*var\.alert_webhook_enabled\s*\?[\s\S]*?:\s*\[var\.lure_key_secret_binding_name\]/);
});

nodeTest("Terraform lure path lists match the Worker's disclosure lures", async () => {
  const [lureSource, variablesText, ...tfvars] = await Promise.all([
    readFile(new URL("../../src/lures.ts", import.meta.url), "utf8"),
    readFile(new URL("../variables.tf", import.meta.url), "utf8"),
    readFile(new URL("../examples/basic.tfvars.example", import.meta.url), "utf8"),
    readFile(new URL("../examples/staging.tfvars.example", import.meta.url), "utf8"),
  ]);
  const workerPaths = [...lureSource.matchAll(/^  "(\/[^"]+)": \{$/gm)].map((match) => match[1]);
  const localBlock = variablesText.match(/disclosure_lure_paths = \[([\s\S]*?)\]/)?.[1] ?? "";
  const terraformPaths = [...localBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  assert.equal(workerPaths.length, 9);
  assert.deepEqual(terraformPaths, workerPaths);
  for (const text of tfvars) {
    const listed = JSON.parse(text.match(/^lure_paths\s*=\s*(\[.*\])$/m)[1]);
    const bait = text.match(/^bait_api_path\s*=\s*"([^"]+)"$/m)[1];
    assert.deepEqual(listed, [...workerPaths, bait]);
  }
});

nodeTest("AgentSession migration is sent only until it has been applied", async () => {
  const [mainText, variablesText] = await Promise.all([
    readFile(new URL("../main.tf", import.meta.url), "utf8"),
    readFile(new URL("../variables.tf", import.meta.url), "utf8"),
  ]);
  assert.match(
    mainText,
    /migrations = var\.agent_session_migration_applied \? null : \{\s*new_tag\s*= "v1"\s*new_sqlite_classes = \["AgentSession"\]\s*\}/,
  );
  assert.match(
    variablesText,
    /variable "agent_session_migration_applied" \{[^}]*type\s*= bool\s*default\s*= false/,
  );
});
