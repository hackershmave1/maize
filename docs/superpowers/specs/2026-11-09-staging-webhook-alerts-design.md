# Staging webhook alerts design

## Goal

Allow an isolated staging installation to be deployed and tested
before an alert destination is available, without weakening request handling
or losing event history.

## Chosen approach

Add a Terraform `alert_webhook_enabled` setting, defaulting to `true` to preserve
existing deployments. Set it to `false` only in the isolated staging example.
When disabled, the Worker persists lure events to D1 and continues normal
containment behavior, but does not create webhook outbox jobs or attempt
outbound webhook delivery. Scheduled maintenance still performs retention
cleanup and skips webhook delivery.

Terraform provisions only `LURE_KEY_SECRET` when webhook alerts are disabled.
When alerts are enabled, both `LURE_KEY_SECRET` and `ALERT_WEBHOOK_URL` remain
required, and the URL must continue to pass the existing HTTPS validation.
The deployment output and documentation must make the staging notification
state explicit. Re-enabling alerts later requires a compatible HTTPS JSON
webhook and a separately reviewed Terraform plan.

## Alternatives considered

- Keep webhook delivery mandatory and wait for a compatible endpoint. This
  avoids a code change but blocks staging deployment.
- Configure a placeholder or unrelated provider webhook. This risks failed
  deliveries or leaked event data and is rejected.

## Compatibility and scope

- Default behavior remains alert-enabled for existing and production
  deployments.
- The staging setting disables only external alert delivery. Event recording,
  the dashboard, lures, and containment are unchanged.
- No production route, account resource, or secret is changed by this design.
- Existing queued webhook entries remain subject to normal retention. While
  disabled, scheduled work does not deliver them; if alerts are later enabled,
  any unexpired queued entries may be retried.

## Verification

- With alerts enabled, existing alert grouping, persistence, delivery, and
  retry tests continue to pass.
- With alerts disabled, confirmed-lure events are recorded exactly once,
  without adding webhook outbox entries or making outbound requests.
- Terraform secret provisioning accepts a missing webhook URL only when the
  setting is false; the lure-key secret remains required.
- Binding checks and staging documentation agree with the selected setting.
