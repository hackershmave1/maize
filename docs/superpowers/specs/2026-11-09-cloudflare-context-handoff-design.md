# Cloudflare Deployment Context Handoff Design

**Status:** Approved for documentation work
**Date:** 2026-11-09

This is a historical handoff proposal, not current deployment status. Some
proposed source-document copies were never added to this repository. Use the
current deployment guide, Cloudflare README, and anonymized staging record
instead of treating the original locations or status below as current.

## Goal

Make the approved Cloudflare deployment architecture, implementation record,
operational guide, and current staging gate discoverable to Copilot and future
contributors working in the Moqesh repository.

## Source of truth and locations

- Copy the approved design from AnimalPot to
  `docs/superpowers/specs/2026-11-08-cloudflare-deployment-design.md`.
- Copy the implementation plan from AnimalPot to
  `docs/superpowers/plans/2026-11-08-cloudflare-deployment.md`.
- Keep the original AnimalPot files unchanged as the source copies.
- Keep `cloudflare/README.md` authoritative for customer setup, Terraform
  operations, credentials, approvals, rollback, and uninstall.
- Keep `.github/prompts/maize-cloudflare-deploy.prompt.md` authoritative
  for the deployment agent's discovery and approval workflow.
- Add `.github/copilot-instructions.md` as a concise repository handoff. It
  points to the design, plan, README, and deployment prompt, states that the
  Cloudflare work is on the feature branch, and forbids deployment without
  explicit approval of the exact Terraform plan.

## Current status to communicate

Tasks 1–6 are implemented in the feature worktree and have passed local tests,
typechecking, build/dry-run, and Terraform configuration validation. Task 7
staging acceptance is pending. No Cloudflare resources have been provisioned
or deployed. Do not claim staging performance, cost, or end-to-end behavior
has been measured.

The implementation plan must summarize this status near its beginning so its
original unchecked execution steps are not mistaken for work that has not
happened. Task 7 remains the next operational task and requires a customer
staging zone, protected credentials, a reviewed plan, and explicit approval.

## Copilot workspace guidance

The code and documentation must be opened from the checkout containing the
Cloudflare implementation. Do not assume that a parent clone and a feature
worktree contain the same branch or files. No developer-specific filesystem
location is required.

## Non-goals

- Do not move or delete the original AnimalPot documents.
- Do not merge the feature branch or change the parent checkout.
- Do not create customer-specific Terraform variables, credentials, or
  secrets.
- Do not provision, apply, deploy, or enable a production route.
- Do not mark Task 7 complete without actual customer-approved staging tests.

## Acceptance criteria

1. Both approved source documents are copied into the feature worktree with
   their technical content preserved.
2. The copied plan has a concise, accurate implementation-status section and
   identifies Task 7 as pending.
3. Copilot instructions provide links to the authoritative docs and enforce
   staging/approval boundaries.
4. The Cloudflare README links to the design, plan, and deployment prompt.
5. Links resolve within the repository, no contradictory deployment guidance
   is introduced, and the original AnimalPot files remain unchanged.
