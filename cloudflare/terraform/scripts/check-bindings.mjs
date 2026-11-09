import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WRANGLER_PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000001";

// cloudflare/terraform-provider-cloudflare v5.28.1 internal/services/workers_script/schema.go
const ASSET_CONFIG_FIELDS = new Set([
  "headers", "redirects", "html_handling", "not_found_handling",
  "run_worker_first", "serve_directly", "base_path",
]);

export function checkDeploymentBindings(wrangler, terraform) {
  const errors = [];
  const terraformBindings = new Map(
    [...terraform.matchAll(/\{\s*name\s*=\s*"([^"]+)"\s*type\s*=\s*"([^"]+)"/g)]
      .map(([, name, type]) => [name, type]),
  );
  const requireBinding = (name, type, source) => {
    if (terraformBindings.get(name) !== type) {
      errors.push(`${source} binding ${name} must be declared in Terraform as type ${type}.`);
    }
  };

  for (const service of wrangler.services ?? []) {
    requireBinding(service.binding, "service", "Wrangler");
  }
  for (const item of wrangler.durable_objects?.bindings ?? []) {
    requireBinding(item.name, "durable_object_namespace", "Wrangler");
    if (!new RegExp(`class_name\\s*=\\s*"${item.class_name}"`).test(terraform)) {
      errors.push(`Terraform Durable Object binding ${item.name} must use class ${item.class_name}.`);
    }
  }
  if (!/new_sqlite_classes\s*=\s*\["AgentSession"\]/.test(terraform)) {
    errors.push("Terraform must create the AgentSession SQLite Durable Object namespace.");
  }
  for (const item of wrangler.d1_databases ?? []) {
    requireBinding(item.binding, "d1", "Wrangler");
    if (item.database_id !== WRANGLER_PLACEHOLDER_ID) {
      errors.push("Wrangler local tests must keep the documented local-only D1 placeholder ID.");
    }
  }
  if (wrangler.assets?.binding !== "ASSETS") {
    errors.push("Wrangler local assets must use the ASSETS binding.");
  }
  if (!/assets\s*=\s*\{[\s\S]*?directory\s*=\s*"\$\{path\.module\}\/\.\.\/dashboard\/dist"[\s\S]*?run_worker_first\s*=\s*true/.test(terraform)) {
    errors.push("Terraform must upload dashboard/dist with run_worker_first enabled.");
  }
  const stagingOrigin = terraform.match(
    /resource\s+"cloudflare_workers_script"\s+"staging_origin"\s*\{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  const stagingBindings = stagingOrigin.match(/\bbindings\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  if (!/\{\s*name\s*=\s*"ASSETS"\s*type\s*=\s*"assets"\s*\}/.test(stagingBindings)) {
    errors.push("Terraform staging origin must declare ASSETS in bindings with type assets (provider 5.28.1).");
  }
  if (!/\{\s*name\s*=\s*"STAGING_HOSTNAME"\s*type\s*=\s*"plain_text"\s*text\s*=\s*var\.protected_hostname\s*\}/.test(stagingBindings)) {
    errors.push("Terraform staging origin must bind STAGING_HOSTNAME as plain_text from var.protected_hostname.");
  }
  const stagingAssetConfig = stagingOrigin.match(/\bassets\s*=\s*\{[\s\S]*?\bconfig\s*=\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  for (const [, field] of stagingAssetConfig.matchAll(/^\s*(\w+)\s*=/gm)) {
    if (!ASSET_CONFIG_FIELDS.has(field)) {
      errors.push(`Cloudflare provider 5.28.1 does not support staging origin assets.config.${field}.`);
    }
  }

  for (const name of Object.keys(wrangler.vars ?? {})) {
    requireBinding(name, "plain_text", "Wrangler");
  }
  for (const name of ["LURE_KEY_SECRET", "ALERT_WEBHOOK_URL"]) {
    if (Object.hasOwn(wrangler.vars ?? {}, name)) {
      errors.push(`${name} must be a Worker secret, not a Wrangler plain-text variable.`);
    }
  }
  if (!/\{\s*name\s*=\s*"EVENTS_DB"\s*type\s*=\s*"d1"\s*database_id\s*=\s*cloudflare_d1_database\.events\.id/.test(terraform)) {
    errors.push("The Worker D1 binding must use cloudflare_d1_database.events.id.");
  }
  if (!/MOQESH_D1_DATABASE_ID\s*=\s*cloudflare_d1_database\.events\.id/.test(terraform)) {
    errors.push("The D1 migration runner must receive the real Terraform database ID.");
  }
  if (terraform.includes(WRANGLER_PLACEHOLDER_ID)) {
    errors.push("Terraform must never use Wrangler's local D1 placeholder ID.");
  }
  if (!/keep_bindings\s*=\s*\["secret_text"\]/.test(terraform)) {
    errors.push("Terraform Worker updates must preserve separately provisioned secret_text bindings.");
  }
  if (!/resource\s+"cloudflare_workers_script_subdomain"\s+"disabled"\s*\{[\s\S]*?enabled\s*=\s*false[\s\S]*?previews_enabled\s*=\s*false/.test(terraform)) {
    errors.push("Terraform must disable both workers.dev and Worker preview URLs.");
  }
  const stagingOriginSubdomain = terraform.match(
    /resource\s+"cloudflare_workers_script_subdomain"\s+"staging_origin_disabled"\s*\{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  if (
    !/\bcount\s*=\s*var\.create_staging_origin\s*\?\s*1\s*:\s*0\b/.test(stagingOriginSubdomain)
    || !/\benabled\s*=\s*false\b/.test(stagingOriginSubdomain)
    || !/\bpreviews_enabled\s*=\s*false\b/.test(stagingOriginSubdomain)
  ) {
    errors.push("Terraform staging origin must conditionally disable both workers.dev and Worker preview URLs with create_staging_origin.");
  }
  const cronTrigger = terraform.match(
    /resource\s+"cloudflare_workers_cron_trigger"\s+"scheduled"\s*\{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  const expectedCrons = [...(wrangler.triggers?.crons ?? [])].sort();
  const configuredCrons = [
    ...cronTrigger.matchAll(/\bcron\s*=\s*"([^"]+)"/g),
  ].map(([, cron]) => cron).sort();
  if (
    !/script_name\s*=\s*cloudflare_workers_script\.app\.script_name/.test(cronTrigger)
    || expectedCrons.length === 0
    || JSON.stringify(configuredCrons) !== JSON.stringify(expectedCrons)
  ) {
    errors.push("Terraform must attach the Worker scheduled trigger with the Wrangler cron schedules.");
  }
  if (!terraform.includes("var.origin_service_name")) {
    errors.push("Terraform must bind the existing customer origin Worker as ORIGIN.");
  }
  if (!terraform.includes("var.lure_key_secret_binding_name") || !terraform.includes("LURE_KEY_SECRET")) {
    errors.push("Terraform must retain the per-installation LURE_KEY_SECRET reference.");
  }
  if (!terraform.includes("var.alert_webhook_secret_binding_name") || !terraform.includes("ALERT_WEBHOOK_URL")) {
    errors.push("Terraform must retain the ALERT_WEBHOOK_URL secret reference.");
  }

  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const terraformDirectory = new URL("../", import.meta.url);
  const [wranglerText, terraformFiles] = await Promise.all([
    readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
    readdir(terraformDirectory),
  ]);
  const terraform = (
    await Promise.all(
      terraformFiles
        .filter((name) => name.endsWith(".tf"))
        .sort()
        .map((name) => readFile(new URL(name, terraformDirectory), "utf8")),
    )
  ).join("\n");
  const errors = checkDeploymentBindings(JSON.parse(wranglerText), terraform);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Wrangler local and Terraform deployment bindings are consistent.");
  }
}
