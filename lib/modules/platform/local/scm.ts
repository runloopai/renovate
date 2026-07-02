import { isNonEmptyObject } from '@sindresorhus/is';
import { glob } from 'glob';
import type { DateTime } from 'luxon';
import type { SimpleGit } from 'simple-git';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import { rawExec } from '../../../util/exec/common.ts';
import { writeLocalFile } from '../../../util/fs/index.ts';
import { createSimpleGit } from '../../../util/git/index.ts';
import type { CommitFilesConfig } from '../../../util/git/types.ts';
import type { LongCommitSha } from '../../../util/schema-utils/git.ts';
import { toLongCommitSha } from '../../../util/schema-utils/git.ts';
import type { PlatformScm } from '../types.ts';

let fileList: string[] | undefined;

/**
 * Paths that were already modified (uncommitted) before Renovate touched the
 * working tree, captured once per run before any Renovate writes happen.
 * Used by the branch commit step to detect commits that would silently
 * absorb the user's own uncommitted work.
 */
let baselineDirtyFiles: Set<string> | undefined;

function getLocalGit(): SimpleGit {
  return createSimpleGit({ config: { baseDir: GlobalConfig.get('localDir') } });
}

/**
 * Snapshots the set of paths with uncommitted changes in the working tree.
 * Must be called before Renovate writes any files (i.e. from `initRepo()`).
 */
export async function captureLocalBaselineDirtyFiles(): Promise<void> {
  const dirty = new Set<string>();
  try {
    const status = await getLocalGit().status();
    for (const file of status.files) {
      dirty.add(file.path);
      /* v8 ignore next 3 -- renames are rare in tests, hard to construct */
      if (file.from) {
        dirty.add(file.from);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'local: could not determine baseline git status');
  }
  baselineDirtyFiles = dirty;
}

/**
 * Returns the baseline dirty file set captured by
 * `captureLocalBaselineDirtyFiles()`. Empty if it was never called or the
 * working tree isn't a git repo.
 */
export function getLocalBaselineDirtyFiles(): Set<string> {
  return baselineDirtyFiles ?? new Set();
}

export class LocalFs implements PlatformScm {
  isBranchBehindBase(
    _branchName: string,
    _baseBranch: string,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
  isBranchModified(_branchName: string, _baseBranch: string): Promise<boolean> {
    return Promise.resolve(false);
  }
  isBranchConflicted(_baseBranch: string, _branch: string): Promise<boolean> {
    return Promise.resolve(false);
  }
  branchExists(_branchName: string): Promise<boolean> {
    // Local platform runs are stateless - there is no persisted branch from
    // a prior invocation to reuse, so every run must treat every branch as
    // new. Reporting true here caused `reuseExistingBranch` to be set for
    // branches that don't actually exist, triggering a discard-and-retry in
    // getUpdatedPackageFiles() whose first-pass writes could reach the real
    // working tree without ever being committed.
    return Promise.resolve(false);
  }
  getBranchCommit(_branchName: string): Promise<LongCommitSha | null> {
    return Promise.resolve(null);
  }
  getBranchUpdateDate(_branchName: string): Promise<DateTime | null> {
    return Promise.resolve(null);
  }
  deleteBranch(_branchName: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Applies the given file changes to the working tree and, if anything was
   * staged, creates a local commit on the currently checked-out branch.
   * Never pushes - there is no remote for the local platform.
   */
  async commitAndPush(
    commitConfig: CommitFilesConfig,
  ): Promise<LongCommitSha | null> {
    const { files, message } = commitConfig;
    const git = getLocalGit();
    const stagedPaths: string[] = [];
    try {
      for (const file of files) {
        if (file.type === 'deletion') {
          await git.rm([file.path]);
          stagedPaths.push(file.path);
          continue;
        }
        if (file.isSymlink) {
          logger.debug(
            { path: file.path },
            'local: skipping symlink, not supported for local commits',
          );
          continue;
        }
        await writeLocalFile(file.path, file.contents ?? '');
        await git.add(file.path);
        if (file.isExecutable) {
          await git.raw(['update-index', '--chmod=+x', file.path]);
        }
        stagedPaths.push(file.path);
      }

      if (!stagedPaths.length) {
        logger.debug('local: no files to commit');
        return null;
      }

      const commitRes = await git.commit(message);
      if (
        isNonEmptyObject(commitRes.summary) &&
        commitRes.summary.changes === 0 &&
        commitRes.summary.insertions === 0 &&
        commitRes.summary.deletions === 0
      ) {
        logger.debug(
          { commitRes },
          'local: no effective changes, skipping commit',
        );
        return null;
      }
      const commitSha = toLongCommitSha((await git.revparse(['HEAD'])).trim());
      logger.info(
        { files: stagedPaths },
        'local: committed files to current branch',
      );
      return commitSha;
    } catch (err) {
      logger.warn(
        { err },
        'local: failed to create local commit, leaving working tree changes uncommitted',
      );
      return null;
    }
  }

  async getFileList(): Promise<string[]> {
    try {
      // fetch file list using git
      const maxBuffer = 10 * 1024 * 1024; // 10 MiB in bytes
      const stdout = (await rawExec('git ls-files', { maxBuffer })).stdout;
      logger.debug('Got file list using git');
      fileList = stdout.split('\n');
    } catch {
      logger.debug('Could not get file list using git, using glob instead');
      fileList ??= await glob('**', {
        dot: true,
        nodir: true,
      });
    }

    return fileList;
  }

  checkoutBranch(_branchName: string): Promise<LongCommitSha | null> {
    return Promise.resolve(null);
  }

  mergeAndPush(_branchName: string): Promise<void> {
    return Promise.resolve();
  }

  mergeToLocal(_branchName: string): Promise<void> {
    return Promise.resolve();
  }
}
