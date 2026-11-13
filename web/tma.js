"use strict";

(() => {
// The Telegram Mini App layer: theme, the signed-in user, MainButton, BackButton and haptics.
// Everything here is a no-op outside Telegram, so the same page serves the link preview landing.
const tg = () => globalThis.Telegram?.WebApp || null;
const inTelegram = () => Boolean(tg()?.initData);

const THEME_VARS = {
  bg_color: "--tg-bg", secondary_bg_color: "--tg-bg-2", text_color: "--tg-text", hint_color: "--tg-hint",
  link_color: "--tg-link", button_color: "--tg-button", button_text_color: "--tg-button-text",
  section_bg_color: "--tg-section", section_separator_color: "--tg-separator", destructive_text_color: "--tg-bad",
  accent_text_color: "--tg-accent", subtitle_text_color: "--tg-subtitle",
};

// "#rrggbb" to its relative luminance in 0..1, or null when it is not a 6 digit hex colour.
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// The CSS custom properties for a themeParams object, plus whether it is a dark scheme.
function themeVars(params) {
  const vars = {};
  for (const [key, name] of Object.entries(THEME_VARS)) if (/^#[0-9a-f]{6}$/i.test(params?.[key] || "")) vars[name] = params[key];
  const lum = luminance(params?.bg_color);
  return { vars, dark: lum === null ? null : lum < 0.4 };
}

function applyTheme() {
  const app = tg();
  if (!app) return;
  const { vars, dark } = themeVars(app.themeParams);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  if (dark !== null) { root.dataset.scheme = dark ? "dark" : "light"; root.style.colorScheme = dark ? "dark" : "light"; }
  try { if (vars["--tg-bg"]) { app.setHeaderColor?.(vars["--tg-bg"]); app.setBackgroundColor?.(vars["--tg-bg"]); } } catch {}
}

// The signed-in Telegram user: name for display, username for @handles, photo when Telegram sends one.
function user() {
  const u = tg()?.initDataUnsafe?.user;
  if (!u) return null;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "";
  return { id: u.id, name, first: u.first_name || u.username || "", username: u.username || null, photo: u.photo_url || null };
}

const initials = (name) => (String(name || "").match(/[A-Za-z0-9]/g) || ["?"]).slice(0, 2).join("").toUpperCase();

// A deterministic tile for an address: a hue from its bytes and its first two characters after the prefix.
function tileFor(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return { hue, label: initials(String(text).replace(/^(tb1|bc1)/i, "")), bg: `hsl(${hue} 52% 42%)`, bg2: `hsl(${(hue + 40) % 360} 58% 30%)` };
}

function avatar({ name, photo, seed, size = 40 }) {
  const el = document.createElement("span");
  el.className = "tg-avatar";
  el.style.setProperty("--size", `${size}px`);
  const tile = tileFor(seed || name || "?");
  el.style.background = `linear-gradient(145deg, ${tile.bg}, ${tile.bg2})`;
  el.textContent = seed ? tile.label : initials(name);
  if (photo) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("load", () => { el.textContent = ""; el.append(img); });
    img.src = photo;
  }
  el.setAttribute("aria-hidden", "true");
  return el;
}

// Icons are static markup owned by this file.
const BTC_PATH = "M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z";
const ICONS = {
  btc: `<svg viewBox="0 0 24 24" role="img" aria-label="Bitcoin"><circle cx="12" cy="12" r="10.2" fill="#fff"/><path fill="#f7931a" fill-rule="evenodd" d="${BTC_PATH}"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.6" fill="currentColor"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.6 12.4 3.1 3.1 5.8-6.2" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 6.8V12l3.4 2" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  open: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8 13.2 12 9l4 4.2" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  done: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m7.8 12.3 2.8 2.8 5.6-5.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
function icon(name, cls = "") {
  const el = document.createElement("span");
  el.className = `ico ico-${name} ${cls}`.trim();
  el.innerHTML = ICONS[name] || "";
  return el;
}

// One plain word and an icon per contract state. The contract names never reach primary copy.
const STATUS = {
  Minted: { word: "Waiting", icon: "clock" },
  Attesting: { word: "Checking", icon: "clock" },
  Sealed: { word: "Ready", icon: "check" },
  Unsealing: { word: "Opening", icon: "clock" },
  Unsealed: { word: "Open", icon: "open" },
  Resigning: { word: "Opening", icon: "clock" },
  Finalizing: { word: "Settling", icon: "clock" },
  Claimed: { word: "Claimed", icon: "done" },
};
const status = (state) => STATUS[state] || { word: "Waiting", icon: "clock" };

function haptic(kind) {
  const h = tg()?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === "success" || kind === "error" || kind === "warning") h.notificationOccurred(kind);
    else if (kind === "select") h.selectionChanged();
    else h.impactOccurred(kind || "light");
  } catch {}
}

// The MainButton is the primary action. `set` shows it with a label and handler; `busy` shows its native spinner.
let mainHandler = null;
function main(config) {
  const b = tg()?.MainButton;
  if (!b) return false;
  if (mainHandler) { b.offClick(mainHandler); mainHandler = null; }
  if (!config) { b.hideProgress(); b.hide(); return true; }
  const { text, onClick, busy = false, disabled = false } = config;
  b.setParams({ text, is_visible: true, is_active: !busy && !disabled, color: tg().themeParams?.button_color, text_color: tg().themeParams?.button_text_color });
  if (busy) b.showProgress(true); else b.hideProgress();
  if (onClick) { mainHandler = () => { haptic("medium"); onClick(); }; b.onClick(mainHandler); }
  return true;
}

let backHandler = null;
function back(onClick) {
  const b = tg()?.BackButton;
  if (!b) return false;
  if (backHandler) { b.offClick(backHandler); backHandler = null; }
  if (!onClick) { b.hide(); return true; }
  backHandler = () => { haptic("light"); onClick(); };
  b.onClick(backHandler);
  b.show();
  return true;
}

function init() {
  const app = tg();
  if (!app?.initData) return;
  applyTheme();
  app.onEvent?.("themeChanged", applyTheme);
}

const lib = { inTelegram, themeVars, luminance, applyTheme, user, initials, tileFor, avatar, icon, status, haptic, main, back, init };
if (typeof module !== "undefined" && module.exports) module.exports = lib;
globalThis.cachetTma = lib;
if (typeof document !== "undefined") init();

})();
