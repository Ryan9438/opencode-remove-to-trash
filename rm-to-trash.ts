import type { Plugin } from "@opencode-ai/plugin"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { execFile, spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const SHELL_TOOLS = new Set(["bash", "shell"])
const PATCH_TOOLS = new Set(["apply_patch", "patch"])

const BOUNDARY = new Set(["\n", ";", "|", "&", "(", "`"])
const SEGMENT_END = new Set(["\n", ";", "|", "&", ")", "`"])
const PREFIX_WORDS = new Set([
  "xargs",
  "command",
  "exec",
  "time",
  "nohup",
  "nice",
  "env",
  "do",
  "then",
  "else",
  "elif",
])

interface Backend {
  argv: string[]
  builtin: boolean
}

export const FALLBACK_TRASH = `#!/bin/sh
set -eu

move_one() {
  src=$1
  dir=$2
  base=$(basename -- "$src")
  dest="$dir/$base"
  i=1
  while [ -e "$dest" ] || [ -L "$dest" ]; do
    dest="$dir/$base $i"
    i=$((i + 1))
  done
  mv -- "$src" "$dest"
  printf '%s\\n' "$dest"
}

os=$(uname -s)
if [ "$os" = "Darwin" ]; then
  root="$HOME/.Trash"
  mkdir -p "$root"
  for p in "$@"; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    move_one "$p" "$root" >/dev/null
  done
  exit 0
fi

data=$XDG_DATA_HOME
[ -n "$data" ] || data="$HOME/.local/share"
root="$data/Trash"
files="$root/files"
info="$root/info"
mkdir -p "$files" "$info"
now=$(date +%Y-%m-%dT%H:%M:%S)
for p in "$@"; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  parent=$(dirname -- "$p")
  abs=$(cd -- "$parent" && pwd)/$(basename -- "$p")
  dest=$(move_one "$p" "$files")
  name=$(basename -- "$dest")
  enc=$(printf '%s' "$abs" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/#/%23/g')
  printf '[Trash Info]\\n' > "$info/$name.trashinfo"
  printf 'Path=%s\\n' "$enc" >> "$info/$name.trashinfo"
  printf 'DeletionDate=%s\\n' "$now" >> "$info/$name.trashinfo"
done
`

function fallbackTrashPath(): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  const dir = join(cache, "opencode", "rm-to-trash")
  const file = join(dir, "trash")
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, FALLBACK_TRASH)
  chmodSync(file, 0o755)
  return file
}

function resolveTrash(): Backend | undefined {
  for (const bin of ["/usr/bin/trash", "/opt/homebrew/bin/trash", "/usr/local/bin/trash"]) {
    if (existsSync(bin)) return { argv: [bin], builtin: false }
  }
  if (!spawnSync("trash", ["--help"], { stdio: "ignore" }).error) {
    return { argv: ["trash"], builtin: false }
  }
  if (!spawnSync("trash-put", ["--version"], { stdio: "ignore" }).error) {
    return { argv: ["trash-put"], builtin: false }
  }
  if (!spawnSync("gio", ["help", "trash"], { stdio: "ignore" }).error) {
    return { argv: ["gio", "trash"], builtin: false }
  }
  try {
    return { argv: [fallbackTrashPath()], builtin: true }
  } catch {
    return undefined
  }
}

function isCommandPosition(cmd: string, i: number): boolean {
  let k = i
  while (k > 0 && (cmd[k - 1] === " " || cmd[k - 1] === "\t")) k--
  if (k === 0) return true
  if (BOUNDARY.has(cmd[k - 1]!)) return true
  let b = k
  while (b > 0 && !BOUNDARY.has(cmd[b - 1]!)) b--
  const tokens = cmd.slice(b, k).split(/[ \t]+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (PREFIX_WORDS.has(tokens[0]!)) return true
  const last = tokens[tokens.length - 1]!
  return last.endsWith("-exec") || last.endsWith("-execdir")
}

function findSegmentEnd(cmd: string, from: number): number {
  let single = false
  let double = false
  let i = from
  while (i < cmd.length) {
    const c = cmd[i]!
    if (single) {
      if (c === "'") single = false
      i++
      continue
    }
    if (double) {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === '"') double = false
      i++
      continue
    }
    if (c === "'") {
      single = true
      i++
      continue
    }
    if (c === '"') {
      double = true
      i++
      continue
    }
    if (SEGMENT_END.has(c)) return i
    i++
  }
  return i
}

function stripFlags(cmd: string, from: number, to: number): string | null {
  let s = from
  let sawDoubleDash = false
  for (;;) {
    if (sawDoubleDash) break
    let k = s
    while (k < to && (cmd[k] === " " || cmd[k] === "\t")) k++
    if (k >= to) break
    let t = k
    while (t < to && cmd[t] !== " " && cmd[t] !== "\t") t++
    const token = cmd.slice(k, t)
    if (token === "--") {
      s = t
      sawDoubleDash = true
      continue
    }
    if (/^--?[A-Za-z0-9]/.test(token)) {
      s = t
      continue
    }
    break
  }
  const rest = cmd.slice(s, to)
  if (rest.trim() === "") return null
  return rest
}

export function rewriteRmCommand(command: string): string {
  let out = ""
  let i = 0
  let single = false
  let double = false
  while (i < command.length) {
    const ch = command[i]!
    if (single) {
      out += ch
      if (ch === "'") single = false
      i++
      continue
    }
    if (double) {
      if (ch === "\\") {
        out += ch + (command[i + 1] ?? "")
        i += 2
        continue
      }
      out += ch
      if (ch === '"') double = false
      i++
      continue
    }
    if (ch === "'") {
      single = true
      out += ch
      i++
      continue
    }
    if (ch === '"') {
      double = true
      out += ch
      i++
      continue
    }
    if (
      ch === "r" &&
      command[i + 1] === "m" &&
      (command[i + 2] === " " || command[i + 2] === "\t") &&
      isCommandPosition(command, i)
    ) {
      const end = findSegmentEnd(command, i + 2)
      const rest = stripFlags(command, i + 2, end)
      if (rest !== null) {
        out += "trash" + rest
        i = end
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

export function splitPatchDeletes(patchText: string): { text: string; paths: string[] } {
  const paths: string[] = []
  const lines = patchText.split("\n").filter((line) => {
    const m = /^\*\*\* Delete File:[ \t]*(.+?)[ \t]*\r?$/.exec(line)
    if (!m) return true
    paths.push(m[1]!)
    return false
  })
  return { text: lines.join("\n"), paths }
}

function hasRemainingOps(patchText: string): boolean {
  return /^\*\*\* (Add File|Update File|Delete File):/m.test(patchText)
}

export default (async ({ client, directory }) => {
  const backend = resolveTrash()
  const label = backend ? (backend.builtin ? "built-in fallback" : backend.argv.join(" ")) : "none"

  try {
    await client.app.log({
      body: {
        service: "rm-to-trash",
        level: backend ? "info" : "warn",
        message: backend
          ? `active (using: ${label})`
          : "no trash backend available; rm rewrite disabled",
      },
    })
  } catch {}

  return {
    "tool.execute.before": async (input, output) => {
      if (!backend) return
      const args = output.args
      if (!args || typeof args !== "object") return

      if (SHELL_TOOLS.has(input.tool)) {
        const command = args.command
        if (typeof command === "string" && command.includes("rm")) {
          const rewritten = rewriteRmCommand(command)
          if (rewritten !== command) args.command = rewritten
        }
        return
      }

      if (PATCH_TOOLS.has(input.tool)) {
        const patchText = args.patchText
        if (typeof patchText !== "string" || !patchText.includes("Delete File")) return
        const { text, paths } = splitPatchDeletes(patchText)
        if (paths.length === 0) return
        try {
          await execFileAsync(
            backend.argv[0]!,
            [...backend.argv.slice(1), ...paths],
            { cwd: directory },
          )
        } catch (err) {
          throw new Error(
            `rm-to-trash: failed to move to Trash: ${paths.join(", ")} (${
              err instanceof Error ? err.message : String(err)
            })`,
          )
        }
        if (!hasRemainingOps(text)) {
          throw new Error(
            `rm-to-trash: file(s) moved to Trash: ${paths.join(", ")}. The patch was deletion-only, nothing left to apply.`,
          )
        }
        args.patchText = text
      }
    },
  }
}) satisfies Plugin
