import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const text = (file) => readFileSync(new URL(file, root), "utf8");

test("current documentation and deployment prompts use MAIZE branding", () => {
  assert.match(text("README.md"), /^# MAIZE\n/);
  assert.ok(text("README.md").includes('src="cloudflare/dashboard/public/maize-logo.png"'));
  for (const file of [
    "README.md",
    "docs/DEPLOYMENT.md",
    "cloudflare/README.md",
    ".github/prompts/maize-deploy.prompt.md",
    ".github/prompts/maize-cloudflare-deploy.prompt.md",
  ]) {
    assert.doesNotMatch(text(file), formerBrand);
  }
  assert.ok(text("docs/DEPLOYMENT.md").includes("https://github.com/hackershmave1/maize.git"));
  assert.ok(text("docs/DEPLOYMENT.md").includes("/maize-deploy"));
});

test("dashboard visible and accessible branding uses MAIZE", () => {
  assert.match(text("cloudflare/dashboard/index.html"), /<title>MAIZE Control Room<\/title>/);
  const app = text("cloudflare/dashboard/src/App.tsx");
  assert.match(app, /aria-label="MAIZE Control Room home"/);
  assert.match(app, /<strong>MAIZE<\/strong>/);
});

const formerBrand = new RegExp(["animal", "[ _-]?", "pot"].join(""), "i");

test("no current tracked filename or text retains the former project brand", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    const path = new URL(file, root);
    if (!existsSync(path)) continue;
    assert.doesNotMatch(file, formerBrand, `Obsolete filename: ${file}`);
    const data = readFileSync(path);
    if (!data.includes(0)) assert.doesNotMatch(data.toString("utf8"), formerBrand, `Obsolete branding: ${file}`);
  }
});

test("README and both dashboards reference the same valid PNG logo", () => {
  const logo = readFileSync(new URL("cloudflare/dashboard/public/maize-logo.png", root));
  assert.deepEqual(logo.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(logo.readUInt32BE(16) >= 220);
  assert.ok(logo.readUInt32BE(20) >= 220);
  assert.deepEqual(readFileSync(new URL("web/public/maize-logo.png", root)), logo);
  for (const file of ["cloudflare/dashboard/index.html", "web/index.html"]) {
    assert.ok(text(file).includes('type="image/png" href="/maize-logo.png"'), `Missing favicon in ${file}`);
  }
  for (const file of ["cloudflare/dashboard/src/App.tsx", "web/src/components/layout/Sidebar.tsx"]) {
    assert.ok(text(file).includes('src="/maize-logo.png"'), `Missing brand image in ${file}`);
  }
});
