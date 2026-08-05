# Phase 0: protected pre-migration baseline

Date: 2026-08-05

Scope: safety and change control only; no application behavior changes.

## Baseline

- Project: Qase 0.1.0
- Runtime observed during capture: Node.js 21.7.3, npm 10.5.0
- Existing automated tests before changes: 10 passed, 0 failed
- Application storage at capture time: local `.qase` state plus private OS authentication state
- Source-control state at capture time: no Git repository

The host runtime is recorded for reproducibility only. A supported production
LTS runtime will be selected and pinned in a later, separately approved phase.

## Protected material

The following paths are deliberately excluded from Git and source archives:

- `.env` and other local environment files
- `.qase/`, including model configuration, run history and workspaces
- `node_modules/`
- logs, test output and generated ZIP archives
- common private-key and certificate formats

The `.qase` contents and private authentication state are not part of the source
rollback package. They must be backed up through a separately approved data
backup process if preservation of local run history is required.

## Preserved artifacts

Stored outside the repository at:

`C:\QASE LATEST FILE\qase-baselines\2026-08-05-phase-0`

| Artifact | SHA-256 |
| --- | --- |
| `qase-pre-enterprise-source.zip` | `60F9051821B451058DDD5E0085A9A159FAF2FF1DCF42D5C0733C7AB0F40AA54C` |
| `original-qase-share.zip` | `58321E957FD8ABA1C3A29477D76D91E8ADF825A732819ECD5CE2C225CECF002D` |
| `original-qase-complete-source-2026-07-29.zip` | `03C9BCB65DD862B9C08B952B8705EE0323A2670ABAE503A058133A5FACD57EA2` |

The pre-enterprise archive was inspected after creation. It contained 22 source
entries and no `.env`, `.qase`, `node_modules` or nested ZIP entries.
The final Phase 0 share archive and its checksum are recorded in the external
`SHA256SUMS.txt` manifest beside the protected artifacts. Keeping that checksum
outside the archive avoids a self-referential hash.

## Verification

Run the protected baseline checks from the project root:

```text
npm run verify
```

The command checks JavaScript syntax, Git exclusions and high-confidence secret
signatures before running the automated tests.

Build a shareable source archive with:

```text
npm run package
```

The packaging script reads the archive back and refuses to keep it if private
runtime paths or nested ZIP files are present.

## Rollback procedure

1. Stop the Qase process so files are not changing during restoration.
2. Preserve the current working directory and private `.qase` state separately;
   do not overwrite either in place.
3. Create a new sibling directory under `C:\QASE LATEST FILE`.
4. Extract `qase-pre-enterprise-source.zip` into that new directory.
5. Run `npm install`, `npm run install-browser`, and `npm run verify` there.
6. Add model configuration through the normal Qase setup flow. Do not copy a
   production credential into source control.
7. Point traffic to the restored instance only after verification succeeds.

This side-by-side procedure keeps both the migration workspace and the original
baseline recoverable.
