import { describe, expect, it } from "vitest";
import {
  createKubernetesProvider,
  kubernetesConfigMapUrl,
  kubernetesJobsUrl,
  kubernetesNamespaceUrl,
  kubernetesRunResourceName,
  resolveKubernetesApiServer,
} from "../src/kubernetes";
import {
  createFakeHttp,
  createMemoryStore,
  jsonResponse,
  sampleRunSpec,
} from "./harness";

describe("kubernetes remote provider", () => {
  it("resolves API server from a URL or kubeconfig YAML", () => {
    expect(resolveKubernetesApiServer("  http://127.0.0.1:9/  ")).toBe(
      "http://127.0.0.1:9",
    );
    expect(
      resolveKubernetesApiServer(`
apiVersion: v1
clusters:
- cluster:
    server: https://k8s.example:6443
    `),
    ).toBe("https://k8s.example:6443");
  });

  it("attaches, submits a Job, and reads ConfigMap status against mock fetch", async () => {
    const spec = sampleRunSpec();
    const statusDocument = {
      version: 1 as const,
      runId: spec.runId,
      status: "completed" as const,
      output: "done",
      updatedAt: "2026-01-01T00:00:03.000Z",
    };
    const apiServer = "http://127.0.0.1:9";
    const namespace = "default";
    const secrets = new Map<string, string>();
    const { http, requests } = createFakeHttp((request) => {
      if (
        request.method === "GET" &&
        request.url === kubernetesNamespaceUrl(apiServer, namespace)
      ) {
        return jsonResponse(200, { kind: "Namespace", metadata: { name: namespace } });
      }
      if (
        request.method === "POST" &&
        request.url === kubernetesJobsUrl(apiServer, namespace)
      ) {
        return jsonResponse(201, { kind: "Job" });
      }
      if (
        request.method === "GET" &&
        request.url ===
          kubernetesConfigMapUrl(
            apiServer,
            namespace,
            kubernetesRunResourceName(spec.runId),
          )
      ) {
        return jsonResponse(200, {
          data: {
            "status.json": JSON.stringify(statusDocument),
          },
        });
      }
      if (request.method === "POST") {
        return jsonResponse(201, {});
      }
      return jsonResponse(200, {});
    });

    const provider = createKubernetesProvider({
      store: createMemoryStore(),
      secrets: {
        get: async (key) => secrets.get(key),
        set: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
      fetch: (input, init) =>
        init === undefined ? http.fetch(input) : http.fetch(input, init),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const worker = await provider.provision({
      runtime: "kubernetes",
      displayName: "job-1",
      kubernetes: {
        kubeconfig: apiServer,
        namespace,
      },
    });
    expect(worker).toMatchObject({
      id: "kubernetes/job-1",
      runtime: "kubernetes",
      status: "ready",
    });
    expect(secrets.get("kubeconfig/kubernetes/job-1")).toBe(apiServer);
    expect(
      requests.some(
        (request) =>
          request.method === "GET" &&
          request.url === kubernetesNamespaceUrl(apiServer, namespace),
      ),
    ).toBe(true);

    const runId = await provider.submitRun(worker.id, spec);
    expect(runId).toBe(spec.runId);
    const jobPost = requests.find(
      (request) =>
        request.method === "POST" &&
        request.url === kubernetesJobsUrl(apiServer, namespace),
    );
    expect(jobPost).toBeDefined();
    const jobBody = JSON.parse(jobPost?.body ?? "{}") as {
      spec: {
        template: {
          spec: { containers: { command: readonly string[] }[] };
        };
      };
    };
    expect(jobBody.spec.template.spec.containers[0]?.command).toEqual([
      "node",
      "/usr/local/bin/borg-runtime",
      "/run",
    ]);
    expect(jobPost?.body).not.toMatch(/NodePort/);
    expect(jobPost?.body).not.toMatch(/"kind":"Service"/);

    await expect(provider.getRun(worker.id, spec.runId)).resolves.toEqual(
      statusDocument,
    );
  });
});
