import { describe, expect, it } from "vitest";
import {
  azureRunBlobUrl,
  azureVmUrl,
  createAzureVmProvider,
} from "../src/azure-vm";
import {
  createFakeHttp,
  createMemoryStore,
  jsonResponse,
  sampleRunSpec,
} from "./harness";

describe("azure-vm remote provider", () => {
  it("provisions, submits, and reads status against mock fetch", async () => {
    const spec = sampleRunSpec();
    const statusDocument = {
      version: 1 as const,
      runId: spec.runId,
      status: "completed" as const,
      output: "done",
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
    const { http, requests } = createFakeHttp((request) => {
      if (request.url === azureRunBlobUrl(spec.runId, "status.json")) {
        if (request.method === "GET") {
          return jsonResponse(200, statusDocument);
        }
        return jsonResponse(201, {});
      }
      return jsonResponse(request.method === "PUT" ? 201 : 200, {});
    });
    const provider = createAzureVmProvider({
      store: createMemoryStore(),
      fetch: (input, init) =>
        init === undefined ? http.fetch(input) : http.fetch(input, init),
      getToken: async () => "arm-token",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const worker = await provider.provision({
      runtime: "azure-vm",
      displayName: "box-1",
      azure: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        location: "eastus",
        vmSize: "Standard_B2s",
      },
    });
    expect(worker).toMatchObject({
      id: "azure-vm/box-1",
      runtime: "azure-vm",
      status: "ready",
    });

    const vmUrl = azureVmUrl({
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      name: "box-1",
    });
    const provision = requests[0];
    expect(provision?.method).toBe("PUT");
    expect(provision?.url).toBe(vmUrl);
    expect(provision?.headers.get("Authorization")).toBe("Bearer arm-token");
    const provisionBody = JSON.parse(provision?.body ?? "{}") as {
      location: string;
      properties: { hardwareProfile: { vmSize: string } };
    };
    expect(provisionBody.location).toBe("eastus");
    expect(provisionBody.properties.hardwareProfile.vmSize).toBe(
      "Standard_B2s",
    );
    expect(JSON.stringify(provisionBody)).not.toMatch(/publicIP/i);
    expect(JSON.stringify(provisionBody)).not.toMatch(/networkSecurityGroups/i);

    const runId = await provider.submitRun(worker.id, spec);
    expect(runId).toBe(spec.runId);
    const specPut = requests.find(
      (request) =>
        request.method === "PUT" &&
        request.url === azureRunBlobUrl(spec.runId, "spec.json"),
    );
    const statusPut = requests.find(
      (request) =>
        request.method === "PUT" &&
        request.url === azureRunBlobUrl(spec.runId, "status.json"),
    );
    expect(specPut?.body).toContain(spec.runId);
    expect(statusPut?.body).toContain('"status":"running"');

    await expect(provider.getRun(worker.id, spec.runId)).resolves.toEqual(
      statusDocument,
    );
  });
});
