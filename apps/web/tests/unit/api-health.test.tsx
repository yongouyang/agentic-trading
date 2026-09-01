import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiHealth } from "@/app/api-health";

describe("ApiHealth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders the api status when health responds ok", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", instruments: 3 }),
      }),
    );
    render(await ApiHealth());
    expect(screen.getByTestId("api-health")).toHaveTextContent("api: ok (instruments: 3)");
    expect(fetch).toHaveBeenCalledWith("http://api.test/health", { cache: "no-store" });
  });

  it("renders unreachable when the api is down", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    render(await ApiHealth());
    expect(screen.getByTestId("api-health")).toHaveTextContent("api: unreachable");
  });

  it("renders unreachable when health returns a non-200", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(await ApiHealth());
    expect(screen.getByTestId("api-health")).toHaveTextContent("api: unreachable");
  });

  it("renders not-configured without API_INTERNAL_URL", async () => {
    vi.stubEnv("API_INTERNAL_URL", "");
    render(await ApiHealth());
    expect(screen.getByTestId("api-health")).toHaveTextContent("api: not configured");
  });
});
