# SQA execution efficiency review

Release candidate: `qase-sqa-2026-11-06-efficiency-r1`  
UI version: `20261106-1`

## Observed problem

The Drytis browser assessment completed useful technical checks but repeatedly
sent a large accumulated model conversation. The fixed safety budget correctly
stopped the run, leaving 20 controls unresolved. The report described those
stops like ordinary blocked evidence, which made them look the same as missing
documents or a browser obstacle.

## Change

- Checkpoint and compact the SQA provider conversation after every recorded
  browser workflow, instead of waiting for many activities or a large token
  estimate.
- Keep the six `SQA-WEB` controls as the mandatory first phase. The host rejects
  non-technical results until all six have a result, and the prompt records the
  initial/diagnostic/accessibility/responsive controls and the navigation/form
  controls in two bounded batches.
- Keep pending control descriptions in the working prompt and replace completed
  descriptions with a concise control/result index.
- Hide later browser-eligible and documentary control descriptions until their
  execution phase begins, preventing premature assurance work from consuming
  the technical-check budget.
- Retain fewer completed browser/tool rounds in SQA inference context while
  leaving other modes on their existing defaults.
- Keep the fixed browser and input-token safety limits unchanged.
- Label controls left by a safety stop as **Stopped early: budget reached**.
  Missing documentary evidence and browser/runtime obstacles remain separate.
- Recognize the legacy safety-stop wording so existing reports are presented
  accurately without changing their stored results.

## Verification

- Focused SQA and context tests passed.
- The complete Node test suite passed with installed browser engines.
- The isolated SQA release gate passed startup, launch and evidence journeys in
  Chromium, Firefox and WebKit.
- A controlled live qualification using the configured custom gateway finalized
  all 30 controls. All six technical browser controls passed, none were blocked,
  and restart persistence, historical exports, account isolation and hybrid-mode
  isolation passed. The run used 415,226 estimated input tokens, below the live
  qualification acceptance ceiling.
- A fresh isolated qualification of `https://drytis.com/` finalized all 30
  controls with no failures or unassessed controls. Five of six technical web
  controls passed. `SQA-WEB-003` was precisely blocked because the public site
  has no empty labeled email field on a safe same-origin GET form; the runner did
  not bypass that limitation. Historical exports, restart persistence,
  cross-account isolation, hybrid isolation and credential scanning passed.
  The six technical results were recorded by approximately 255,000 input tokens;
  the completed run used 413,692 estimated input tokens.
- The earlier Drytis assessment is unchanged; its existing unresolved results
  now display as 20 budget stops and one browser/form obstacle.

This document records source validation, not deployment or production
activation.
