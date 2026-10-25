import { describe, expect, test } from "bun:test";
import {
  approvalAction,
  clamp,
  missingCliHint,
  parseKeyValuePairs,
  redact,
  redactValue,
  requireChecksPassed,
  requireConfirm,
  sanitizeAnsibleBin,
  tryParseJson,
} from "../tools/_iac";

/** Tool content is a text/image union; read the text block only. */
function resultText(result: { content: Array<{ type: string; text?: string }> } | undefined): string {
  const first = result?.content[0];
  return first && first.type === "text" && typeof first.text === "string" ? first.text : "";
}

describe("clamp", () => {
  test("keeps short text unchanged", () => {
    expect(clamp("hello")).toBe("hello");
  });

  test("drops the middle and reports how much", () => {
    expect(clamp("a".repeat(100), 20)).toContain("[81 chars truncated]");
  });

  test("tail mode keeps the end (apply logs)", () => {
    expect(clamp(`${"x".repeat(100)}END`, 10, "tail")).toContain("END");
  });
});

describe("redact", () => {
  test("masks secret-looking keys", () => {
    expect(redactValue("AWS_SECRET_ACCESS_KEY", "abc")).toBe("***redacted***");
    expect(redactValue("PULUMI_ACCESS_TOKEN", "pul-" + "a".repeat(40))).toBe("***redacted***");
  });

  test("leaves non-secret keys visible", () => {
    expect(redactValue("AWS_ENDPOINT_URL", "http://localhost:4566")).toBe("http://localhost:4566");
  });

  test("strips AWS key ids embedded in output", () => {
    expect(redact("using AKIAIOSFODNN7EXAMPLE for auth")).toBe("using ***redacted*** for auth");
  });

  test("strips KEY=secret assignments from CLI output", () => {
    expect(redact("AWS_SECRET_ACCESS_KEY=hunter2 plan ok")).toBe("AWS_SECRET_ACCESS_KEY=***redacted*** plan ok");
  });
});

describe("parseKeyValuePairs", () => {
  test("parses KEY=VALUE lists", () => {
    expect(parseKeyValuePairs(["A=1", "B=http://x:4566"]).env).toEqual({ A: "1", B: "http://x:4566" });
  });

  test("reports malformed entries instead of dropping them", () => {
    const parsed = parseKeyValuePairs(["NOPE"]);
    expect(parsed.error).toContain("must be KEY=VALUE");
  });

  test("keeps '=' inside the value", () => {
    expect(parseKeyValuePairs(["URL=a=b"]).env.URL).toBe("a=b");
  });
});

describe("requireConfirm", () => {
  test("returns a refusal without confirm", () => {
    expect(requireConfirm(undefined, "destroy the workspace")?.isError).toBe(true);
  });

  test("passes with confirm", () => {
    expect(requireConfirm(true, "destroy the workspace")).toBeUndefined();
  });
});

describe("requireChecksPassed", () => {
  test("passes when every check is ok", () => {
    expect(requireChecksPassed([{ name: "tofu validate", ok: true }])).toBeUndefined();
  });

  test("names the failed checks", () => {
    const refusal = requireChecksPassed([
      { name: "tofu validate", ok: false },
      { name: "tofu plan", ok: true },
    ]);
    expect(refusal?.isError).toBe(true);
    expect(resultText(refusal)).toContain("tofu validate");
  });
});

describe("approvalAction", () => {
  test("narrows the unknown approval args", () => {
    expect(approvalAction({ action: "apply" })).toBe("apply");
  });

  test("returns undefined for non-objects and non-string actions", () => {
    expect(approvalAction(undefined)).toBeUndefined();
    expect(approvalAction({ action: 42 })).toBeUndefined();
  });
});

describe("missingCliHint", () => {
  const runResult = (stdout: string, stderr: string) => ({
    stdout,
    stderr,
    code: stderr ? 1 : 0,
    command: "tofu version",
    timedOut: false,
    killed: false,
  });

  test("is empty for a normal failure", () => {
    expect(missingCliHint(runResult("", "Some other error"), "tofu", { installHint: "x" })).toBe("");
  });

  test("names the binary when it is not installed", () => {
    const hint = missingCliHint(runResult("", "tofu: command not found"), "tofu", {
      installHint: "Install OpenTofu.",
    });
    expect(hint).toContain("tofu");
    expect(hint).toContain("Install OpenTofu.");
  });
});

describe("sanitizeAnsibleBin", () => {
  test("maps the ansible sub-tools", () => {
    expect(sanitizeAnsibleBin("playbook")).toBe("ansible-playbook");
    expect(sanitizeAnsibleBin("ad_hoc")).toBe("ansible");
  });

  test("falls back to ansible-<name>", () => {
    expect(sanitizeAnsibleBin("doc")).toBe("ansible-doc");
  });
});

describe("tryParseJson", () => {
  test("returns undefined for non-JSON", () => {
    expect(tryParseJson("not json")).toBeUndefined();
  });

  test("parses validate output shape", () => {
    expect(tryParseJson<{ valid: boolean }>('{"valid":true}')?.valid).toBe(true);
  });
});
