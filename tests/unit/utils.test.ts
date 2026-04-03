import { describe, expect, test } from "bun:test";
import { capitalize, chunkText, formatUptime } from "../../src/actions.js";
import { parseChannels } from "../../src/types.js";
import { ROLE_PROMPT, shortenHome } from "../../src/backends/types.js";
import { homedir } from "os";

describe("formatUptime", () => {
  test("seconds only", () => {
    expect(formatUptime(5000)).toBe("5s");
    expect(formatUptime(59000)).toBe("59s");
  });

  test("minutes and seconds", () => {
    expect(formatUptime(60_000)).toBe("1m 0s");
    expect(formatUptime(90_000)).toBe("1m 30s");
    expect(formatUptime(3_599_000)).toBe("59m 59s");
  });

  test("hours and minutes", () => {
    expect(formatUptime(3_600_000)).toBe("1h 0m");
    expect(formatUptime(5_400_000)).toBe("1h 30m");
    expect(formatUptime(86_400_000)).toBe("24h 0m");
  });

  test("zero", () => {
    expect(formatUptime(0)).toBe("0s");
  });
});

describe("capitalize", () => {
  test("capitalizes first letter", () => {
    expect(capitalize("alpha")).toBe("Alpha");
    expect(capitalize("hello world")).toBe("Hello world");
  });

  test("handles empty string", () => {
    expect(capitalize("")).toBe("");
  });

  test("already capitalized", () => {
    expect(capitalize("Alpha")).toBe("Alpha");
  });
});

describe("chunkText", () => {
  test("short text returns single chunk", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  test("splits long text at newlines", () => {
    const text = "line1\nline2\nline3";
    const chunks = chunkText(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("line1");
    expect(chunks.join("")).toContain("line3");
  });

  test("splits at spaces when no newline available", () => {
    const text = "word1 word2 word3 word4 word5";
    const chunks = chunkText(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    // All content should be preserved
    expect(chunks.join(" ")).toContain("word1");
    expect(chunks.join(" ")).toContain("word5");
  });

  test("hard breaks when no space or newline", () => {
    const text = "a".repeat(30);
    const chunks = chunkText(text, 10);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(text);
  });

  test("exact limit returns single chunk", () => {
    const text = "a".repeat(100);
    expect(chunkText(text, 100)).toEqual([text]);
  });
});

describe("parseChannels", () => {
  test("parses string array", () => {
    const result = parseChannels(["alpha", "bravo"]);
    expect(result).toEqual([
      { name: "alpha" },
      { name: "bravo" },
    ]);
  });

  test("parses object array", () => {
    const result = parseChannels([
      { name: "frontend", role: "frontend specialist", model: "claude-sonnet-4-6" },
    ]);
    expect(result).toEqual([
      { name: "frontend", role: "frontend specialist", model: "claude-sonnet-4-6" },
    ]);
  });

  test("handles mixed formats", () => {
    const result = parseChannels([
      { name: "frontend", role: "specialist" },
      "tester",
    ]);
    expect(result).toEqual([
      { name: "frontend", role: "specialist" },
      { name: "tester" },
    ]);
  });

  test("parses channel config with repo", () => {
    const result = parseChannels([
      { name: "infra", repo: "~/projects/infra-repo" },
      { name: "frontend", role: "specialist", repo: "~/projects/webapp" },
    ]);
    expect(result).toEqual([
      { name: "infra", repo: "~/projects/infra-repo" },
      { name: "frontend", role: "specialist", repo: "~/projects/webapp" },
    ]);
  });

  test("throws on empty array", () => {
    expect(() => parseChannels([])).toThrow("No channels configured");
  });

  test("throws on undefined", () => {
    expect(() => parseChannels(undefined)).toThrow("No channels configured");
  });
});

describe("shortenHome", () => {
  const home = homedir();

  test("replaces home dir with ~", () => {
    expect(shortenHome(`${home}/projects/repo`)).toBe("~/projects/repo");
  });

  test("leaves non-home paths unchanged", () => {
    expect(shortenHome("/tmp/test")).toBe("/tmp/test");
  });

  test("handles exact home dir", () => {
    expect(shortenHome(home)).toBe("~");
  });
});

describe("ROLE_PROMPT", () => {
  test("includes name and role", () => {
    const prompt = ROLE_PROMPT("alpha", "code reviewer");
    expect(prompt).toContain("alpha");
    expect(prompt).toContain("code reviewer");
  });

  test("mentions list_bots tool", () => {
    const prompt = ROLE_PROMPT("bravo", "frontend dev");
    expect(prompt).toContain("list_bots");
  });
});
