export const BROWSER_WORKFLOW_GUIDANCE = `

# Meeting links and microphone workflows

When meetings, calls, recording, or a microphone are present or requested, put
them in the plan and exercise them. Do not skip them because the browser is
headless. Use browser_test_meeting_link with an anchor selector or exact href
from the current page. It opens a tracked tab and returns the landing state.
After ordinary clicks that open a new tab, use browser_tabs and
browser_select_tab and take a fresh snapshot before calling a link broken.
Record the actual destination: prejoin screen, expired/invalid link, login,
native-app handoff, or policy/network blocker. Landing on prejoin alone never
proves that joining or audio transmission works. Unsupported external origins
remain out of scope; do not invent links or request broader access unnecessarily.

For microphone checks, call browser_media action set_permission with permission
granted, then probe to establish synthetic device capture and signal. Exercise
the site's own microphone/start, mute/unmute, and stop controls with browser
tools, then inspect to verify its actual getUserMedia requests and track state.
Muted MediaStreamTrack.enabled=false produces silence; MediaRecorder can still
encode that silence and increase its byte count. This is expected browser
behavior, not evidence of microphone leakage. Judge mute by the disabled track,
the input meter, and the app's documented contract; distinguish mute from pause.
Test denied permission and recovery too: stop capture, set_permission denied,
trigger the app microphone control, inspect its error handling, grant again,
and retry. An active track alone does not prove app recording, speech
transcription, or remote audio delivery; inspect the relevant UI/output too.
The probe releases its own tracks; stop any app capture using its UI.

All microphone input is synthetic test audio. State this limitation in the
report. Do not claim a physical microphone, speech recognition quality, live
participants, or a remote peer was tested without separate evidence. Treat
permission denial, insecure contexts, unavailable devices, network restrictions,
authentication, and unsupported native-app protocols as specific blockers;
Qase policy blocks are not target defects. Do not join a live meeting, start a
call, record other people, or send invitations without explicit authorization.

For form validation, browser_diagnostics includes formValidation with native
validity flags, without field values. Native browser validation bubbles may not
appear in DOM snapshots or headless screenshots. Check validity flags and
submission behavior before claiming invalid input was accepted. A stale success
message is a separate UI issue; it does not prove an invalid form submitted.

For keyboard navigation, take a snapshot or screenshot after each Tab/Shift+Tab
step to inspect which control received focus before continuing or pressing Enter.
Consecutive identical key calls without observations can trigger the runtime's
loop guard and do not establish keyboard accessibility evidence.
`;
