// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("@/shared/constants/cliTools", () => ({
  CLI_TOOLS: {
    claude: {
      id: "claude",
      name: "Claude Code",
      icon: "terminal",
      color: "#D97757",
      category: "code",
      configType: "env",
      vendor: "Anthropic",
      baseUrlSupport: "full",
      defaultModels: [],
    },
  },
}));

vi.mock("@/shared/constants/models", () => ({
  PROVIDER_ID_TO_ALIAS: { claude: "cc" },
  getModelsByProviderId: (providerId: string) =>
    providerId === "claude"
      ? [
          { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
          { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
          { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
        ]
      : [],
}));

vi.mock("@/app/(dashboard)/dashboard/cli-code/components/index", () => ({
  ClaudeToolCard: ({ availableModels }: { availableModels: Array<{ value: string }> }) => (
    <div
      data-testid="ClaudeToolCard"
      data-models={JSON.stringify(availableModels.map((m) => m.value))}
    />
  ),
  CodexToolCard: () => null,
  DroidToolCard: () => null,
  OpenClawToolCard: () => null,
  ClineToolCard: () => null,
  KiloToolCard: () => null,
  DefaultToolCard: () => null,
  AntigravityToolCard: () => null,
  CopilotToolCard: () => null,
  CustomCliCard: () => null,
  HermesAgentToolCard: () => null,
  GrokBuildToolCard: () => null,
  PiToolCard: () => null,
}));

vi.mock("@/app/(dashboard)/dashboard/cli-code/components/CliproxyapiToolCard", () => ({
  default: () => null,
}));

const { default: ToolDetailClient } =
  await import("@/app/(dashboard)/dashboard/cli-code/components/ToolDetailClient");
const { default: ModelSelectModal } = await import("@/shared/components/ModelSelectModal");

const roots: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const { root, el } of roots.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Claude hidden models across ToolDetailClient and ModelSelectModal", () => {
  it("ToolDetailClient excludes hidden claude models when /v1/models omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/providers") {
          return new Response(
            JSON.stringify({
              connections: [{ id: "c1", provider: "claude", name: "claude", isActive: true }],
            }),
            { status: 200 }
          );
        }
        if (url === "/v1/models") {
          return new Response(
            JSON.stringify({ data: [{ id: "cc/claude-opus-5-5", owned_by: "claude" }] }),
            { status: 200 }
          );
        }
        if (url === "/api/provider-models") {
          return new Response(
            JSON.stringify({ hiddenModelsByProvider: { claude: ["claude-opus-4-7"] } }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ keys: [], cloudEnabled: false }), { status: 200 });
      })
    );

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push({ root, el });

    act(() => {
      root.render(<ToolDetailClient toolId="claude" category="code" />);
    });
    await flush();

    const card = el.querySelector("[data-testid='ClaudeToolCard']");
    const models = JSON.parse(card?.getAttribute("data-models") || "[]") as string[];
    expect(models).toEqual(["cc/claude-opus-5-5"]);
  });

  it("ToolDetailClient static fallback excludes models flagged in hiddenModelsByProvider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/providers") {
          return new Response(
            JSON.stringify({
              connections: [{ id: "c1", provider: "claude", name: "claude", isActive: true }],
            }),
            { status: 200 }
          );
        }
        if (url === "/v1/models") {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (url === "/api/provider-models") {
          return new Response(
            JSON.stringify({ hiddenModelsByProvider: { claude: ["claude-opus-4-7"] } }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ keys: [], cloudEnabled: false }), { status: 200 });
      })
    );

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push({ root, el });

    act(() => {
      root.render(<ToolDetailClient toolId="claude" category="code" />);
    });
    await flush();

    const card = el.querySelector("[data-testid='ClaudeToolCard']");
    const models = JSON.parse(card?.getAttribute("data-models") || "[]") as string[];
    expect(models).toContain("cc/claude-opus-5-5");
    expect(models).not.toContain("cc/claude-opus-4-7");
  });

  it("ModelSelectModal uses authoritative synced catalog for claude and drops un-synced static rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/combos")) return new Response(JSON.stringify({ combos: [] }));
        if (url.includes("/api/provider-nodes")) return new Response(JSON.stringify({ nodes: [] }));
        if (url.includes("/api/provider-models")) {
          return new Response(
            JSON.stringify({
              models: {},
              hiddenModelsByProvider: { claude: ["claude-opus-4-7"] },
            })
          );
        }
        if (url.includes("/api/synced-available-models")) {
          return new Response(
            JSON.stringify({
              claude: [
                { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
                { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
                { id: "claude-fable-5-2", name: "Claude Fable 5.2" },
              ],
            })
          );
        }
        return new Response(JSON.stringify({}));
      })
    );

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push({ root, el });

    await act(async () => {
      root.render(
        <ModelSelectModal
          isOpen={true}
          onClose={vi.fn()}
          onSelect={vi.fn()}
          activeProviders={[{ provider: "claude", id: "c1" }]}
          modelAliases={{}}
          title="Select model"
        />
      );
    });
    await flush();

    expect(document.body.textContent).toContain("Claude Opus 5.5");
    expect(document.body.textContent).toContain("Claude Fable 5.2");
    expect(document.body.textContent).not.toContain("Claude Opus 4.7");
    expect(document.body.textContent).not.toContain("Claude Sonnet 4.5");
  });
});
