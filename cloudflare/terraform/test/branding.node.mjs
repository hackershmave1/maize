import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const text = (file) => readFileSync(new URL(file, root), "utf8");

test("current documentation and deployment prompts use MAIZE branding", () => {
  assert.match(text("README.md"), /^# MAIZE\n/);
  assert.doesNotMatch(text("README.md"), /<img[^>]*animal-pot-logo/);
  for (const file of [
    "README.md",
    "docs/DEPLOYMENT.md",
    "cloudflare/README.md",
    ".github/prompts/maize-deploy.prompt.md",
    ".github/prompts/maize-cloudflare-deploy.prompt.md",
  ]) {
    assert.doesNotMatch(text(file), /Animal Pot|animalpot-deploy|animalpot-cloudflare-deploy/);
  }
  assert.ok(text("docs/DEPLOYMENT.md").includes("https://github.com/hackershmave1/maize.git"));
  assert.ok(text("docs/DEPLOYMENT.md").includes("/maize-deploy"));
  for (const file of ["animalpot-deploy.prompt.md", "animalpot-cloudflare-deploy.prompt.md"]) {
    assert.equal(existsSync(new URL(`.github/prompts/${file}`, root)), false);
  }
});

test("dashboard visible and accessible branding uses MAIZE", () => {
  assert.match(text("cloudflare/dashboard/index.html"), /<title>MAIZE Control Room<\/title>/);
  const app = text("cloudflare/dashboard/src/App.tsx");
  assert.match(app, /aria-label="MAIZE Control Room home"/);
  assert.match(app, /<strong>MAIZE<\/strong>/);
});
