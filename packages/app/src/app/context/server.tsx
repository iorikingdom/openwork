import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type ParentProps } from "solid-js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { isTauriRuntime } from "../utils";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function serverDisplayName(url: string) {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function isLoopbackUrl(input: string) {
  const normalized = normalizeServerUrl(input) ?? "";
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function shouldMigrateLoopbackToDefault() {
  if (typeof window === "undefined") return false;
  if (isTauriRuntime()) return false;
  return !LOOPBACK_HOSTNAMES.has(window.location.hostname);
}

type ServerContextValue = {
  url: string;
  name: string;
  list: string[];
  healthy: () => boolean | undefined;
  setActive: (url: string) => void;
  add: (url: string) => void;
  remove: (url: string) => void;
};

const ServerContext = createContext<ServerContextValue | undefined>(undefined);

export function ServerProvider(props: ParentProps & { defaultUrl: string }) {
  const [list, setList] = createSignal<string[]>([]);
  const [active, setActiveRaw] = createSignal("");
  const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined);
  const [ready, setReady] = createSignal(false);

  const readStoredList = () => {
    try {
      const raw = window.localStorage.getItem("openwork.server.list");
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed)
        ? parsed
            .filter((item) => typeof item === "string")
            .map((item) => normalizeServerUrl(item as string) ?? "")
            .filter((item) => Boolean(item))
        : [];
    } catch {
      return [];
    }
  };

  const readStoredActive = () => {
    try {
      const stored = window.localStorage.getItem("openwork.server.active");
      return typeof stored === "string" ? stored : "";
    } catch {
      return "";
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (ready()) return;

    const storedList = readStoredList();
    const fallback = normalizeServerUrl(props.defaultUrl) ?? "";
    const storedActive = normalizeServerUrl(readStoredActive()) ?? "";

    const migrateLoopback = shouldMigrateLoopbackToDefault() && Boolean(fallback);
    const migrate = (value: string) => {
      if (!migrateLoopback) return value;
      if (!isLoopbackUrl(value)) return value;
      return fallback;
    };

    const migratedList = storedList
      .map(migrate)
      .filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);
    const migratedActive = storedActive ? migrate(storedActive) : "";

    const initialList = migratedList.length ? migratedList : fallback ? [fallback] : [];
    const initialActive = migratedActive || initialList[0] || fallback || "";

    setList(initialList);
    setActiveRaw(initialActive);
    setReady(true);
  });

  createEffect(() => {
    if (!ready()) return;
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem("openwork.server.list", JSON.stringify(list()));
      window.localStorage.setItem("openwork.server.active", active());
    } catch {
      // ignore
    }
  });

  const activeUrl = createMemo(() => active());

  const checkHealth = async (url: string) => {
    if (!url) return false;
    const client = createOpencodeClient({
      baseUrl: url,
      signal: AbortSignal.timeout(3000),
      fetch: isTauriRuntime() ? tauriFetch : undefined,
    });
    return client.global
      .health()
      .then((result) => result.data?.healthy === true)
      .catch(() => false);
  };

  createEffect(() => {
    const url = activeUrl();
    if (!url) return;

    setHealthy(undefined);

    let activeRun = true;
    let busy = false;

    const run = () => {
      if (busy) return;
      busy = true;
      void checkHealth(url)
        .then((next) => {
          if (!activeRun) return;
          setHealthy(next);
        })
        .finally(() => {
          busy = false;
        });
    };

    run();
    const interval = window.setInterval(run, 10_000);

    onCleanup(() => {
      activeRun = false;
      window.clearInterval(interval);
    });
  });

  const setActive = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;
    setActiveRaw(next);
  };

  const add = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => {
      if (current.includes(next)) return current;
      return [...current, next];
    });
    setActiveRaw(next);
  };

  const remove = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => current.filter((item) => item !== next));
    setActiveRaw((current) => {
      if (current !== next) return current;
      const remaining = list().filter((item) => item !== next);
      return remaining[0] ?? "";
    });
  };

  const value: ServerContextValue = {
    get url() {
      return activeUrl();
    },
    get name() {
      return serverDisplayName(activeUrl());
    },
    get list() {
      return list();
    },
    healthy,
    setActive,
    add,
    remove,
  };

  return <ServerContext.Provider value={value}>{props.children}</ServerContext.Provider>;
}

export function useServer() {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error("Server context is missing");
  }
  return context;
}
