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

/**
 * Commands that would permanently destroy data and cannot be safely rewritten
 * to a reversible move. They are rejected so an agent cannot route around the
 * Trash guarantee through an alternate binary, an empty-Trash call, or a
 * nested interpreter.
 *
 * Detection is command-position aware: it walks unquoted shell segments, so
 * the words "empty trash" inside a quoted argument or a commit message are
 * not treated as commands.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let single = false
  let double = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (single) {
      current += ch
      if (ch === "'") single = false
      continue
    }
    if (double) {
      if (ch === "\\") {
        current += ch + (command[i + 1] ?? "")
        i++
        continue
      }
      current += ch
      if (ch === '"') double = false
      continue
    }
    if (ch === "'") {
      single = true
      current += ch
      continue
    }
    if (ch === '"') {
      double = true
      current += ch
      continue
    }
    if (SEGMENT_END.has(ch) || ch === "(") {
      segments.push(current)
      current = ""
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments
}

function baseName(token: string): string {
  const clean = token.replace(/^["']|["']$/g, "")
  const slash = clean.lastIndexOf("/")
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

export function findBlockedCommand(command: string): string | undefined {
  for (const segment of splitSegments(command)) {
    const trimmed = segment.trim()
    if (!trimmed) continue

    const words = trimmed.split(/\s+/)
    let i = 0
    while (i < words.length && PREFIX_WORDS.has(baseName(words[i]!))) i++
    if (i >= words.length) continue

    const rawName = words[i]!
    const name = baseName(rawName)
    const rest = words.slice(i + 1).join(" ")

    if (name === "rm") {
      if (rawName.includes("/")) return "absolute-path rm"
      if (/(?:\.Trash\b|\.local\/share\/Trash\b)/.test(rest)) {
        return "deleting the Trash directory"
      }
      continue
    }

    if (name === "osascript") {
      if (/\b(?:empty|delete)\b[\s\S]*\btrash\b/i.test(rest)) {
        return "emptying or deleting the Trash via osascript"
      }
      continue
    }

    if (name === "trash-empty") return "trash-empty"

    if (name === "gio") {
      if (/^trash\b/.test(rest) && /\s(?:--empty|-e)\b/.test(rest)) {
        return "gio trash --empty"
      }
      continue
    }

    if (name === "busybox") {
      if (baseName(words[i + 1] ?? "") === "rm") return "busybox rm"
      continue
    }

    if (name === "unlink" || name === "shred" || name === "srm" || name === "wipe") {
      return "permanent-delete command"
    }

    if (name === "find") {
      if (/\s-delete\b/.test(rest)) return "find -delete"
      continue
    }

    if (name === "sudo") {
      if (words.slice(i + 1).some((word) => baseName(word) === "rm")) return "sudo rm"
      continue
    }

    if (name === "bash" || name === "sh" || name === "zsh" || name === "dash") {
      if (/-c\b/.test(rest) && /\brm\b/.test(rest)) return "nested shell rm"
      continue
    }

    if (/^python[0-9.]*$/.test(name)) {
      if (/\b(?:os\.remove|os\.unlink|shutil\.rmtree)\b/.test(rest)) {
        return "Python deletion API"
      }
      continue
    }

    if (name === "node") {
      if (/\b(?:fs\.rmSync|fs\.rm\b|rmSync|unlinkSync|rmdirSync)\b/.test(rest)) {
        return "Node deletion API"
      }
      continue
    }
  }
  return undefined
}

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

/* ------------------------------------------------------------------ *
 * OpenCode 2.x (V2) plugin API. Structural types on purpose: the host
 * passes its own context object and we avoid a hard runtime dependency
 * on @opencode/plugin. Mirrors `Plugin.Context` / `Plugin.define`.
 * ------------------------------------------------------------------ */
type ToolExecuteBeforeEvent = {
  readonly tool: string
  readonly sessionID: string
  readonly messageID: string
  readonly id: string
  input: unknown
}

type Registration = { dispose: () => Promise<void> | void }

type V2Context = {
  readonly location?: { readonly directory?: string }
  readonly tool: {
    hook: (
      name: "execute.before",
      callback: (event: ToolExecuteBeforeEvent) => void | Promise<void>,
    ) => Promise<Registration>
  }
}

const RmToTrash = {
  id: "rm-to-trash",
  async setup(ctx: V2Context) {
    const backend = resolveTrash()
    if (!backend) return

    const directory = ctx.location?.directory ?? process.cwd()

    const registration = await ctx.tool.hook("execute.before", async (event) => {
      const raw = event.input
      if (!raw || typeof raw !== "object") return
      const args = { ...(raw as Record<string, unknown>) }
      const tool = event.tool.toLowerCase()

      if (SHELL_TOOLS.has(tool)) {
        const command = args.command
        if (typeof command === "string") {
          const blocked = findBlockedCommand(command)
          if (blocked) {
            throw new Error(
              `rm-to-trash: blocked a command that would permanently delete data (${blocked}). ` +
                `Nothing was executed. Use a reversible delete (move to Trash) or ask the user how to proceed.`,
            )
          }
          if (command.includes("rm")) {
            const rewritten = rewriteRmCommand(command)
            if (rewritten !== command) {
              args.command = rewritten
              event.input = args
            }
          }
        }
        return
      }

      if (PATCH_TOOLS.has(tool)) {
        const patchText = args.patchText
        if (typeof patchText !== "string" || !patchText.includes("Delete File")) return
        const { text, paths } = splitPatchDeletes(patchText)
        if (paths.length === 0) return
        try {
          await execFileAsync(backend.argv[0]!, [...backend.argv.slice(1), ...paths], {
            cwd: directory,
          })
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
        event.input = args
      }
    })

    return () => registration.dispose()
  },
}

export default RmToTrash
