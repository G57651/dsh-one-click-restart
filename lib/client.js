window.__ModuleLoader__.load({
	id: "@dsh-restart/one-click-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: Module });
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
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var RESTART_ROUTE = "/api/restart-harness";
var STYLE_TAG_ID = "@dsh-restart/one-click-restart/client.css";
async function fetchToken() {
  const response = await fetch(RESTART_ROUTE, { method: "GET" });
  if (!response.ok) return void 0;
  const body = await response.json().catch(() => void 0);
  if (body !== null && typeof body === "object" && typeof body.token === "string") {
    return body.token;
  }
  return void 0;
}
async function requestRestart() {
  let token = globalThis.__DSH_RESTART_TOKEN__;
  if (typeof token !== "string" || token === "") {
    try {
      token = await fetchToken();
    } catch {
      return {
        ok: false,
        message: "\u65E0\u6CD5\u8FDE\u63A5\u5BBF\u4E3B\uFF0C\u91CD\u542F\u672A\u5F00\u59CB \u2014 \u8BF7\u786E\u8BA4 DSH \u6B63\u5728\u8FD0\u884C\u540E\u91CD\u8BD5"
      };
    }
  }
  if (token === void 0) {
    return { ok: false, message: "unauthorized: restart token unavailable \u2014 is the restart route enabled?" };
  }
  let response;
  try {
    response = await fetch(RESTART_ROUTE, {
      method: "POST",
      headers: { "x-restart-token": token }
    });
  } catch {
    return { ok: true, likely: true };
  }
  if (response.status === 401) {
    globalThis.__DSH_RESTART_TOKEN__ = void 0;
    return { ok: false, message: "unauthorized: restart token is stale \u2014 click again" };
  }
  if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
  return { ok: true };
}
function ensureStyleTag() {
  const css = [
    `.dsh-restart-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }`,
    `.dsh-restart-btn:disabled { opacity: 0.55; cursor: default; }`,
    `.dsh-restart-btn .dsh-restart-spin { animation: dsh-restart-rotate 0.9s linear infinite; }`,
    `@keyframes dsh-restart-rotate { to { transform: rotate(360deg); } }`,
    `.dsh-restart-dots span { opacity: 0.2; animation: dsh-restart-dots 1.2s ease-in-out infinite; }`,
    `.dsh-restart-dots span:nth-child(2) { animation-delay: 0.2s; }`,
    `.dsh-restart-dots span:nth-child(3) { animation-delay: 0.4s; }`,
    `@keyframes dsh-restart-dots { 0% { opacity: 0.2; } 30% { opacity: 1; } 60%, 100% { opacity: 0.2; } }`,
    `@media (prefers-reduced-motion: reduce) {`,
    `  .dsh-restart-dots span, .dsh-restart-btn .dsh-restart-spin { animation: none; }`,
    `  .dsh-restart-dots span { opacity: 1; }`,
    `}`
  ].join("\n");
  if (typeof document === "undefined") return;
  const existing = document.querySelector(`style[data-plugin-css='${STYLE_TAG_ID}']`);
  if (existing !== null) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "@dsh-restart/one-click-restart";
  tag.dataset.pluginCss = STYLE_TAG_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}
function RestartIcon({ size, spin }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "svg",
    {
      className: spin ? "dsh-restart-spin" : void 0,
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.3",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M13.7 1.8v2.6h-2.6" })
      ]
    }
  );
}
function RestartButton({ wide }) {
  const [phase, setPhase] = (0, import_react.useState)("idle");
  const [message, setMessage] = (0, import_react.useState)("");
  const onClick = () => {
    if (phase === "pending") return;
    setPhase("pending");
    setMessage("");
    void requestRestart().then((result) => {
      if (result.ok) {
        setPhase("scheduled");
        setMessage(wide ? result.likely ? "\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF0C\u5373\u5C06\u91CD\u542F" : "\u5373\u5C06\u91CD\u542F" : "Restarting");
      } else {
        setPhase("failed");
        setMessage(result.message ?? "restart failed");
      }
    });
  };
  const label = phase === "pending" ? wide ? "\u91CD\u542F\u4E2D" : "Restarting" : phase === "scheduled" ? message : phase === "failed" ? wide ? `\u91CD\u542F\u5931\u8D25\uFF1A${message}` : "Retry restart" : wide ? "\u91CD\u542F Harness" : "Restart Harness";
  const busy = phase === "pending" || phase === "scheduled";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      type: "button",
      className: "dsh-restart-btn",
      title: phase === "failed" ? message : void 0,
      "aria-label": "Restart Harness",
      onClick,
      disabled: phase === "pending",
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: wide ? "flex-start" : "center",
        gap: 8,
        width: wide ? "100%" : 36,
        height: wide ? 42 : 36,
        margin: wide ? 0 : void 0,
        padding: wide ? "0 10px 0 8px" : 0,
        border: "none",
        borderRadius: wide ? 12 : "50%",
        background: "transparent",
        color: phase === "failed" ? "var(--dsw-alias-label-critical, #d5393f)" : "var(--dsw-alias-label-primary)",
        fontFamily: "inherit",
        fontSize: 14,
        cursor: phase === "pending" ? "default" : "pointer",
        overflow: "hidden",
        whiteSpace: "nowrap"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RestartIcon, { size: wide ? 16 : 18, spin: busy }),
        wide && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }, children: [
          label,
          busy && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-restart-dots", "aria-hidden": true, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "." }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "." }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "." })
          ] })
        ] })
      ]
    }
  );
}
var inject = ["slots"];
function apply(ctx) {
  ensureStyleTag();
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    { name: "sidebar.footer.action", id: "one-click-restart", order: 50 },
    RestartButton
  ));
}

		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
