import path from 'node:path';

const MAX_DIAGNOSTIC_FILE_CHARACTERS = 240;

export function retainedFileIdentity(projectDir: string, file: string): string {
  if (!path.isAbsolute(file)) return JSON.stringify('[non-physical module]');
  const relative = path.relative(projectDir, file).split(path.sep).join('/');
  const bounded =
    relative.length > MAX_DIAGNOSTIC_FILE_CHARACTERS
      ? `${relative.slice(0, MAX_DIAGNOSTIC_FILE_CHARACTERS)}…`
      : relative;
  return JSON.stringify(bounded);
}
