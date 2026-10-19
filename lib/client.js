window.__ModuleLoader__.load({ id: "@dsh-ssh-workspace/bundle", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  RemoteDirectoryBrowser: () => RemoteDirectoryBrowser,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var API = "/ssh-workspace";
function defaultTitleOf(path) {
  const trimmed = path.replace(/\/+$/u, "");
  if (trimmed === "") return "/";
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1) || "/";
}
var CALL_TIMEOUT_MS = 15e3;
var DIALOG_CLASS = "dsh-ssh-workspace-dialog";
var DIALOG_CSS = `.${DIALOG_CLASS}.${DIALOG_CLASS}{width:min(720px,100%)}`;
async function call(route, query = {}, body) {
  const url = new URL(`${API}${route}`, window.location.origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { accept: "application/json", ...body === void 0 ? {} : { "content-type": "application/json" } },
    ...body === void 0 ? {} : { method: "POST", body: JSON.stringify(body) },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  });
  const responseBody = await response.json().catch(() => void 0);
  if (!response.ok) throw new Error(responseBody?.error ?? `${String(response.status)} ${response.statusText}`);
  return responseBody;
}
var machinesOnce;
function loadMachines() {
  machinesOnce ??= call("/machines").then((result) => result.machines).catch((error) => {
    machinesOnce = void 0;
    throw error;
  });
  return machinesOnce;
}
var prechecks = /* @__PURE__ */ new Map();
function precheckOf(alias) {
  let pending = prechecks.get(alias);
  if (pending === void 0) {
    pending = call("/precheck", { host: alias }).catch((error) => {
      prechecks.delete(alias);
      throw error;
    });
    prechecks.set(alias, pending);
  }
  return pending;
}
var listings = /* @__PURE__ */ new Map();
function listingOf(host, path) {
  const key = `${host ?? "local"}\0${path}`;
  let pending = listings.get(key);
  if (pending === void 0) {
    pending = call("/browse", { path, ...host === void 0 ? {} : { host } }).catch((error) => {
      listings.delete(key);
      throw error;
    });
    listings.set(key, pending);
  }
  return pending;
}
function RemoteDirectoryBrowser(props) {
  const [machines, setMachines] = (0, import_react.useState)(void 0);
  const [host, setHost] = (0, import_react.useState)(void 0);
  const [precheck, setPrecheck] = (0, import_react.useState)(void 0);
  const [checking, setChecking] = (0, import_react.useState)(false);
  const [listing, setListing] = (0, import_react.useState)(void 0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [showHidden, setShowHidden] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const [creating, setCreating] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    if (!props.open) return;
    setHost(void 0);
    setPrecheck(void 0);
    setListing(void 0);
    setError(void 0);
    setCreating(false);
    loadMachines().then((result) => {
      setMachines(result);
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [props.open]);
  const browse = (0, import_react.useCallback)(async (machine, path) => {
    setBusy(true);
    setError(void 0);
    try {
      setListing(await listingOf(machine.alias ?? void 0, path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, []);
  const selectHost = (0, import_react.useCallback)(async (machine) => {
    setHost(machine);
    setPrecheck(void 0);
    setListing(void 0);
    setError(void 0);
    if (machine.local) {
      await browse(machine, "");
      return;
    }
    setChecking(true);
    try {
      setPrecheck(await precheckOf(machine.alias ?? ""));
      await browse(machine, "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  }, [browse]);
  (0, import_react.useEffect)(() => {
    if (!props.open || host !== void 0 || machines === void 0 || machines.length === 0) return;
    void selectHost(machines[0]);
  }, [props.open, host, machines]);
  const openPicked = (0, import_react.useCallback)(async () => {
    if (listing === void 0 || host === void 0) return;
    if (host.local) {
      props.onPicked(listing.path);
      return;
    }
    setCreating(true);
    setError(void 0);
    try {
      const alias = host.alias;
      const created = await call("/adopt", {}, { host: alias, path: listing.path });
      if (created.title === defaultTitleOf(listing.path)) {
        const workspaces = props.ctx.get("workspaces");
        await workspaces.rename(created.workspaceId, `${defaultTitleOf(listing.path)}@${alias}`);
      }
      props.onCancel();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreating(false);
    }
  }, [host, listing, props]);
  const visible = listing?.entries.filter((entry) => showHidden || !entry.hidden) ?? [];
  const status = host === void 0 ? void 0 : host.local ? { text: "\u672C\u673A", tone: "ok" } : checking ? { text: "\u68C0\u6D4B\u4E2D\u2026", tone: "busy" } : precheck === void 0 ? void 0 : { text: `${precheck.status}\uFF1A${precheck.detail}`, tone: precheck.status === "usable" ? "ok" : precheck.status === "needs-credentials" ? "warn" : "bad" };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: props.open,
      onClose: () => {
        if (!busy && !creating) props.onCancel();
      },
      title: "\u9009\u62E9\u5DE5\u4F5C\u533A\u76EE\u5F55",
      closeLabel: "\u5173\u95ED",
      className: DIALOG_CLASS,
      footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: () => {
          if (!busy && !creating) props.onCancel();
        }, children: "\u53D6\u6D88" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: busy || creating || listing === void 0, onClick: () => {
          void openPicked();
        }, children: creating ? "\u6B63\u5728\u6DFB\u52A0\u2026" : "\u6253\u5F00" })
      ] }),
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: PANEL_STYLE, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: HOST_ROW_STYLE, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: LABEL_STYLE, htmlFor: "ssh-workspace-host", children: "\u4E3B\u673A" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "select",
            {
              id: "ssh-workspace-host",
              style: SELECT_STYLE,
              disabled: busy,
              value: host?.alias ?? "",
              onChange: (event) => {
                const selected = machines?.find((machine) => (machine.alias ?? "") === event.target.value);
                if (selected !== void 0) void selectHost(selected);
              },
              children: machines === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u8BFB\u53D6 ~/.ssh/config\u2026" }) : machines.map((machine) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: machine.alias ?? "", children: machine.local ? `${machine.label}\uFF08\u672C\u673A\uFF09` : machine.label }, machine.alias ?? "local"))
            }
          ),
          status === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...STATUS_STYLE, color: TONE_COLOR[status.tone] }, children: status.text })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: PATH_ROW_STYLE, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: PATH_STYLE, children: listing?.path ?? (busy ? "\u52A0\u8F7D\u4E2D\u2026" : "\u8BF7\u9009\u62E9\u4E3B\u673A") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "toolbar", size: "sm", disabled: busy || listing?.parent === void 0, onClick: () => {
            if (host !== void 0 && listing?.parent !== void 0) void browse(host, listing.parent);
          }, children: "\u4E0A\u7EA7" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "toolbar", size: "sm", disabled: busy, onClick: () => {
            setShowHidden((value) => !value);
          }, children: showHidden ? "\u9690\u85CF\u9690\u85CF\u6587\u4EF6" : "\u663E\u793A\u9690\u85CF\u6587\u4EF6" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: TREE_STYLE, children: busy && listing === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: HINT_STYLE, children: "\u52A0\u8F7D\u4E2D\u2026" }) : visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: HINT_STYLE, children: "\uFF08\u6CA1\u6709\u5B50\u76EE\u5F55\uFF09" }) : visible.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "button",
          {
            type: "button",
            disabled: busy,
            onClick: () => {
              if (host !== void 0) void browse(host, entry.path);
            },
            style: ROW_STYLE,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
                "\u{1F4C1} ",
                entry.name
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: FACT_STYLE, children: entry.path })
            ]
          },
          entry.path
        )) }),
        error === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...HINT_STYLE, color: "#c0392b" }, children: error })
      ] })
    }
  );
}
var TONE_COLOR = { ok: "#3f9a4a", warn: "#b07d18", bad: "#c0392b", busy: "#888888" };
var PANEL_STYLE = { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 };
var HOST_ROW_STYLE = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
var PATH_ROW_STYLE = { display: "flex", alignItems: "center", gap: 8 };
var LABEL_STYLE = { fontWeight: 600, fontSize: 13 };
var SELECT_STYLE = {
  flex: "none",
  minWidth: 220,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid rgba(127,127,127,0.35)",
  background: "transparent",
  color: "inherit",
  font: "inherit"
};
var PATH_STYLE = { flex: 1, fontFamily: "monospace", fontSize: 12, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
var STATUS_STYLE = { fontSize: 12 };
var HINT_STYLE = { fontSize: 12, color: "#888888", padding: "8px 0" };
var TREE_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  height: 320,
  overflow: "auto",
  border: "1px solid rgba(127,127,127,0.25)",
  borderRadius: 8,
  padding: 6
};
var ROW_STYLE = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  textAlign: "left",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "rgba(127,127,127,0.08)",
  cursor: "pointer",
  color: "inherit",
  font: "inherit",
  fontSize: 13
};
var FACT_STYLE = { opacity: 0.55, fontFamily: "monospace", fontSize: 11 };
var inject = ["slots", "workspaces"];
function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.dshSshWorkspace = "dialog-width";
    style.textContent = DIALOG_CSS;
    document.head.append(style);
    return () => {
      style.remove();
    };
  }, "ssh-workspace: dialog width");
  const bound = (owner) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RemoteDirectoryBrowser, { ...owner, ctx });
  ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
    yield ctx.slots.register({ name: "conversation.hero.workspace.directoryFlow", priority: -1 }, bound);
    yield ctx.slots.register({ name: "sidebar.workspaces.directoryFlow", priority: -1 }, bound);
  }));
}
return module.exports; } });
