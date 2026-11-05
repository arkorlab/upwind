/** The selected file's unvalidated value, for tools that read additional project settings. */
export interface ProjectConfigFile {
  readonly file: string | undefined;
  readonly value: unknown;
}

/** Find the first configuration file without evaluating it; additional host names follow upwind's. */
export declare function findProjectConfigFile(
  projectDir: string,
  hostConfigFiles?: readonly string[],
): Promise<string | undefined>;

/** Read the selected JSON, JSONC or TypeScript file without adapter-specific validation. */
export declare function readProjectConfigFile(
  projectDir: string,
  hostConfigFiles?: readonly string[],
): Promise<ProjectConfigFile>;
