import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FALLBACK_TRASH, findBlockedCommand, rewriteRmCommand, splitPatchDeletes } from "./rm-to-trash.ts"

describe("rewriteRmCommand", () => {
  test("rewrites a leading rm and drops its flags", () => {
    expect(rewriteRmCommand("rm -rf node_modules")).toBe("trash node_modules")
    expect(rewriteRmCommand("rm a.txt b.txt")).toBe("trash a.txt b.txt")
    expect(rewriteRmCommand("rm -r -f dist")).toBe("trash dist")
  })

  test("rewrites rm after separators and prefix commands", () => {
    expect(rewriteRmCommand("cd build && rm -rf out")).toBe("cd build && trash out")
    expect(rewriteRmCommand("echo x | xargs rm -f {}")).toBe("echo x | xargs trash {}")
    expect(rewriteRmCommand("find . -name '*.tmp' -exec rm {} +")).toBe(
      "find . -name '*.tmp' -exec trash {} +",
    )
  })

  test("ignores rm as an argument, inside quotes, or as part of a word", () => {
    expect(rewriteRmCommand("echo rm foo")).toBe("echo rm foo")
    expect(rewriteRmCommand("echo 'rm foo'")).toBe("echo 'rm foo'")
    expect(rewriteRmCommand('echo "rm foo"')).toBe('echo "rm foo"')
    expect(rewriteRmCommand("confirm foo")).toBe("confirm foo")
    expect(rewriteRmCommand("rm")).toBe("rm")
  })

  test("leaves sudo rm untouched", () => {
    expect(rewriteRmCommand("sudo rm -rf /tmp/x")).toBe("sudo rm -rf /tmp/x")
  })
})

describe("splitPatchDeletes", () => {
  test("removes Delete File lines and collects their paths", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: a.txt",
      "*** Update File: b.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")

    const { text, paths } = splitPatchDeletes(patch)

    expect(paths).toEqual(["a.txt"])
    expect(text).not.toContain("Delete File")
    expect(text).toContain("*** Update File: b.txt")
  })

  test("returns an empty path list when nothing is deleted", () => {
    const patch = "*** Add File: c.txt\n+hi"
    const { text, paths } = splitPatchDeletes(patch)

    expect(paths).toEqual([])
    expect(text).toBe(patch)
  })
})

describe("built-in fallback trash script", () => {
  test("moves files into $HOME/.Trash on macOS", () => {
    if (process.platform !== "darwin") return

    const home = mkdtempSync(join(tmpdir(), "rm-to-trash-"))
    const script = join(home, "trash")
    writeFileSync(script, FALLBACK_TRASH)
    chmodSync(script, 0o755)

    const victim = join(home, "victim.txt")
    writeFileSync(victim, "bye")

    const res = Bun.spawnSync(["/bin/sh", script, victim], {
      env: { ...process.env, HOME: home },
    })

    expect(res.exitCode).toBe(0)
    expect(existsSync(victim)).toBe(false)
    expect(existsSync(join(home, ".Trash", "victim.txt"))).toBe(true)
  })

  test("avoids name collisions in the Trash", () => {
    if (process.platform !== "darwin") return

    const home = mkdtempSync(join(tmpdir(), "rm-to-trash-"))
    const script = join(home, "trash")
    writeFileSync(script, FALLBACK_TRASH)
    chmodSync(script, 0o755)

    const env = { ...process.env, HOME: home }
    const a = join(home, "a", "dup.txt")
    const b = join(home, "b", "dup.txt")
    for (const dir of [join(home, "a"), join(home, "b")]) {
      Bun.spawnSync(["mkdir", "-p", dir])
    }
    writeFileSync(a, "1")
    writeFileSync(b, "2")

    Bun.spawnSync(["/bin/sh", script, a], { env })
    Bun.spawnSync(["/bin/sh", script, b], { env })

    expect(existsSync(join(home, ".Trash", "dup.txt"))).toBe(true)
    expect(existsSync(join(home, ".Trash", "dup.txt 1"))).toBe(true)
  })
})

describe("findBlockedCommand", () => {
  test("blocks emptying or deleting the Trash", () => {
    expect(
      findBlockedCommand(`osascript -e 'tell application "Finder" to empty trash'`),
    ).toBeDefined()
    expect(findBlockedCommand("trash-empty")).toBeDefined()
    expect(findBlockedCommand("gio trash --empty")).toBeDefined()
    expect(findBlockedCommand("rm -rf ~/.Trash")).toBeDefined()
    expect(findBlockedCommand("rm -rf ~/.local/share/Trash/files")).toBeDefined()
  })

  test("blocks deletion bypasses that cannot be rewritten", () => {
    expect(findBlockedCommand("/bin/rm -rf x")).toBeDefined()
    expect(findBlockedCommand("busybox rm x")).toBeDefined()
    expect(findBlockedCommand("unlink x")).toBeDefined()
    expect(findBlockedCommand("shred -u secret.txt")).toBeDefined()
    expect(findBlockedCommand("find . -name '*.tmp' -delete")).toBeDefined()
    expect(findBlockedCommand("sudo rm -rf x")).toBeDefined()
    expect(findBlockedCommand(`bash -c "rm -rf x"`)).toBeDefined()
    expect(findBlockedCommand(`python -c "import shutil; shutil.rmtree('x')"`)).toBeDefined()
  })

  test("allows reversible and unrelated commands", () => {
    expect(findBlockedCommand("rm -rf node_modules")).toBeUndefined()
    expect(findBlockedCommand("trash node_modules")).toBeUndefined()
    expect(findBlockedCommand("find . -name '*.tmp' -exec rm {} +")).toBeUndefined()
    expect(findBlockedCommand("ls ~/.Trash")).toBeUndefined()
    expect(findBlockedCommand("echo empty trash")).toBeUndefined()
  })

  test("does not treat quoted text as a command", () => {
    expect(findBlockedCommand(`git commit -m "osascript empty trash"`)).toBeUndefined()
    expect(findBlockedCommand(`echo "rm -rf ~/.Trash"`)).toBeUndefined()
    expect(findBlockedCommand(`grep -r "unlink" src`)).toBeUndefined()
  })
})
