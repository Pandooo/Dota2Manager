// Node 端 roster 加载器（无头模拟/测试/数据脚本使用）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RosterFile } from '../src/engine/types';
import { registerRosterLoader } from '../src/data/index';

const here = dirname(fileURLToPath(import.meta.url));
export const ROSTER_DIR = join(here, '..', 'src', 'data', 'rosters');

export function readRosterSync(ti: number): RosterFile {
  return JSON.parse(readFileSync(join(ROSTER_DIR, `ti${ti}.json`), 'utf8')) as RosterFile;
}

export function registerNodeRosterLoader(): number[] {
  const tis = existsSync(ROSTER_DIR)
    ? readdirSync(ROSTER_DIR)
        .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
        .filter((n) => Number.isFinite(n))
    : [];
  registerRosterLoader(async (ti) => readRosterSync(ti), tis);
  return tis;
}
