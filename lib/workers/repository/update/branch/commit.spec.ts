import { logger, scm } from '~test/util.ts';
import { GlobalConfig } from '../../../../config/global.ts';
import { getLocalBaselineDirtyFiles as _getLocalBaselineDirtyFiles } from '../../../../modules/platform/local/scm.ts';
import type { LongCommitSha } from '../../../../util/schema-utils/git.ts';
import type { BranchConfig } from '../../../types.ts';
import {
  checkLocalDirtyOverlapBeforeWrite,
  commitFilesToBranch,
} from './commit.ts';

vi.mock('../../../../modules/platform/local/scm.ts', () => ({
  getLocalBaselineDirtyFiles: vi.fn().mockReturnValue(new Set()),
}));
const getLocalBaselineDirtyFiles = vi.mocked(_getLocalBaselineDirtyFiles);

describe('workers/repository/update/branch/commit', () => {
  describe('commitFilesToBranch', () => {
    let config: BranchConfig;

    beforeEach(() => {
      config = {
        baseBranch: 'base-branch',
        manager: 'some-manager',
        branchName: 'renovate/some-branch',
        commitMessage: 'some commit message',
        semanticCommits: 'disabled',
        semanticCommitType: 'a',
        semanticCommitScope: 'b',
        updatedPackageFiles: [],
        updatedArtifacts: [],
        upgrades: [],
        platformCommit: 'auto',
      } satisfies BranchConfig;
      scm.commitAndPush.mockResolvedValueOnce('123test' as LongCommitSha);
      getLocalBaselineDirtyFiles.mockReturnValue(new Set());
      GlobalConfig.reset();
    });

    it('handles empty files', async () => {
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(0);
    });

    it('commits files', async () => {
      config.updatedPackageFiles?.push({
        type: 'addition',
        path: 'package.json',
        contents: 'some contents',
      });
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
      expect(scm.commitAndPush.mock.calls).toEqual([
        [
          {
            baseBranch: 'base-branch',
            branchName: 'renovate/some-branch',
            files: [
              {
                contents: 'some contents',
                path: 'package.json',
                type: 'addition',
              },
            ],
            force: false,
            message: 'some commit message',
            platformCommit: 'auto',
          },
        ],
      ]);
    });

    it('dry runs', async () => {
      GlobalConfig.set({ dryRun: 'full' });
      config.updatedPackageFiles?.push({
        type: 'addition',
        path: 'package.json',
        contents: 'some contents',
      });
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(0);
      expect(logger.logger.info).toHaveBeenCalledWith(
        'DRY-RUN: Would commit files to branch renovate/some-branch. See debug logs for raw commit information',
      );
    });

    it('dry runs with a deletion', async () => {
      GlobalConfig.set({ dryRun: 'full' });
      config.updatedPackageFiles?.push({
        type: 'deletion',
        path: 'package.json',
      });
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(0);
      expect(logger.logger.info).toHaveBeenCalledWith(
        'DRY-RUN: Would commit files to branch renovate/some-branch. See debug logs for raw commit information',
      );
    });

    describe('local platform apply mode', () => {
      beforeEach(() => {
        GlobalConfig.set({ dryRun: 'full', platform: 'local' });
        config.updatedPackageFiles?.push({
          type: 'addition',
          path: 'package.json',
          contents: 'some contents',
        });
      });

      it('commits via scm.commitAndPush instead of dry-run logging', async () => {
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.info).toHaveBeenCalledWith(
          'Committing 1 file(s) to local branch renovate/some-branch',
        );
        expect(logger.logger.info).not.toHaveBeenCalledWith(
          expect.stringContaining('DRY-RUN'),
        );
      });

      it('commits and warns when only an artifact has pre-existing uncommitted changes', async () => {
        config.updatedArtifacts?.push({
          type: 'addition',
          path: 'package-lock.json',
          contents: 'some lockfile contents',
        });
        getLocalBaselineDirtyFiles.mockReturnValue(
          new Set(['package-lock.json']),
        );

        await commitFilesToBranch(config);

        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).toHaveBeenCalledWith(
          { files: ['package-lock.json'] },
          'local: overwriting uncommitted lock file/artifact changes with regenerated content',
        );
      });

      it('commits cleanly when there is no dirty-file overlap', async () => {
        getLocalBaselineDirtyFiles.mockReturnValue(
          new Set(['unrelated-file.txt']),
        );
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).not.toHaveBeenCalled();
      });

      it('does not flag a dirty artifact deletion as an overlap', async () => {
        config.updatedArtifacts?.push({
          type: 'deletion',
          path: 'old-lock.json',
        });
        getLocalBaselineDirtyFiles.mockReturnValue(new Set(['old-lock.json']));
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).not.toHaveBeenCalled();
      });

      it('does not flag a dirty artifact excluded via excludeCommitPaths', async () => {
        config.updatedArtifacts?.push({
          type: 'addition',
          path: 'package-lock.json',
          contents: 'some lockfile contents',
        });
        config.excludeCommitPaths = ['package-lock.json'];
        getLocalBaselineDirtyFiles.mockReturnValue(
          new Set(['package-lock.json']),
        );
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('checkLocalDirtyOverlapBeforeWrite', () => {
    let config: BranchConfig;

    beforeEach(() => {
      config = {
        baseBranch: 'base-branch',
        manager: 'some-manager',
        branchName: 'renovate/some-branch',
        commitMessage: 'some commit message',
        upgrades: [
          { manager: 'some-manager', branchName: 'main', depName: 'some-dep' },
        ],
      } satisfies BranchConfig;
      getLocalBaselineDirtyFiles.mockReturnValue(new Set());
    });

    it('does nothing when the baseline is clean', () => {
      config.upgrades[0].packageFile = 'package.json';
      getLocalBaselineDirtyFiles.mockReturnValue(new Set());
      expect(() => checkLocalDirtyOverlapBeforeWrite(config)).not.toThrow();
    });

    it('throws before any manager writes when a source file is already dirty', () => {
      config.upgrades[0].packageFile = 'package.json';
      getLocalBaselineDirtyFiles.mockReturnValue(new Set(['package.json']));
      expect(() => checkLocalDirtyOverlapBeforeWrite(config)).toThrow(
        'Cannot create local commit: source file(s) package.json have uncommitted changes; commit or stash them first',
      );
    });

    it('does not flag a dirty file excluded via excludeCommitPaths', () => {
      config.upgrades[0].packageFile = 'package.json';
      config.excludeCommitPaths = ['package.json'];
      getLocalBaselineDirtyFiles.mockReturnValue(new Set(['package.json']));
      expect(() => checkLocalDirtyOverlapBeforeWrite(config)).not.toThrow();
    });

    it('does not flag an unrelated dirty file', () => {
      config.upgrades[0].packageFile = 'package.json';
      getLocalBaselineDirtyFiles.mockReturnValue(
        new Set(['unrelated-file.txt']),
      );
      expect(() => checkLocalDirtyOverlapBeforeWrite(config)).not.toThrow();
    });

    it('dedupes overlapping paths across multiple upgrades touching the same file', () => {
      config.upgrades.push({
        manager: 'some-manager',
        branchName: 'main',
        depName: 'some-other-dep',
        packageFile: 'package.json',
      });
      config.upgrades[0].packageFile = 'package.json';
      getLocalBaselineDirtyFiles.mockReturnValue(new Set(['package.json']));
      expect(() => checkLocalDirtyOverlapBeforeWrite(config)).toThrow(
        'Cannot create local commit: source file(s) package.json have uncommitted changes; commit or stash them first',
      );
    });
  });
});
