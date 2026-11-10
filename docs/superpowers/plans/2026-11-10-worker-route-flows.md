# Worker Route Flows Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a readable, accessible SVG that shows app traffic before and after the Animal Pot public Worker route is enabled and explains the safe two-step rollout.

**Architecture:** Create one self-contained SVG asset in `docs/` and embed it in the generic deployment guide. Keep the illustration static, generic, and isolated from Terraform, application code, and live Cloudflare resources.

**Tech Stack:** SVG 1.1/XML, Markdown, Python standard-library XML parser for validation.

---

### Task 1: Create the flow diagram

**Files:**
- Create: `docs/worker-route-flows.svg`

- [x] **Step 1: Define the SVG document structure**

Create a standalone SVG with a responsive `viewBox`, explicit width/height, a `<title>` and `<desc>`, a light background, readable text sizes, and arrows with directional markers. Use distinct labeled panels for Route OFF and Route ON; ensure color is not the only distinction.

- [x] **Step 2: Draw the Route OFF request flow**

Show `Browser` → `Cloudflare DNS / Proxy` → `Existing app origin`. Label the panel `Route OFF — before activation` and add a note that the public Worker route is absent and public app requests do not pass through Animal Pot.

- [x] **Step 3: Draw the Route ON request and admin flows**

Show `Browser` → `Cloudflare DNS / Proxy` → `Animal Pot Worker` and branch Worker outcomes:

1. `Normal request` → `Existing app origin` with a pass-through label.
2. `Lure request` → `Synthetic decoy`.
3. `Decoy-key reuse` → `Maze / fake API chain` → `Blocked from app`.

Show the distinct `admin.example.com` path through `Cloudflare Access` to the Worker dashboard. Label the public route `protected-hostname/* — every request on this hostname`.

- [x] **Step 4: Add the deployment sequence and safety note**

Add a bottom strip with two ordered boxes:

1. `Bootstrap`: `enable_public_route = false`; creates the Worker/data/admin resources; public app traffic is unchanged.
2. `Enable public route`: change to `true`; review the new saved Terraform plan; explicitly approve; apply to attach `protected-hostname/*`.

Add a compact note that disabling the route also requires a separately reviewed plan and that the route changes request handling, not the app's visual design or source code. Mark the diagram as a generic example, not a live-account status report.

- [x] **Step 5: Validate SVG XML and required content**

Run:

```sh
python3 - <<'PY'
from pathlib import Path
import xml.etree.ElementTree as ET

path = Path("docs/worker-route-flows.svg")
root = ET.parse(path).getroot()
assert root.tag.endswith("svg")
assert root.attrib.get("viewBox")
text = "".join(root.itertext())
for label in (
    "Route OFF", "Route ON", "Animal Pot Worker", "Existing app origin",
    "Synthetic decoy", "Maze", "Blocked from app",
    "enable_public_route = false", "enable_public_route = true",
    "review", "approve", "admin.example.com",
):
    assert label.lower() in text.lower(), f"missing diagram label: {label}"
assert any(node.tag.endswith("title") for node in root)
assert any(node.tag.endswith("desc") for node in root)
print("SVG XML and required diagram labels are valid")
PY
```

Expected: `SVG XML and required diagram labels are valid`.

### Task 2: Embed and verify the diagram

**Files:**
- Modify: `docs/DEPLOYMENT.md`

- [x] **Step 1: Embed the SVG near the introduction**

Immediately after the opening explanation and before the placeholder table, add:

```markdown
![Diagram comparing app traffic with the Worker route off and on, plus the two-step deployment flow.](./worker-route-flows.svg)
```

- [x] **Step 2: Verify the relative link and diff**

Run:

```sh
python3 - <<'PY'
from pathlib import Path
guide = Path("docs/DEPLOYMENT.md")
diagram = guide.parent / "worker-route-flows.svg"
assert diagram.is_file()
assert "![Diagram comparing app traffic with the Worker route off and on, plus the two-step deployment flow.](./worker-route-flows.svg)" in guide.read_text()
print("Deployment guide embeds the SVG diagram")
PY
git diff --check
```

Expected: the Python check prints `Deployment guide embeds the SVG diagram`; `git diff --check` reports no whitespace errors.

- [x] **Step 3: Inspect rendered SVG**

Open `docs/worker-route-flows.svg` in a browser or SVG-capable image viewer. Confirm the arrows are legible, the OFF/ON contrast is obvious, every line has a readable label, and the bottom rollout sequence does not imply the bootstrap attaches the public route.

- [x] **Step 4: Commit the artifact**

```sh
git add docs/worker-route-flows.svg docs/DEPLOYMENT.md
git commit -m "docs: add Worker route flow diagram" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
