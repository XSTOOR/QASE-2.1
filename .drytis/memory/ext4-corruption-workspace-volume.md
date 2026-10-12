# ext4 volume corruption on /workspace (found 2026-10-09, ticket #15694)

## Symptom
`.qase/sessions.json.tmp-67` undeletable — every access returns `EUCLEAN "Structure needs cleaning"`
(rm/unlink/truncate/mv/stat all fail; `ls -la` shows `-?????????`). Survived container replacement.

## Root cause (kernel-confirmed)
- dmesg: `ext4_lookup:1789: inode #491716 (.qase dir): deleted inode referenced: 491738` — stale
  dirent pointing at an already-deleted inode.
- `/sys/fs/ext4/nvme0n1/errors_count` = **220,416** errors since last fsck; first error
  2026-08-31 in `ext4_validate_block_bitmap` (block-bitmap checksum failures from the ENOSPC
  disk-full era). Also `ext4_dirblock_csum_verify` "Please run e2fsck -D" warnings on other inodes.

## What does NOT work (don't retry)
`rm`, `rm -d`, `unlink`, `: > file`, `mv`, `cp --remove-destination`, node `fs.*` — all hit the
same kernel error. The volume is live-mounted ext4; no container-level tool can fix a dirent →
deleted inode.

## Only real fix
Host/storage-layer maintenance window: unmount the volume and run **`e2fsck -fD` on /dev/nvme0n1**
(ideally at the next production restart / volume detach). Escalated to platform ops. The corrupt
entry is inert and harmless day-to-day.

## Verified safe meanwhile
All 9 `.qase` store JSON files parse OK; sessions.json intact; app RUNNING; QA run creation +
listing verified live (201 + appears in GET /api/sessions). Report:
`.drytis/reviews/ticket-15694-cleanup-report.md`.

## Takeaway
If any file ever returns "Structure needs cleaning", check `dmesg | tail` for ext4 errors before
burning cycles on user-space removal tricks — with 220k+ fs errors logged, more latent damage may
surface elsewhere on the volume.
