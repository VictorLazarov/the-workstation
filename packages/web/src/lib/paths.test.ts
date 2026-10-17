import { describe, expect, it } from 'vitest';
import { absPath, insideProject, isPlanFile, relFromCwd } from '../panels/changes/derive';
import { basename, dirname, isRootPath, isWinPath, normPath, relPath } from './utils';

/** The server may run on Windows: paths arrive as `C:/x` (wire format) or `C:\x` (SDK / cwd values). */
describe('Windows and POSIX path helpers', () => {
  it('detects Windows paths only (a backslash is a legal POSIX name character)', () => {
    expect(isWinPath('C:\\Users\\x')).toBe(true);
    expect(isWinPath('c:/Users/x')).toBe(true);
    expect(isWinPath('\\\\srv\\share\\p')).toBe(true);
    expect(isWinPath('/home/x/a\\b')).toBe(false);
    expect(normPath('/home/x/a\\b')).toBe('/home/x/a\\b');
    expect(normPath('C:\\Users\\x\\a b')).toBe('C:/Users/x/a b');
  });
  it('basename / dirname', () => {
    expect(basename('C:\\Users\\x\\proj\\')).toBe('proj');
    expect(basename('C:/Users/x/proj/a.ts')).toBe('a.ts');
    expect(basename('/home/x/proj')).toBe('proj');
    expect(dirname('C:\\Users\\x\\proj')).toBe('C:/Users/x');
    expect(dirname('C:/Users')).toBe('C:/');
    expect(dirname('C:/')).toBe('C:/');
    expect(dirname('/home')).toBe('/');
    expect(dirname('/home/x/a.ts')).toBe('/home/x');
    expect(isRootPath('C:/')).toBe(true);
    expect(isRootPath('C:')).toBe(true);
    expect(isRootPath('/')).toBe(true);
    expect(isRootPath('C:/Users')).toBe(false);
  });
  it('relPath: relative inside the project (case-insensitive drive), ~ for the profile', () => {
    expect(relPath('C:\\Proj\\src\\a.ts', 'c:/proj')).toBe('src/a.ts');
    expect(relPath('C:/Users/Jane/notes.md', 'D:/other')).toBe('~/notes.md');
    expect(relPath('/Users/me/x', '/home/other')).toBe('~/x');
    expect(relPath('/p/src/a.ts', '/p/')).toBe('src/a.ts');
  });
  it('absPath keeps the drive; relFromCwd works across mixed separators', () => {
    expect(absPath('src/a.ts', 'C:\\proj')).toBe('C:/proj/src/a.ts');
    expect(absPath('../x.ts', 'C:/proj/web')).toBe('C:/proj/x.ts');
    expect(absPath('C:\\other\\y.ts', 'C:/proj')).toBe('C:/other/y.ts');
    expect(absPath('src/a.ts', '/p')).toBe('/p/src/a.ts');
    expect(relFromCwd('C:/proj/e2e/x.ts', 'C:\\proj\\web')).toBe('../e2e/x.ts');
    expect(relFromCwd('D:/x/y.ts', 'C:/proj')).toBe('D:/x/y.ts');
  });
  it('insideProject / plan files on Windows', () => {
    expect(insideProject('C:\\Proj\\src\\a.ts', ['c:/proj'])).toBe(true);
    expect(insideProject('C:/Proj2/a.ts', ['C:/Proj'])).toBe(false);
    expect(insideProject('/p/a.ts', ['/P'])).toBe(false); // POSIX stays case-sensitive
    expect(isPlanFile('C:\\Users\\x\\.claude\\plans\\idea.md')).toBe(true);
  });
});
