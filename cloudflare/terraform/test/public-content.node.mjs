import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const privateFingerprints = new Set([
  "11be997e859b4ac85b7d4f992e006f2732e62ad9cee51d2514545b902c6da6e6",
  "1175d800aaad84e14d3dc688853feb19ea0ebd1a9902b96e7f2d781d640b2ffb",
]);
const diagramName = ["worker", "route", "flows"].join("-");

function hasPrivateIdentifier(text, fingerprints = privateFingerprints) {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  tokens.push(...(text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []));
  return tokens.some((token) => fingerprints.has(createHash("sha256").update(token).digest("hex")));
}

test("identifier scanning covers host labels, resource names, filenames, and source addresses", () => {
  const fingerprints = new Set(["privatefixture", "192.0.2.7"].map(
    (token) => createHash("sha256").update(token).digest("hex"),
  ));
  for (const text of [
    "https://staging.PRIVATEFIXTURE.example",
    "worker-privatefixture-staging",
    "examples/privatefixture.tfvars.example",
    "Source: 192.0.2.7",
  ]) {
    assert.equal(hasPrivateIdentifier(text, fingerprints), true);
  }
  assert.equal(hasPrivateIdentifier("https://staging.example.com", fingerprints), false);
});
test("current tracked content contains no known private deployment identifiers or home paths", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    const path = new URL(file, new URL("../../../", import.meta.url));
    if (!existsSync(path)) continue;
    assert.equal(hasPrivateIdentifier(file), false, `Private identifier in tracked filename: ${file}`);
    const data = readFileSync(path);
    if (data.includes(0)) continue;
    const content = data.toString("utf8");
    assert.equal(hasPrivateIdentifier(content), false, `Private deployment identifier in ${file}`);
    assert.doesNotMatch(content, /\/home\/[a-z0-9_.-]+\//i, `Private home path in ${file}`);
    assert.equal(content.includes(diagramName), false, `Removed diagram reference in ${file}`);
  }
});

test("removed diagram is absent and documentation entry points contain the approved slogan", () => {
  assert.equal(existsSync(new URL(`../../../docs/${diagramName}.svg`, import.meta.url)), false);
  for (const file of ["README.md", "docs/DEPLOYMENT.md"]) {
    const content = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    assert.ok(content.includes("The best defense is a good offense."), `Missing slogan in ${file}`);
  }
});
