/**
 * 数据目录解析（REQUIREMENTS §5.1）。
 *
 * 默认 `~/.local/share/opencode/ocache`（遵循 XDG，与 OpenCode 同级）；
 * 可用环境变量 OCACHE_DATA_DIR 覆盖，便于测试与多实例隔离。
 */

import path from "node:path"
import os from "node:os"

export const DATA_ENV = "OCACHE_DATA_DIR"

/** 解析数据根目录。不创建目录（record=false 时不产生任何文件）。 */
export function resolveBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_ENV]
  if (typeof override === "string" && override.length > 0) return path.resolve(override)
  const xdg = env.XDG_DATA_HOME
  const root = typeof xdg === "string" && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(root, "opencode", "ocache")
}
