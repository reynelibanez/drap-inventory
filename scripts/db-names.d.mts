export const DEFAULT_DB_NAME: string;
export const DB_NAME_HELP: string;
export function cleanDbName(raw: unknown): string | null;
export function appUserFor(dbName: string): string;
export function dbNameFromArgs(argv?: string[], env?: Record<string, string | undefined>): string | undefined;
