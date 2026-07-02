# Local

With the "local" platform you can perform dry runs of Renovate against the local file system.
This can be handy when testing a new Renovate configuration for example.

## Usage

Run the `renovate --platform=local` command in the directory you want Renovate to run in.
In this mode, Renovate defaults to `dryRun=lookup`.
You can override this by passing `--dry-run=extract` to stop after the extract phase.

Avoid giving "repositories" arguments, as this command can only run in a _single_ directory, and it can only run in the _current working_ directory.

You may run the command above on "plain" directories, or "Git directories".
You don't need to provide any config, as the command will run with or without "repo config".

The command doesn't do any "compare" - or before and after analysis - if you want to test a new config then you must manually compare.

### Applying updates locally: `--dry-run=full`

Passing `--dry-run=full` switches the local platform out of its default read-only sandbox and into an "apply locally" mode:

- Updated package files and lock files/artifacts are written to your working tree.
- `postUpgradeTasks` and `allowedUnsafeExecutions` run, so you must configure `allowedCommands` / `allowedUnsafeExecutions` for anything you want executed.
- A local git commit is created per Renovate update group, on whatever branch you currently have checked out. Renovate never creates or switches branches, and **never pushes** - there is no remote to push to.
- Use `commitBody` and/or `commitBodyTable` to get a richer, PR-description-style commit message (package table, changelogs, etc).

Pre-existing uncommitted changes in your working tree are protected as follows:

- Files Renovate doesn't touch are left alone.
- If a source/manifest file Renovate needs to edit already has uncommitted changes, that update is refused with an error (commit or stash the file first) rather than risk folding your edits into Renovate's commit.
- If only a lock file/artifact that Renovate regenerates (e.g. via `allowedUnsafeExecutions`) has uncommitted changes, it's overwritten with the regenerated content and committed - a warning is logged, but the update is not blocked.

This is an escape hatch for local testing and is not intended to replace the platform-based dry run workflow. All other `dryRun` values (or omitting `--dry-run`) keep the platform read-only.

## Limitations

- `local>` presets can't be resolved. Normally these would point to the local platform such as GitHub, but in the case of running locally, it does not exist
- `baseBranchPatterns` are ignored
- Branch creation is not supported (even with `--dry-run=full`, commits land on the current branch)
