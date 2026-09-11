import { describe, expect, it } from "vitest";
import {
  UNATTENDED_TOOL_ALLOWLIST,
  assertUnattendedAllowlist,
  remoteDestroy,
  remoteGetRun,
  remoteListWorkers,
  remoteProvision,
  remoteRunSpecSchema,
  remoteSubmitRun,
  remoteWorkerIdSchema,
} from "../src/index";

describe("remote runtime contracts", () => {
  it("exports the five borg.remote commands", () => {
    expect(remoteListWorkers.id).toBe("borg.remote.listWorkers");
    expect(remoteProvision.id).toBe("borg.remote.provision");
    expect(remoteDestroy.id).toBe("borg.remote.destroy");
    expect(remoteSubmitRun.id).toBe("borg.remote.submitRun");
    expect(remoteGetRun.id).toBe("borg.remote.getRun");
  });

  it("accepts worker ids only for local, azure-vm, and kubernetes", () => {
    expect(remoteWorkerIdSchema.parse("local/dev")).toBe("local/dev");
    expect(remoteWorkerIdSchema.parse("azure-vm/box-1")).toBe("azure-vm/box-1");
    expect(remoteWorkerIdSchema.parse("kubernetes/job-1")).toBe(
      "kubernetes/job-1",
    );
    expect(() => remoteWorkerIdSchema.parse("laptop/dev")).toThrow();
  });

  it("rejects wildcard tool allowlists, attended specs, and code-act", () => {
    const persona = {
      id: "user/detached",
      name: "Detached",
      instructions: "Finish.",
      preferredModels: ["borg.runtime.scripted:scripted"],
      allowedTools: ["*"],
      loopStrategy: "react" as const,
    };
    expect(() =>
      remoteRunSpecSchema.parse({
        version: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        prompt: "echo hello",
        unattended: true,
        persona,
        provider: { kind: "scripted", replies: [{ content: "done" }] },
      }),
    ).toThrow();
    expect(() =>
      remoteRunSpecSchema.parse({
        version: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        prompt: "echo hello",
        unattended: false,
        persona: { ...persona, allowedTools: ["tools.echo"] },
        provider: { kind: "scripted", replies: [{ content: "done" }] },
      }),
    ).toThrow();
    expect(() =>
      remoteRunSpecSchema.parse({
        version: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        prompt: "echo hello",
        unattended: true,
        persona: {
          ...persona,
          allowedTools: ["tools.echo"],
          loopStrategy: "code-act",
        },
        provider: { kind: "scripted", replies: [{ content: "done" }] },
      }),
    ).toThrow();
  });

  it("rejects tools that need a human, including ask", () => {
    expect(UNATTENDED_TOOL_ALLOWLIST).toEqual(["tools.echo", "filesystem.read"]);
    expect(() => assertUnattendedAllowlist(["tools.echo"])).not.toThrow();
    expect(() => assertUnattendedAllowlist(["tools.ask"])).toThrow(/cannot use/);
    expect(() => assertUnattendedAllowlist(["filesystem.write"])).toThrow(
      /cannot use/,
    );
    expect(() =>
      remoteRunSpecSchema.parse({
        version: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        prompt: "echo hello",
        unattended: true,
        persona: {
          id: "user/detached",
          name: "Detached",
          instructions: "Finish.",
          preferredModels: ["borg.runtime.scripted:scripted"],
          allowedTools: ["tools.ask"],
          loopStrategy: "react",
        },
        provider: { kind: "scripted", replies: [{ content: "done" }] },
      }),
    ).toThrow();
  });

  it("requires azure storageAccount and kubernetes kubeconfig on provision", () => {
    expect(() =>
      remoteProvision.input.parse({ runtime: "azure-vm" }),
    ).toThrow();
    expect(() =>
      remoteProvision.input.parse({ runtime: "kubernetes" }),
    ).toThrow();
    expect(
      remoteProvision.input.parse({
        runtime: "azure-vm",
        azure: {
          subscriptionId: "sub",
          resourceGroup: "rg",
          location: "eastus",
          storageAccount: "userstorageacct",
        },
      }),
    ).toMatchObject({
      runtime: "azure-vm",
      azure: { storageAccount: "userstorageacct", vmSize: "Standard_B2s" },
    });
  });
});
