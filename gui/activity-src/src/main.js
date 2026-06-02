import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./activity.css";

const COPY_TEXT = {
  mapping: "Prefix: /\nTarget: nathanneurotic.github.io/SeekDeep-DiscordBot/gui/activity",
  url: "https://nathanneurotic.github.io/SeekDeep-DiscordBot/gui/activity/",
  notes: "Static promotional preview. No live bot control, no backend, no model endpoint."
};

const CHAT_SCENES = {
  explain: {
    user: "@SeekDeep what are you?",
    bot:
      "I am a local-first Discord assistant preview. The real bot can run chat, vision, image generation, archive workflows, and web-routed answers through your configured local stack. This Activity is only a static promotional mockup."
  },
  web: {
    user: "@SeekDeep web:auto summarize this topic",
    bot:
      "Mock route selected: web:auto. In the real bot, this can route through SearXNG when current information is needed. This page does not perform searches or contact a backend."
  },
  persona: {
    user: "@SeekDeep persona set cyber-ocean technician",
    bot:
      "Mock persona loaded: cyber-ocean technician. The real bot can use scoped persona behavior; this demo only shows the interface language."
  }
};

const IMAGE_STATES = [
  {
    className: "",
    label: "queued → render preview",
    seed: "SEED 8842 · 1024² · STATIC"
  },
  {
    className: "state-1",
    label: "render preview → img2img edit",
    seed: "IMG2IMG · DENOISE 0.62 · STATIC"
  },
  {
    className: "state-2",
    label: "edit chain → archive-ready",
    seed: "ARCHIVE MOCK · FINAL PANEL · STATIC"
  }
];

let imageStateIndex = 0;
let discordSdkClient = null;

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function requireClientId() {
  const clientId = String(window.SEEKDEEP_DISCORD_CLIENT_ID || "").trim();

  if (!clientId) {
    throw new Error("Missing Discord Client ID.");
  }

  return clientId;
}

async function setupDiscordActivity() {
  const badge = qs("#sdkBadge");

  try {
    const clientId = requireClientId();
    discordSdkClient = new DiscordSDK(clientId);

    await discordSdkClient.ready();

    document.documentElement.classList.add("discord-activity-ready");

    if (badge) {
      badge.textContent = "SDK READY";
      badge.classList.remove("warn");
      badge.classList.add("ok");
    }
  } catch (error) {
    console.error(error);

    if (badge) {
      badge.textContent = "BROWSER PREVIEW";
      badge.classList.remove("warn");
      badge.classList.add("ok");
    }
  }
}

function showToast(message) {
  const toast = qs("#toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 1900);
}

async function copyText(key) {
  const value = COPY_TEXT[key];
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
    showToast("Copied.");
  } catch {
    fallbackCopy(value);
    showToast("Copied using fallback.");
  }
}

function fallbackCopy(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function switchPanel(panelName) {
  qsa("[data-panel]").forEach((button) => {
    button.classList.toggle("active", button.dataset.panel === panelName);
  });

  qsa("[data-panel-content]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panelContent === panelName);
  });
}

function addMessage(kind, text) {
  const log = qs("#chatLog");
  if (!log) return;

  const item = document.createElement("div");
  item.className = `msg ${kind}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = kind === "bot" ? "S" : "N";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const who = document.createElement("div");
  who.className = "who";
  who.textContent = kind === "bot" ? "SeekDeep Demo" : "NathanNeurotic";

  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;

  bubble.append(who, body);
  item.append(avatar, bubble);
  log.append(item);
  log.scrollTop = log.scrollHeight;
}

function resetChatLog() {
  const log = qs("#chatLog");
  if (!log) return;

  log.textContent = "";

  addMessage("user", "@SeekDeep show the static Activity preview");
  addMessage(
    "bot",
    "Static demo loaded. Discord SDK handshake is for launch readiness only. No backend, no bot commands, no AI server calls. Use the prompt chips above to preview how SeekDeep features are explained."
  );
}

function runPrompt(key) {
  const scene = CHAT_SCENES[key];
  if (!scene) return;

  addMessage("user", scene.user);
  window.setTimeout(() => addMessage("bot", scene.bot), 160);
}

function cycleImageState() {
  imageStateIndex = (imageStateIndex + 1) % IMAGE_STATES.length;

  const state = IMAGE_STATES[imageStateIndex];
  const canvas = qs("#imageCanvas");
  const chain = qs("#chainState");
  const seed = qs(".seed", canvas || document);

  if (canvas) {
    canvas.classList.remove("state-1", "state-2");
    if (state.className) canvas.classList.add(state.className);
  }

  if (chain) chain.textContent = state.label;
  if (seed) seed.textContent = state.seed;
}


async function openExternalUrl(url) {
  if (!url) return;

  try {
    if (discordSdkClient?.commands?.openExternalLink) {
      await discordSdkClient.commands.openExternalLink({ url });
      return;
    }
  } catch (error) {
    console.warn("Discord openExternalLink failed; falling back to window.open.", error);
  }

  window.open(url, "_blank", "noopener,noreferrer");
}
function bindButtons() {
  qsa("[data-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      switchPanel(button.dataset.panel);
    });
  });

  qsa("[data-demo-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      runPrompt(button.dataset.demoPrompt);
    });
  });

  qsa("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => {
      copyText(button.dataset.copy);
    });
  });

  qsa("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = qs(`#${button.dataset.jump}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });


  qsa("[data-open-external]").forEach((button) => {
    button.addEventListener("click", () => {
      openExternalUrl(button.dataset.openExternal);
    });
  });
  const imageButton = qs("[data-cycle-image]");
  if (imageButton) {
    imageButton.addEventListener("click", cycleImageState);
  }

  const motionButton = qs("[data-motion-toggle]");
  if (motionButton) {
    motionButton.addEventListener("click", () => {
      const shell = qs(".shell");
      if (!shell) return;

      const next = shell.dataset.motion === "off" ? "on" : "off";
      shell.dataset.motion = next;
      showToast(next === "off" ? "Motion disabled." : "Motion enabled.");
    });
  }
}

function initMockup() {
  resetChatLog();
  bindButtons();
}

initMockup();
setupDiscordActivity();