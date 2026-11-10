# MAIZE logo and complete branding

## Approved visual direction

Generate an original geometric M-shaped labyrinth logo on deep charcoal with
mint/cyan paths and restrained amber accents. Avoid animals, corn, generic
robot heads, and imitation of existing brands. Use a clear silhouette that
remains recognizable as a small dashboard icon. Keep the wordmark as real HTML
text rather than depending on generated image lettering.

## Integration

Store the generated PNG at `cloudflare/dashboard/public/maize-logo.png`, embed
it in the root README, and use it for the current dashboard brand and favicon.
Copy the same asset to `web/public/maize-logo.png` for the retained legacy
dashboard so it also has consistent branding until removal.

Replace all remaining former project-brand text and asset filenames in tracked
source, documentation, historical records, and regression tests. Remove old
branded image assets. Preserve Moqesh upstream copyright and attribution,
runtime identifiers, and unrelated local customization.

Update the pending Cloudflare-only plan so it retains the current logo in the
Cloudflare dashboard and deletes only the legacy copy with `web/`.

## Verification and safety

Inspect the generated image, verify PNG format and dimensions, and check README,
favicon and dashboard links resolve. Extend offline branding tests to scan
tracked filenames and text for former branding without reproducing it literally.
Run deployment tests, dashboard type-check/build, and legacy SPA build because
its sidebar and document metadata are affected. No push, deployment, repository
history rewrite, or live resource rename is authorized.
