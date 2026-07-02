// TODO #22198
import { isNonEmptyArray } from '@sindresorhus/is';
import { GlobalConfig } from '../../../../config/global.ts';
import { CONFIG_SECRETS_EXPOSED } from '../../../../constants/error-messages.ts';
import { logger } from '../../../../logger/index.ts';
import { getLocalBaselineDirtyFiles } from '../../../../modules/platform/local/scm.ts';
import { scm } from '../../../../modules/platform/scm.ts';
import type { CommitFilesConfig } from '../../../../util/git/types.ts';
import { minimatch } from '../../../../util/minimatch.ts';
import { sanitize } from '../../../../util/sanitize.ts';
import type { LongCommitSha } from '../../../../util/schema-utils/git.ts';
import type { BranchConfig } from '../../../types.ts';

function isExcludedPath(
  filePath: string,
  excludeCommitPaths: string[] | undefined,
): boolean {
  return !!excludeCommitPaths?.some((excludedPath) =>
    minimatch(excludedPath, { dot: true }).match(filePath),
  );
}

function overlapWithBaseline(
  paths: Iterable<string>,
  baseline: Set<string>,
  excludeCommitPaths: string[] | undefined,
): string[] {
  return [...new Set(paths)].filter(
    (path) => !isExcludedPath(path, excludeCommitPaths) && baseline.has(path),
  );
}

/**
 * Guards against a local commit silently absorbing pre-existing uncommitted
 * user changes to a source/manifest file.
 *
 * Must run before any manager touches disk (i.e. before
 * `getUpdatedPackageFiles()`): several managers, e.g. `auto-replace.ts` and
 * the bazel-module manager, write the updated manifest to disk as a side
 * effect of computing the update, well before the branch is committed. On
 * the local platform that write lands directly in the user's real working
 * tree, so checking for dirty overlap only at commit time (as
 * `checkLocalDirtyOverlap` below does for artifacts) would be too late to
 * prevent the user's edits from already being overwritten.
 *
 * Only source/manifest files are checked here - see `checkLocalDirtyOverlap`
 * for why lock files/artifacts are intentionally excluded from this hard
 * block.
 *
 * `config.upgrades[].packageFile` is a superset of every path a manager's
 * `updateArtifacts` can be asked to write in `getUpdatedPackageFiles()`:
 * that function's three `managerUpdateArtifacts()` call sites - for
 * `updatedPackageFiles`, `nonUpdatedPackageFiles`, and
 * `lockFileMaintenanceFiles` - all derive their `packageFileName` from a
 * `packageFile` value that was itself populated from `upgrade.packageFile`
 * earlier in that function. So a manager that writes its own
 * `packageFileName` as a side effect (e.g. bazel-module, cargo, gomod) is
 * already covered by `sourcePaths` below.
 */
export function checkLocalDirtyOverlapBeforeWrite(config: BranchConfig): void {
  const baseline = getLocalBaselineDirtyFiles();
  if (!baseline.size) {
    return;
  }
  const sourcePaths = (config.upgrades ?? [])
    .map((upgrade) => upgrade.packageFile)
    .filter((packageFile): packageFile is string => !!packageFile);
  const sourceOverlap = overlapWithBaseline(
    sourcePaths,
    baseline,
    config.excludeCommitPaths,
  );
  if (sourceOverlap.length) {
    const message = `Cannot create local commit: source file(s) ${sourceOverlap.join(', ')} have uncommitted changes; commit or stash them first`;
    // Logged directly (not just via the generic `{ err }` catch-all in
    // branch/index.ts) so the actionable message reaches the console even
    // when only warn-level logging is enabled.
    logger.warn(message);
    throw new Error(message);
  }
}

/**
 * Warns when committing this branch's changes on the local platform would
 * overwrite pre-existing uncommitted changes to a lock file/artifact.
 *
 * Lock files/artifacts are regenerated wholesale from the (now-updated)
 * manifest, so a dirty lock file is intentionally overwritten here - this is
 * informational only. The corresponding hard block for source/manifest
 * files happens earlier, in `checkLocalDirtyOverlapBeforeWrite()`.
 *
 * Deletions and paths excluded via `excludeCommitPaths` are skipped here:
 * they can't absorb overwritten content the way an addition can, and
 * `LocalFs.commitAndPush` runs `git rm` (without `-f`) for deletions, which
 * git itself refuses when the target has uncommitted local modifications -
 * so a dirty deletion target fails the commit rather than silently
 * discarding the user's edit.
 */
function checkLocalDirtyOverlap(config: BranchConfig): void {
  const baseline = getLocalBaselineDirtyFiles();
  if (!baseline.size) {
    return;
  }
  const artifactOverlap = overlapWithBaseline(
    config
      .updatedArtifacts!.filter((file) => file.type === 'addition')
      .map(({ path }) => path),
    baseline,
    config.excludeCommitPaths,
  );
  if (artifactOverlap.length) {
    logger.warn(
      { files: artifactOverlap },
      'local: overwriting uncommitted lock file/artifact changes with regenerated content',
    );
  }
}

export function commitFilesToBranch(
  config: BranchConfig,
): Promise<LongCommitSha | null> {
  let updatedFiles = config.updatedPackageFiles!.concat(
    config.updatedArtifacts!,
  );
  // istanbul ignore if
  if (isNonEmptyArray(config.excludeCommitPaths)) {
    updatedFiles = updatedFiles.filter(({ path: filePath }) => {
      const matchesExcludePaths = config.excludeCommitPaths!.some(
        (excludedPath) =>
          minimatch(excludedPath, { dot: true }).match(filePath),
      );
      if (matchesExcludePaths) {
        logger.debug(`Excluding ${filePath} from commit`);
        return false;
      }
      return true;
    });
  }
  if (!isNonEmptyArray(updatedFiles)) {
    logger.debug(`No files to commit`);
    return Promise.resolve(null);
  }
  const fileLength = new Set(updatedFiles.map((file) => file.path)).size;
  logger.debug(`${fileLength} file(s) to commit`);
  // istanbul ignore if
  if (
    config.branchName !== sanitize(config.branchName) ||
    config.commitMessage !== sanitize(config.commitMessage)
  ) {
    logger.debug(
      { branchName: config.branchName },
      'Secrets exposed in branchName or commitMessage',
    );
    throw new Error(CONFIG_SECRETS_EXPOSED);
  }

  const commitFilesConfig: CommitFilesConfig = {
    baseBranch: config.baseBranch,
    branchName: config.branchName,
    files: updatedFiles,
    message: config.commitMessage!,
    force: !!config.forceCommit,
    platformCommit: config.platformCommit,
    // Only needed by Gerrit platform
    prTitle: config.prTitle,
    // Only needed by Gerrit platform
    autoApprove: config.autoApprove,
  };

  if (GlobalConfig.get('dryRun')) {
    // The local platform's dryRun=full is an explicit "apply locally" mode:
    // it writes the files and creates a real local commit (no push, since
    // there is no remote). Every other dryRun case only logs - including
    // platform=local with dryRun=lookup/extract, which never reach this far
    // (branch processing is skipped upstream), but this checks the exact
    // value rather than relying on that.
    if (
      GlobalConfig.get('platform') === 'local' &&
      GlobalConfig.get('dryRun') === 'full'
    ) {
      checkLocalDirtyOverlap(config);
      logger.info(
        `Committing ${fileLength} file(s) to local branch ${config.branchName}`,
      );
      return scm.commitAndPush(commitFilesConfig);
    }

    const logExtra = {
      ...commitFilesConfig,
    };

    for (const file of logExtra.files) {
      if (file.type === 'addition') {
        // NOTE that we're copying this field with a different name so we get the raw contents logged, otherwise it'll be logged as `[content]`
        (file as any).rawContents = file.contents;
      }
    }

    logger.info(
      `DRY-RUN: Would commit files to branch ${config.branchName}. See debug logs for raw commit information`,
    );
    logger.debug(
      { ...logExtra },
      `DRY-RUN: Would commit files to branch ${config.branchName}`,
    );
    return Promise.resolve(null);
  }

  // API will know whether to create new branch or not
  return scm.commitAndPush(commitFilesConfig);
}
