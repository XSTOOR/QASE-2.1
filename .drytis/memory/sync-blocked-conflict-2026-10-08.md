2026-10-08: Sync of DEV blocked by rebase conflict; workspace intact.

- Plain `git fetch` / `git pull` on this repo fails with "the remote end hung up unexpectedly" (server returns HTTP 200 with empty pack during negotiation). WORKAROUND: `git fetch --refetch --depth=200 origin DEV` (incremental deepen also fails; must refetch). `git ls-remote` works fine.
- Remote DEV tip: 2bc8f69 ("Merge MANOJ: remove Stateful Switch theme toggle"). Local DEV was b382093 — pure fast-forward candidate, 102 incoming commits (Telegram notifier replacing WhatsApp, theme toggle then its revert, Studio UX from PUSHKAR/pprj04, #15323 cap fix from NIHARIKA, migration renumbering 021/022→037/038).
- Local dirty work (founder-mode phases 2-5) was checkpoint-committed as f0372a9 (NOT pushed). Rebase of f0372a9 onto origin/DEV conflicted in server/store.js only (auto-merged postgresServices.js); rebase aborted, tree clean.
- State after abort: DEV ahead 1 / behind 102 vs origin/DEV, working tree clean.
- Next step for leader: re-attempt rebase and hand-resolve server/store.js conflict (local founder store changes vs incoming notifier/migration changes), or cherry-pick founder files selectively. Note incoming commits renumber migrations (021/022 → 037/038) and local adds 024_founder_project_state.sql — migration numbering likely needs renumbering too.
