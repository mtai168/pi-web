# Sanitized SST Review Snapshot

This orphan review snapshot was exported from source commit
`01f28079646952bcedbe88bd5b16913854c18382` for read-only review of the
Normal/Session Wall session-read lifecycle.

It intentionally carries no parent commit and no original Git history. It is
not a development, merge, release, or deployment branch.

## Scope

The snapshot retains the source tree needed to inspect session reads, cache
boundaries, catalog scanning, SSE observation, commands, authority, runtime
state, Normal/Wall lifecycle, package versions, and their tests.

The following material is excluded:

- GitHub workflow files, so this review ref is inert by itself.
- Real UI/session screenshots under `docs/screenshots/` and
  `docs/screenshot2.png`.
- Any private runtime output or deleted scratch/debug history. Those are not
  part of this parentless snapshot.

`next.config.ts` retains the exact-host `allowedDevOrigins` behavior but uses a
non-resolving review placeholder instead of the deployment's private-overlay
host.

See `REVIEW_SNAPSHOT_MANIFEST.tsv` for the classification of every source-tree
path as `UNCHANGED`, `SANITIZED`, or `EXCLUDED`.

## Limits

This snapshot is evidence for documentation review only. Its commit ID is not
the deployment commit ID, and it must not be merged or used as an
implementation base. The authoritative source identity remains the source SHA
above; the snapshot records only a sanitized tree derived from it.

## Attribution

The project license is retained in `LICENSE`. Original project and dependency
attribution remains in the unchanged source and package manifests.
