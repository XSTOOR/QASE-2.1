# Ticket #15694 — `.qase/sessions.json.tmp-67` cleanup: investigation report

> **STATUS (2026-10-09): BLOCKED — pending platform maintenance (ext4 volume repair).**
> Reopened per customer instruction. Ticket moved back to In Progress; Done only after the
> repair criteria below are met and re-verified.
>
> **Repair requirements (platform-side, in order):**
> 1. **Verified backup FIRST**: snapshot the entire `/workspace` volume (`.qase/` alone is
>    155 MB; prefer a full-volume snapshot) and restore-check the backup before any repair.
>    No offline repair without a verified backup.
> 2. Detach/unmount the volume; run **`e2fsck -fD`** on `/dev/nvme0n1` from the host/storage layer.
> 3. Remount and restart the container.
>
> **Re-close criteria (all must pass):** corrupt entry gone (or e2fsck report documented);
> all 9 `.qase` store JSON files parse OK with unchanged counts (auth 4, sessions 319,
> bugs 32, environments 38,762, feedback 43, matrix-runs 143, test-cases 1,501, outbox 2,
> device-catalog 9 — counts as of 2026-10-09); app RUNNING, preview 200; QA run creation
> returns 201 and the run appears in GET /api/sessions; no other `.tmp-*` or store data damaged.
>
> **Customer directive (2026-10-09T17:12Z):** before ANY repair, the platform team must
> (a) independently confirm the correct filesystem device — the device path observed from
> inside the container (`/dev/nvme0n1`) is a container-view observation and must NOT be
> assumed correct for the host-side repair — and (b) produce a **restore-tested backup**.
> Repair proceeds only after both are confirmed.

## Exact filesystem error (R1)

- Every operation on the file fails with **`EUCLEAN` ("Structure needs cleaning")** — `rm`, `unlink`,
  `rm -d`, `truncate`, `mv`, `lsof`, even `stat`/`ls -la` (shows `-?????????  ? ? ?`).
- The file survived a full **container replacement**, so this is **volume-level ext4 corruption**,
  not a container process state.
- Kernel evidence (`dmesg`, `/sys/fs/ext4/nvme0n1`):
  - `ext4_lookup:1789: inode #491716: comm rm: **deleted inode referenced: 491738**` — the `.qase`
    directory (inode 491716) holds a stale dirent for the file whose backing inode (491738) was
    already deleted. Lookup resolves to a deleted inode → EUCLEAN on any access.
  - Filesystem reports **220,416 accumulated errors** since last fsck, initial error 2026-08-31
    (time 1789021311) in `ext4_validate_block_bitmap` — long-standing damage from the prior
    disk-full/ENOSPC events (see memory: env-postmortems-enospc-pids.md).
  - `ext4_dirblock_csum_verify` warnings on other inodes: "Please run e2fsck -D".

## Why it cannot be removed in-container (R1)

- `/workspace` is a **live-mounted ext4 filesystem**; `e2fsck`/`debugfs` may only operate on
  unmounted block devices. No container-level tool (`rm`, `unlink`, `truncate`, `mv`, node `fs`)
  can repair a directory entry pointing at a deleted inode — that requires unmount + `e2fsck`.
- Tested and failed: `rm`, `rm -d`, `unlink`, `: > file` (truncate), `mv`, `cp --remove-destination`,
  node `fs.openSync` (errno -117 = EUCLEAN). All return the same kernel error.

## Containment & data-health verification (R2)

- `.qase/sessions.json.tmp-67` is **inert**: it is a leftover atomic-write temp file (write → rename
  pattern); the live target `sessions.json` is intact. It is the only stale tmp entry in `.qase/`.
- All 9 store JSON files parse OK: auth.json (4 users), sessions.json (318→319 sessions),
  bugs.json (32), environments.json (38,762), feedback.json (43), matrix-runs.json (143),
  test-cases.json (1,501), outbox.json (2), device-catalog.json (9).
- App server RUNNING; `http://localhost:5173/` → 200; preview `https://qase-2-1-cvtryq.drytis.dev/` → 200.
- **Live smoke test (ticket scenario S1):** registered probe account → created QA run via
  `POST /api/sessions` → **201**, appears in `GET /api/sessions` → session persistence unaffected
  by the corrupt dirent. Probe account + session cleaned up afterwards (sessions back to 319 total;
  probe artifacts removed).

## Resolution

- **In-container removal is impossible by design** — the fix requires detaching the volume and
  running `e2fsck -f` (plus `-D` for the directory checksum warnings) from the host/storage layer.
  This is outside what the container/pod can do; it needs a platform-side maintenance window
  (volume unmount → fsck → remount), ideally together with the next production restart.
- **Safe state reached:** all application data verified intact, app fully functional, corrupt entry
  inert. Escalated as an infrastructure action; no further in-container action is safe or useful.
- **Recommendation to platform ops:** run `e2fsck -fD` on the `/workspace` volume (`/dev/nvme0n1`)
  during the next maintenance/replacement cycle. The 220k error count and block-bitmap validation
  failures mean other latent damage may exist beyond this one dirent.
