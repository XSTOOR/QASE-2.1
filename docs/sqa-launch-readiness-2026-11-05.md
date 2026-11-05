# SQA launch readiness correction

The Start quality review button could stay disabled after a saved device was
restored asynchronously. Device hydration repainted TEST ON but did not notify
the launcher. A browser regression reproduced a populated device and completed
required fields with Start still disabled. Manual device selection did update it.

Bootstrap now recalculates SQA readiness after device restoration or removal.
The footer names missing requirements and announces readiness without repeatedly
announcing unchanged text. HTTP/HTTPS URL validation, release/environment,
permission and explicit device selection remain required. UI version
`20261105-4` refreshes the app and stylesheet assets.

The new launch journey uses actual UI controls and the real isolated scope API.
It selects a device, holds restoration while completing the form, then releases
the catalog response and requires Start to become enabled without another edit.
It also verifies missing-build/invalid-URL/permission messages, desktop/mobile
layout, assessment creation and exactly one explicit launch message. Only that
message endpoint is intercepted; no provider key or model execution is used.
This is launch-flow evidence, not evidence that the model completed an assessment.

All three browser engines must pass the new launch journey in the SQA release
gate. Result validation rejects missing restoration/start coverage, multiple
dispatches, browser errors or model activity. CI retains launcher screenshots
and results while excluding private runtime state.
