// TODO #22198
import { isNonEmptyArray } from '@sindresorhus/is';
import { GlobalConfig } from '../../../../config/global.ts';
import { CONFIG_SECRETS_EXPOSED } from '../../../../constants/error-messages.ts';
import { logger } from '../../../../logger/index.ts';
import { getLocalBaselineDirtyFiles } from '../../../../modules/platform/local/scm.ts';
import { scm } from '../../../../modules/platform/scm.ts';
import type {
  CommitFilesConfig,
  FileChange,
} from '../../../../util/git/types.ts';
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

/**
 * Checks whether committing this branch's changes on the local platform
 * would silently absorb pre-existing uncommitted user changes.
 *
 * Source/manifest files are edited in place, so if one was already dirty the
 * commit would include the user's own edits - that's refused outright.
 * Lock files/artifacts are regenerated wholesale from the (now-updated)
 * manifest, so a dirty lock file is intentionally overwritten - just logged.
 *
 * Deletions and paths excluded via `excludeCommitPaths` are never actually
 * written by Renovate's commit, so they can't absorb anything and are
 * skipped here.
 */
function checkLocalDirtyOverlap(config: BranchConfig): void {
  const baseline = getLocalBaselineDirtyFiles();
  if (!baseline.size) {
    return;
  }
  const overlapPaths = (files: FileChange[]): string[] =>
    files
      .filter(
        (file) =>
          file.type === 'addition' &&
          !isExcludedPath(file.path, config.excludeCommitPaths),
      )
      .map(({ path }) => path)
      .filter((path) => baseline.has(path));

  const sourceOverlap = overlapPaths(config.updatedPackageFiles!);
  if (sourceOverlap.length) {
    throw new Error(
      `Cannot create local commit: source file(s) ${sourceOverlap.join(', ')} have uncommitted changes; commit or stash them first`,
    );
  }
  const artifactOverlap = overlapPaths(config.updatedArtifacts!);
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
    // there is no remote). Every other dryRun case only logs.
    if (GlobalConfig.get('platform') === 'local') {
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
