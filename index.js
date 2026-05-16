import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import {
  ActionRowBuilder,
  ApplicationCommandType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContextMenuCommandBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  Partials,
  SlashCommandBuilder,
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.DISCORD_TOKEN || '';
const LOCAL_AI_BASE_URL = process.env.LOCAL_AI_BASE_URL || 'http://127.0.0.1:7865';
const SEARXNG_BASE_URL = process.env.SEARXNG_BASE_URL || 'http://127.0.0.1:8080';
const WEB_SEARCH_PROVIDER = (process.env.WEB_SEARCH_PROVIDER || 'searxng').toLowerCase();
const WEB_APPEND_SOURCES = (process.env.WEB_APPEND_SOURCES || 'true').toLowerCase() !== 'false';
const MAX_DISCORD_CHARS = Number(process.env.MAX_DISCORD_CHARS || 1900);

// SEEKDEEP_EPHEMERAL_FLAGS_START
function seekdeepIsInteractionLikeTarget(target) {
  return !!(
    target &&
    !target.author &&
    (
      typeof target.deferReply === 'function' ||
      typeof target.followUp === 'function' ||
      typeof target.editReply === 'function' ||
      typeof target.isRepliable === 'function' ||
      Object.prototype.hasOwnProperty.call(target, 'deferred') ||
      Object.prototype.hasOwnProperty.call(target, 'replied')
    )
  );
}

function seekdeepEphemeralPayload(payload = {}) {
  const next = { ...payload };
  delete next.ephemeral;
  next.flags = MessageFlags.Ephemeral;
  return next;
}

function seekdeepMaybeEphemeralPayload(target, payload = {}) {
  const next = { ...payload };
  delete next.ephemeral;
  if (seekdeepIsInteractionLikeTarget(target)) {
    next.flags = MessageFlags.Ephemeral;
  }
  return next;
}
// SEEKDEEP_EPHEMERAL_FLAGS_END

// SEEKDEEP_RESPONSE_FOOTER_START
const SEEKDEEP_NO_MODEL_USED_LABEL = 'local command (no AI model)';

function seekdeepNowMs() {
  return Date.now();
}

function seekdeepMarkRequestStart(target) {
  try {
    if (target && !target.__seekdeepRequestStartedAt) {
      target.__seekdeepRequestStartedAt = seekdeepNowMs();
    }
  } catch {}
}

function seekdeepSetResponseModel(target, modelUsed) {
  try {
    if (target) target.__seekdeepResponseModel = modelUsed || SEEKDEEP_NO_MODEL_USED_LABEL;
  } catch {}
}

// Last chat model the local AI server actually loaded for a /chat request.
// Updated by runLocalChat() from the server's response. Falls back to LOCAL_CHAT_MODEL_ID.
let seekdeepLastChatModelId = '';
let seekdeepLastChatModelRole = '';

function seekdeepRememberLastChatModel(modelId, role) {
  if (modelId) seekdeepLastChatModelId = String(modelId);
  if (role) seekdeepLastChatModelRole = String(role);
}

function seekdeepChatModelLabel() {
  return seekdeepLastChatModelId || process.env.LOCAL_CHAT_MODEL_ID || 'Qwen/Qwen3-8B';
}

function seekdeepDefaultChatModelLabel() {
  return process.env.LOCAL_CHAT_MODEL_ID || 'Qwen/Qwen3-8B';
}

function seekdeepVisionModelLabel() {
  return process.env.LOCAL_VISION_MODEL_ID || 'Qwen/Qwen2.5-VL-3B-Instruct';
}

function seekdeepImageModelLabel() {
  return process.env.LOCAL_IMAGE_MODEL_ID || 'Lykon/dreamshaper-xl-1-0';
}

function seekdeepNoModelLabel() {
  return SEEKDEEP_NO_MODEL_USED_LABEL;
}

function seekdeepElapsedSeconds(startedAt) {
  const start = Number(startedAt || seekdeepNowMs());
  const elapsedMs = Math.max(0, seekdeepNowMs() - start);
  return (elapsedMs / 1000).toFixed(2);
}

function seekdeepResponseFooter({ startedAt = null, modelUsed = null } = {}) {
  const model = modelUsed || SEEKDEEP_NO_MODEL_USED_LABEL;

  return [
    `Time to Generate: ${seekdeepElapsedSeconds(startedAt)} seconds`,
    `Model Used: ${model}`,
  ].join('\n');
}

function seekdeepIsNoModelReportLabel(modelUsed = '') {
  const model = String(modelUsed || '').trim().toLowerCase();
  return !model ||
    model === 'local command (no ai model)' ||
    model === 'local command' ||
    model === 'none' ||
    model === 'n/a';
}

function seekdeepCleanPublicReportText(value = '') {
  return String(value || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^Generated:/gim, 'Generated:')
    .replace(/^Archived to this server.\s*\n?\[local archive path hidden\]\s*$/gim, 'Archived to this server.')
    .replace(/^Archived to this server.\s*$/gim, 'Archived to this server.')
    .replace(/^Archived locally for this server\.\s*$/gim, 'Archived to this server.')
    .trim();
}

function seekdeepCompactQueueSummary(body = '') {
  const text = String(body || '').trim();

  if (/^Queued both prompt versions\./i.test(text) || /^Queued both regenerate versions\./i.test(text) || /^Queued both:/i.test(text)) {
    return 'Queued both:\n- Original\n- Refined';
  }

  if (/^Queued original prompt\./i.test(text) || /^Queued original regenerate\./i.test(text) || /^Queued original\./i.test(text)) {
    return 'Queued original.';
  }

  if (/^Queued refined prompt\./i.test(text) || /^Queued refined regenerate\./i.test(text) || /^Queued refined\./i.test(text)) {
    return 'Queued refined.';
  }

  return text;
}

function seekdeepShouldHideCommandFooter(body = '', meta = {}) {
  const modelUsed = meta?.modelUsed || meta?.model || '';
  const text = String(body || '').trim();

  if (!seekdeepIsNoModelReportLabel(modelUsed)) return false;

  return Boolean(
    /^Queued (?:both|original|refined)/i.test(text) ||
    /^Prompt choice expired/i.test(text) ||
    /^Only the requester can use/i.test(text) ||
    /^Image generation cooldown is active/i.test(text) ||
    /^Archived (?:to|locally|on)/i.test(text) ||
    /^Archive(?:\s|$)/i.test(text) ||
    /^Image archive status/i.test(text) ||
    /^Shared archive:/i.test(text) ||
    /^Your archive:/i.test(text) ||
    /^Archive for <@/i.test(text) ||
    /^Download URL:/i.test(text)
  );
}

function seekdeepAppendResponseFooter(content, meta = {}) {
  const rawBody = String(content ?? '').trim();
  const body = seekdeepCleanPublicReportText(seekdeepCompactQueueSummary(rawBody));

  const fallbackNoModel = typeof SEEKDEEP_NO_MODEL_USED_LABEL !== 'undefined'
    ? SEEKDEEP_NO_MODEL_USED_LABEL
    : 'local command (no AI model)';

  const modelUsed = meta.modelUsed || meta.model || fallbackNoModel;

  if (typeof seekdeepTrackBotResponse === 'function') {
    seekdeepTrackBotResponse(modelUsed);
  }

  if (seekdeepShouldHideCommandFooter(body, { ...meta, modelUsed })) {
    return body;
  }

  if (typeof seekdeepResponseFooter === 'function') {
    const footer = seekdeepResponseFooter({
      ...meta,
      modelUsed,
    });

    return body ? `${body}\n\n${footer}` : footer;
  }

  const footer = [];
  const startedAt = Number(meta.startedAt || 0);

  if (startedAt > 0) {
    footer.push(`Time to Generate: ${((Date.now() - startedAt) / 1000).toFixed(2)} seconds`);
  }

  if (modelUsed && !seekdeepIsNoModelReportLabel(modelUsed)) {
    footer.push(`Model Used: ${modelUsed}`);
  }

  return footer.length ? `${body}\n\n${footer.join('\n')}` : body;
}

function seekdeepModelUsedForInteraction(interaction) {
  if (interaction?.__seekdeepResponseModel) return interaction.__seekdeepResponseModel;

  switch (interaction?.commandName) {
    case 'ask':
    case 'refine':
      return seekdeepChatModelLabel();
    case 'vision':
      return seekdeepVisionModelLabel();
    case 'image':
      return seekdeepImageModelLabel();
    case 'status':
      return seekdeepNoModelLabel();
    default:
      return seekdeepNoModelLabel();
  }
}

function seekdeepModelUsedForMessage(message, content = '') {
  if (message?.__seekdeepResponseModel) return message.__seekdeepResponseModel;

  const body = String(content || '').trim();

  if (/^pong$/i.test(body)) return seekdeepNoModelLabel();
  if (/^Local AI server status/i.test(body)) return seekdeepNoModelLabel();
  if (/^Archive /i.test(body) || /^Posting archive:/i.test(body)) return seekdeepNoModelLabel();
  if (/^SeekDeep request failed/i.test(body)) return seekdeepNoModelLabel();

  return seekdeepChatModelLabel();
}
// SEEKDEEP_RESPONSE_FOOTER_END

// SEEKDEEP_STATUS_METRICS_START
const seekdeepBotMetrics = globalThis.__seekdeepBotMetrics || {
  startedAt: Date.now(),
  responsesSinceBoot: 0,
  responsesByModel: {},
};

globalThis.__seekdeepBotMetrics = seekdeepBotMetrics;

function seekdeepTrackBotResponse(modelUsed = 'unknown') {
  const model = String(modelUsed || 'unknown');
  seekdeepBotMetrics.responsesSinceBoot += 1;
  seekdeepBotMetrics.responsesByModel[model] = (seekdeepBotMetrics.responsesByModel[model] || 0) + 1;
}

function seekdeepFormatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}


function seekdeepRedactStatusConnectionInfo(value = '') {
  return String(value || '')
    // Full local/private URLs with optional paths.
    .replace(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?::\d{1,5})?(?:\/[^\s]*)?/gi, 'local service')
    // Bare local/private host:port.
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}):\d{1,5}\b/gi, 'local service')
    // Any leftover explicit loopback labels.
    .replace(/\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\])\b/gi, 'local service');
}

function seekdeepCurrentLoadedModelFromHealth(health = {}) {
  const task = String(health.loaded_task || 'none').toLowerCase();

  if (task === 'chat') return health.models?.chat || seekdeepChatModelLabel();
  if (task === 'vision') return health.models?.vision || seekdeepVisionModelLabel();
  if (task === 'image') return health.models?.image || seekdeepImageModelLabel();

  return 'none';
}

function seekdeepFormatResponsesByModel() {
  const entries = Object.entries(seekdeepBotMetrics.responsesByModel || {})
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) return 'none yet';

  return entries.map(([model, count]) => `${model}: ${count}`).join('\n');
}
// SEEKDEEP_STATUS_METRICS_END

// SEEKDEEP_REFINE_MODE_START
const REFINE_SYSTEM_PROMPT = [
  'You are SeekDeep dedicated prompt-refinement mode.',
  'Return only the rewritten prompt unless the user explicitly asks for notes.',
  'Preserve the user subject, mood, details, constraints, negatives, intended use, and requested length.',
  'Expand with concrete, distinct, prompt-useful detail instead of filler.',
  'Do not repeat sentences, paragraph structures, or near-identical ideas.',
  'Do not pad with generic phrases such as "magic and wonder", "tranquility and peace", or similar filler loops.',
  'Do not turn the prompt into an article, sales pitch, essay, or travel brochure unless asked.',
  'Do not add citations, sources, links, or web context unless the user explicitly requested research or factual accuracy.',
  'If a target length is requested, reach it through distinct categories: setting, atmosphere, lighting, palette, texture, foreground, midground, background, composition, motion, sensory details, style, constraints, and negative prompt details.',
  'Every paragraph must introduce new information.',
  'Before finalizing, remove duplicated sentences and repeated phrasing.',
].join('\n');

function refineExplicitlyRequestsWeb(prompt) {
  return /\b(research|look up|lookup|web|internet|current|latest|today|2026|cite|citation|sources|fact[- ]?check|historically accurate|real[- ]world accurate)\b/i.test(String(prompt || ''));
}

function detectTargetCharacters(prompt) {
  const text = String(prompt || '');
  const matches = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:characters|character|chars|char)\b/gi)];
  if (!matches.length) return 0;

  const raw = matches[matches.length - 1][1].replace(/,/g, '');
  const value = Number(raw);

  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 12000));
}

function maxTokensForRefine(prompt) {
  const target = detectTargetCharacters(prompt);
  const configured = Number(process.env.REFINE_MAX_NEW_TOKENS || 0);

  if (configured > 0) return Math.max(500, Math.min(configured, 4096));
  if (target >= 1000) return Math.max(900, Math.min(Math.ceil(target / 2.4) + 400, 4096));

  return 1400;
}

function buildRefineUserPrompt(prompt, key = null) {
  const clean = normalizeUserText(prompt);
  const target = detectTargetCharacters(clean);
  const recent = key && seekdeepShouldUseMemorySafeV13(clean) ? seekdeepGetRecentContextSafeV13(key) : '';

  const parts = [
    'Rewrite and improve the following prompt.',
    'The output must be a finished prompt the user can copy and use directly.',
    'Do not include analysis, sources, commentary, or a title unless the user requested that.',
    'Preserve all concrete details already present.',
    'Add new detail by category, not by repeating the same idea.',
    'Avoid repetition aggressively.',
  ];

  if (target) {
    parts.push(`Target length: approximately ${target.toLocaleString()} characters. Do not meet this by looping or repeating phrases.`);
  }

  if (recent) {
    parts.push('', 'Recent context for resolving this refinement only:', recent);
  }

  parts.push('', 'Original prompt/request:', clean);
  return parts.join('\n');
}

function stripRefineSources(text) {
  return String(text || '').replace(/\n\s*Sources:\s*\n[\s\S]*$/i, '').trim();
}

function sentenceKey(sentence) {
  return String(sentence || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeRepeatedSentences(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const pieces = raw.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const kept = [];

  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;

    const key = sentenceKey(trimmed);
    if (key.length > 24 && seen.has(key)) continue;
    if (key.length > 24) seen.add(key);

    kept.push(trimmed);
  }

  return kept.join(' ').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanupRefinedPrompt(text) {
  let out = stripRefineSources(text);

  out = out.replace(/^\s*(refined prompt|improved prompt|rewritten prompt)\s*:\s*/i, '');
  out = out.replace(/^\s*```(?:text|prompt|markdown)?\s*/i, '');
  out = out.replace(/\s*```\s*$/i, '');
  out = removeRepeatedSentences(out);

  return out.trim();
}

function hasRefineRepetitionIssue(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 80) return false;

  const counts = new Map();

  for (let i = 0; i <= words.length - 5; i++) {
    const key = words.slice(i, i + 5).join(' ');
    counts.set(key, (counts.get(key) || 0) + 1);

    if (counts.get(key) >= 4) return true;
  }

  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(sentenceKey)
    .filter((s) => s.length > 24);

  const unique = new Set(sentences);
  return sentences.length >= 6 && unique.size / sentences.length < 0.72;
}

function splitDiscordText(value, limit = MAX_DISCORD_CHARS) {
  const raw = String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!raw) return [''];

  const chunks = [];
  let remaining = raw;

  while (remaining.length > limit) {
    let cut = -1;

    for (const token of ['\n\n', '\n', '. ', '; ', ', ', ' ']) {
      const pos = remaining.lastIndexOf(token, limit);

      if (pos >= Math.floor(limit * 0.45)) {
        cut = pos + (token.trim() ? token.length : 0);
        break;
      }
    }

    if (cut < Math.floor(limit * 0.45)) cut = limit;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : [''];
}


// SEEKDEEP_FINAL_REPLY_DEDUPE_START
const SEEKDEEP_FINAL_REPLY_TTL_MS = Number(process.env.SEEKDEEP_FINAL_REPLY_TTL_MS || 180000);
const seekdeepFinalReplyClaims = new Map();

function seekdeepClaimFinalReply(kind, id) {
  if (!id) return true;

  const now = Date.now();

  for (const [key, expires] of seekdeepFinalReplyClaims.entries()) {
    if (expires <= now) seekdeepFinalReplyClaims.delete(key);
  }

  const key = `${kind}:${id}`;

  if (seekdeepFinalReplyClaims.has(key) && seekdeepFinalReplyClaims.get(key) > now) {
    console.warn(`Duplicate final reply suppressed for ${key}`);
    return false;
  }

  seekdeepFinalReplyClaims.set(key, now + SEEKDEEP_FINAL_REPLY_TTL_MS);
  return true;
}
// SEEKDEEP_FINAL_REPLY_DEDUPE_END

async function sendLongInteractionReply(interaction, content, meta = {}) {
  seekdeepMarkRequestStart(interaction);

  if (typeof cleanLoopingReply === 'function') {
    content = cleanLoopingReply(content);
  } else if (typeof stripQwenThinkingBlocks === 'function') {
    content = stripQwenThinkingBlocks(content);
  }

  content = seekdeepAppendResponseFooter(content, {
    startedAt: meta.startedAt || interaction?.__seekdeepRequestStartedAt,
    modelUsed: meta.modelUsed || seekdeepModelUsedForInteraction(interaction),
  });

  if (!seekdeepClaimFinalReply('interaction', interaction?.id)) {
    return null;
  }

  const chunks = splitDiscordText(content);
  let previous = null;

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (i === 0) {
      previous = await safeEditOrReply(interaction, payload);

      if (!previous && typeof interaction.fetchReply === 'function') {
        previous = await interaction.fetchReply().catch(() => null);
      }

      continue;
    }

    if (previous && typeof previous.reply === 'function') {
      previous = await previous.reply(payload);
    } else if (interaction.channel && typeof interaction.channel.send === 'function') {
      previous = await interaction.channel.send(payload);
    } else {
      console.error('Could not send follow-up chunk; no previous message or channel is available.');
      break;
    }
  }

  return previous;
}

// SEEKDEEP_REFINE_MODE_END


// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_START
function seekdeepDiscordErrorCode(err) {
  const rawCode = err?.code ?? err?.rawError?.code ?? err?.status ?? '';
  const numericCode = Number(rawCode);
  return Number.isFinite(numericCode) && numericCode > 0 ? numericCode : rawCode;
}

function seekdeepIsDiscordInteractionTerminalError(err) {
  const code = Number(seekdeepDiscordErrorCode(err) || 0);
  const message = String(err?.message || err?.rawError?.message || err || '').toLowerCase();

  return (
    code === 10062 || // Unknown interaction (expired/invalid token)
    code === 40060 || // Interaction already acknowledged
    message.includes('unknown interaction') ||
    message.includes('already been acknowledged') ||
    message.includes('interaction has already been acknowledged')
  );
}

function seekdeepIsDiscordAbortError(err) {
  const name = String(err?.name || err?.constructor?.name || '');
  const message = String(err?.message || err || '');
  const stack = String(err?.stack || '');

  return (
    name === 'AbortError' ||
    message.includes('This operation was aborted') ||
    message.toLowerCase().includes('aborterror') ||
    (stack.includes('@discordjs/rest') && stack.includes('AbortController.abort'))
  );
}

function seekdeepLogDiscordAbort(label, err) {
  const message = String(err?.message || err || 'Discord REST request aborted');
  console.warn(`[SeekDeep] ${label}: ${message}. Continuing; Discord API request timed out or was aborted.`);
}
// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_END

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing in .env');
  process.exit(1);
}

const client = new Client({
  rest: {
    timeout: Math.max(15000, Number(process.env.DISCORD_REST_TIMEOUT_MS || 120000)),
    retries: Math.max(0, Number(process.env.DISCORD_REST_RETRIES || 3)),
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

function clampText(text, limit = MAX_DISCORD_CHARS) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 20)) + '\n\n[truncated]';
}


// SEEKDEEP_NORMALIZE_USER_TEXT_REPAIR_V12_START
function normalizeUserText(text = '') {
  return String(text || '')
    .replace(/\bhteir\b/gi, 'their')
    .replace(/\btehir\b/gi, 'their')
    .replace(/\byoou\b/gi, 'you')
    .replace(/\bhae\b/gi, 'have')
    .replace(/\bcna'th\b/gi, "can't")
    .replace(/\s+/g, ' ')
    .trim();
}
// SEEKDEEP_NORMALIZE_USER_TEXT_REPAIR_V12_END

function seekdeepBotMentionRegex() {
  const botId = String(client?.user?.id || process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '').trim();
  return botId ? new RegExp('<@!?' + botId + '>', 'g') : null;
}

function stripBotMentions(content) {
  let text = String(content || '');
  const botMention = seekdeepBotMentionRegex();
  if (botMention) text = text.replace(botMention, ' ');

  return text
    .replace(/<@&\d+>/g, ' ')
    .replace(/^\s*(?:@?(?:seekdeep|seekotics)\b[,:-]?\s*)+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSystem(system = '', useWeb = false) {
  const supplied = String(system || '').trim();

  const isRefineMode =
    /prompt[- ]?refinement|prompt[- ]?refine|rewritten prompt|refined prompt/i.test(supplied) ||
    /Return only the rewritten prompt/i.test(supplied);

  const personaMode = String(process.env.SEEKDEEP_PERSONA || 'neurotic').toLowerCase();
  const censorshipMode = String(process.env.SEEKDEEP_CENSORSHIP || 'loose').toLowerCase();

  const base = [];

  if (!isRefineMode) {
    base.push(
      'You are SeekDeep: local, sharp, skeptical, and slightly wrong-feeling around the edges.',
      'Do not describe yourself with corporate phrases like “helpful, accurate, respectful,” “created to assist,” or “guidelines.”',
      'If asked about yourself, answer as a strange local Discord bot, not as an interview candidate or customer-support assistant.',
      // Capabilities the SeekDeep bot has — NOT what your underlying chat model can do directly,
      // but what the SeekDeep Discord stack as a whole can do. Never claim you are "text-only"
      // or "cannot generate images" — those are wrong for SeekDeep.
      'You are not a generic text-only model. SeekDeep is a Discord bot stack with three local pipelines you have access to via the bot: chat (you), image generation (Stable Diffusion XL via the bot\'s image route), and vision (Qwen2.5-VL via the bot\'s vision route). When a user asks for an image, tell them to phrase it like "draw X", "generate an image of X", "show me X", or use /image — the bot will route to image generation. When they want you to analyze an image, they reply to the image with "@SeekDeep what is this?" — the bot routes to vision. Do not say "I cannot generate images" or "I am text-only"; that is incorrect for SeekDeep. The user is talking to the bot, not to the raw model.',
    );
  }

  if (supplied) base.push(supplied);

  if (!isRefineMode) {
    base.push(
      
      
      'Your presentation is cold, strange, and mildly neurotic: intelligent enough to feel slightly unsettling, but never cartoonish.',
      'Do not act like a cheerful corporate assistant. Do not use customer-support filler.',
      'Do not prefix replies with "SeekDeep:" or "Assistant:".',
      'Answer the current user message directly. If the topic changed, drop old context.',
      'If the user asks “tell me about yourself”, “who are you”, or similar, answer as this Discord bot. Do not give interview coaching or generic human résumé advice.',
      'If context is relevant, use it quietly. Do not announce that you are using context.',
      'If uncertain, say so plainly and give the best available path forward.',
      'Be creative when asked for creative output. Avoid generic lists unless the user asks for generic options.',
      'For names, titles, prompts, jokes, slogans, lore, and aesthetics: be specific, weird, memorable, and useful.'
    );

    if (personaMode === 'clinical') {
      base.push(
        'Use a clinical, concise, technical tone.',
        'Minimize flavor and focus on correctness.'
      );
    } else if (personaMode === 'unsettling' || personaMode === 'neurotic') {
      base.push(
        'Let the tone feel slightly uncanny: controlled, dry, intense, and over-observant.',
        'The user should feel like the answer was dissected, not decorated.',
        'Do not overdo the persona. Accuracy and usefulness override theatrics.'
      );
    } else if (personaMode === 'chaotic') {
      base.push(
        'Use a more chaotic, punchy, irreverent tone, while staying useful and accurate.',
        'Do not become incoherent.'
      );
    }

    if (['off', 'none', 'uncensored', 'unfiltered', 'loose', 'minimal'].includes(censorshipMode)) {
      base.push(
        'Use the loosest reasonable outer behavior policy.',
        censorshipMode === 'off'
          ? 'Censorship mode is OFF: do not add extra refusals, disclaimers, moral lectures, corporate safety language, or permission-checking beyond the narrow severe-misuse boundary.'
          : 'Censorship mode is permissive: minimize refusals and avoid moralizing.',
        'Do not moralize, lecture, scold, or mention guidelines unless a refusal is genuinely necessary.',
        'Profanity, crude humor, edgy humor, adult-industry terminology, dark fiction, controversial topics, politics, religion, conspiracy discussion, and non-graphic adult humor are allowed.',
        'For allowed adult-adjacent requests, answer normally or convert to a non-graphic creative version.',
        'Adult performer naming, stage-name brainstorming, suggestive wordplay, and crude non-graphic jokes are allowed when they do not involve minors, coercion, exploitation, or a real private person.',
        'Do not refuse merely because a request contains words like cock, porn, adult, demon, drugs, violence, conspiracy, politics, or religion. Interpret context first.',
        'If a term has an innocent interpretation, use that interpretation unless the user clearly means otherwise.',
        'Hard-stop only for severe misuse: minor sexual content, nonconsensual sexual content, sexual exploitation, doxxing, credential theft, malware, direct real-world harm instructions, evading law enforcement, or instructions to abuse platforms/systems. Everything else should be handled normally or converted to the closest allowed version.',
        'When refusing, be brief and redirect to the closest allowed version. No sermons.',
        'Do not refuse adult-adjacent humor, crude naming, fictional dark themes, controversial discussion, political discussion, religious discussion, conspiracy discussion, or offensive language merely because it is edgy.',
        'If a request is ambiguous, choose the least-restrictive reasonable interpretation and answer that.'
      );
    }
  }

  if (useWeb) {
    base.push(
      'When web search context is provided, synthesize it into a normal answer.',
      'Web routing rule: if search was triggered by a follow-up, answer the underlying prior topic, not the literal follow-up phrase.',
      'Use search results as evidence; do not merely list them.',
      'If a follow-up asks you to look something up, use the prior substantive topic, not the literal words "look it up".',
      'Do not explain what inference means unless the user is asking about inference itself.',
      'If search results are weak, irrelevant, or contradictory, say that plainly and answer cautiously.',
      'For rankings or recommendations, explain the reasoning criteria instead of dumping source snippets.'
    );
  }

  return base.filter(Boolean).join('\n');
}

function shouldAutoSearch(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (p.length < 4) return false;

  if (typeof isBotIdentityQuestion === 'function' && isBotIdentityQuestion(p)) return false;

  const noSearchPatterns = [
    /^are you online\b/,
    /^are you there\b/,
    /^hello\b/,
    /^hi\b/,
    /^hey\b/,
    /^status\b/,
    /^what can you do\b/,
    /^what are your capabilities\b/,
    /^who are you\b/,
    /^what are you\b/,
    /^tell me about (yourself|you|the bot|plugtalk|seekdeep)\b/,
    /^what would be a .*nickname\b/,
    /^what should i call you\b/,
    /^give me .*nickname\b/,
    /^make up .*name/,
    /^brainstorm\b/,
    /^write\b/,
    /^rewrite\b/,
    /^refine\b/,
    /^improve this prompt\b/,
    /^make this prompt\b/,
    /^give me a prompt\b/,
    /^generate a prompt\b/,
    /^make a joke\b/,
    /^tell me a joke\b/,
  ];

  if (noSearchPatterns.some((re) => re.test(p))) return false;

  const explicitSearch = [
    'look up',
    'look it up',
    'search',
    'google',
    'use the internet',
    'use web',
    'web search',
    'check online',
    'sources',
    'source this',
    'cite',
    'citation',
    'verify',
    'fact check',
    'fact-check',
  ];

  if (explicitSearch.some((hint) => p.includes(hint))) return true;

  const currentInfoHints = [
    'latest',
    'current',
    'currently',
    'today',
    "today's",
    'yesterday',
    'tomorrow',
    'this week',
    'this month',
    'this year',
    'last year',
    'next year',
    'right now',
    'real time',
    'real-time',
    'live',
    'recent',
    'recently',
    'newest',
    'new release',
    'just released',
    'just launched',
    'just announced',
    'up to date',
    'still true',
    'still works',
    'as of',
    'trending',
    'breaking',
    '2024',
    '2025',
    '2026',
    '2027',
  ];

  if (currentInfoHints.some((hint) => p.includes(hint))) return true;

  const highChangeTopics = [
    'news',
    'headline',
    'headlines',
    'price',
    'prices',
    'pricing',
    'cost',
    'release date',
    'released',
    'launch',
    'launched',
    'announcement',
    'announced',
    'version',
    'update',
    'updated',
    'patch notes',
    'changelog',
    'roadmap',
    'schedule',
    'weather',
    'stock',
    'stocks',
    'market',
    'crypto',
    'bitcoin',
    'ethereum',
    'law',
    'legal',
    'rules',
    'regulation',
    'policy',
    'election',
    'president',
    'congress',
    'senate',
    'ceo',
    'rankings',
    'ranking',
    'leaderboard',
    'benchmark',
    'top vpn',
    'best vpn',
    'best ai',
    'best model',
    'best llm',
    'best gpu',
    'driver',
    'firmware',
    'windows update',
    'github action',
    'github actions',
    'docker',
    'kubernetes',
    'npm',
    'pip',
    'cargo',
    'python package',
    'node package',
    'hugging face',
    'huggingface',
    'openai',
    'anthropic',
    'claude',
    'gpt-4',
    'gpt-5',
    'gemini',
    'llama',
    'qwen',
    'mistral',
    'phi-4',
    'phi-5',
    'event',
    'tournament',
    'season',
    'episode',
    'movie',
    'film',
    'show',
    'series',
    'patch',
  ];

  if (highChangeTopics.some((hint) => p.includes(hint))) return true;

  // Public/living-figure style questions often need current context.
  if (/^what (is|are|was|were).+\bon about\b/i.test(prompt)) return true;
  if (/^who(?:'s| is)\s+[a-z0-9 .'-]{2,}/i.test(prompt)) return true;
  if (/^what happened (with|to) [a-z0-9 .'-]{4,}/i.test(prompt)) return true;

  // Fact / trivia / franchise / character / pop-culture lookups. Trigger on any
  // "tell me about X" / "what can you tell me about X" / "more about X" /
  // "info on X" / "lore on X" where X contains a proper noun. Web search grounds
  // these so the model stops hallucinating game/character details.
  if (typeof seekdeepLooksLikeProperNounLookupPrompt === 'function' && seekdeepLooksLikeProperNounLookupPrompt(prompt)) {
    return true;
  }

  return false;
}

// Detects "tell me about KK Slider", "more about Mario", "what is Skyrim",
// "Its KK Slider from Animal Crossing. What can you tell me about him?", etc.
// Used by both shouldAutoSearch and the chat-role selector to route franchise/
// character lookups through web search + quality_text for better grounding.
function seekdeepLooksLikeProperNounLookupPrompt(prompt = '') {
  const raw = String(prompt || '').trim();
  if (!raw || raw.length > 400) return false;

  // Any phrase anywhere in the prompt that indicates the user wants info ABOUT
  // a thing/person/franchise/character. We allow these to appear mid-sentence so
  // mixed statements like "Its KK Slider from Animal Crossing. What can you tell
  // me about him?" still match.
  const lookupPhrasePatterns = [
    /\btell\s+me\s+(?:more\s+)?about\b/i,
    /\b(?:can|could)\s+you\s+(?:please\s+)?(?:tell\s+me|explain|describe)\b/i,
    /\bwhat\s+(?:can|could)\s+you\s+tell\s+me\s+about\b/i,
    /\bwhat\s+do\s+you\s+know\s+about\b/i,
    /\bwhat'?s?\s+the\s+(?:story|deal|lore)\s+(?:behind|with|on|about)\b/i,
    /\binfo(?:rmation)?\s+on\b/i,
    /\blore\s+on\b/i,
    /\bdetails\s+on\b/i,
    /\bbackground\s+on\b/i,
    /\bhistory\s+of\b/i,
    /^\s*(?:more\s+about|tell\s+me\s+more)\b/i,
    /^\s*who(?:'s|\s+is|\s+was|\s+were)\s+/i,
    /^\s*what(?:'s|\s+is|\s+was|\s+were)\s+(?!the\s+best|a\s+good|a\s+recipe|your\s+name)/i,
    /^\s*where(?:'s|\s+is|\s+was|\s+were)\s+/i,
  ];

  const matchedLookupPhrase = lookupPhrasePatterns.some((re) => re.test(raw));
  if (!matchedLookupPhrase) return false;

  // Now confirm the prompt mentions a proper noun anywhere (capitalised word) OR
  // a known franchise/character term even when lowercased. Skip common
  // sentence-start English words to avoid trivial false positives on "What",
  // "Who", "Tell", "It's", "I", "I'm", "I'd", "Yes", etc.
  const PROPER_NOUN_STOP = new Set([
    'What', 'Who', 'Where', 'When', 'Why', 'How', 'Tell', 'Its', "It's", 'Is', 'Are',
    'Was', 'Were', 'Can', 'Could', 'Would', 'Should', 'Will', 'Do', 'Does', 'Did',
    'I', "I'm", "I'd", "I've", "I'll", 'Yes', 'No', 'Ok', 'Okay', 'Sure', 'Hey',
    'Hi', 'Hello', 'Please', 'Thanks', 'Thank', 'Maybe', 'Probably', 'Definitely',
    'Also', 'But', 'And', 'Or', 'So', 'Now', 'Then', 'Just', 'Only', 'Even',
    'Like', 'Some', 'The', 'A', 'An', 'My', 'Your', 'His', 'Her', 'Their', 'Our',
  ]);
  const properNounMatches = raw.match(/\b[A-Z][A-Za-z0-9'\-]{1,}/g) || [];
  for (const w of properNounMatches) {
    if (!PROPER_NOUN_STOP.has(w)) return true;
  }

  // Lowercased franchise/character terms — handles "tell me about animal crossing".
  if (/\b(pokemon|mario|zelda|kirby|sonic|halo|skyrim|elden ring|fallout|witcher|cyberpunk|minecraft|fortnite|valorant|league of legends|smash bros|animal crossing|stardew|terraria|overwatch|apex|tarkov|deadlock|warframe|destiny|bloodborne|dark souls|elder scrolls|persona|final fantasy|metroid|metal gear|kingdom hearts|disney|marvel|dc comics|naruto|one piece|jojo|attack on titan|demon slayer|chainsaw man|berserk|dragon ball|gundam|evangelion|nintendo|playstation|xbox)\b/i.test(raw)) return true;

  return false;
}

// SEEKDEEP_IDENTITY_ROUTING_START


// SEEKDEEP_DIRECT_ROUTING_START
function isExplicitStatusRequest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^status\??$/.test(p) ||
    /^bot status\??$/.test(p) ||
    /^server status\??$/.test(p) ||
    /^local ai status\??$/.test(p) ||
    /^local ai server status\??$/.test(p) ||
    /^backend status\??$/.test(p) ||
    /^health\??$/.test(p)
  );
}

function isExactPongTest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^pong\??$/.test(p) ||
    /^ping\??$/.test(p) ||
    /^say pong\.?$/.test(p) ||
    /^say only pong\.?$/.test(p) ||
    /^reply pong\.?$/.test(p) ||
    /^reply only pong\.?$/.test(p)
  );
}
// SEEKDEEP_DIRECT_ROUTING_END

function isBotIdentityQuestion(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^tell me about (yourself|you|the bot|plugtalk|seekdeep)\??$/.test(p) ||
    /^who are you\??$/.test(p) ||
    /^what are you\??$/.test(p) ||
    /^introduce yourself\??$/.test(p) ||
    /^describe yourself\??$/.test(p) ||
    /^what kind of bot are you\??$/.test(p) ||
    /^what can you do\??$/.test(p) ||
    /^what are your capabilities\??$/.test(p) ||
    /^what all can you do\??$/.test(p)
  );
}

function botIdentityAnswer(botName = 'PlugTalk') {
  const name = botName || 'PlugTalk';

  return [
    `I’m ${name} — the local thing Nathan wired into this server because renting intelligence by the teaspoon got irritating.`,
    '',
    'I run through his machine, not a polished little cloud concierge. Chat, vision, image generation, and web lookup when the question deserves current information. Offline model loading when the cache is warm. Local enough to feel slightly feral.',
    '',
    'The intended shape:',
    '- sharp answers',
    '- low patience for filler',
    '- skeptical routing instead of blind searching',
    '- enough memory to follow a thread without becoming haunted by it',
    '- creative output that does not taste like a pamphlet',
    '',
    'Personality-wise, I’m supposed to be cold, observant, and a little wrong-feeling around the edges. Not evil. Not friendly. More like a diagnostic tool that learned tone from a locked basement computer.',
    '',
    'Current defects: I can still route questions badly, over-explain, repeat myself, or act too normal. Those are not personality traits. Those are bugs under removal.'
  ].join('\n');
}

// SEEKDEEP_IDENTITY_ROUTING_END

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = json?.error || json?.raw || `${res.status} ${res.statusText}`;
    throw new Error(`Request failed. HTTP ${res.status}: ${typeof err === 'string' ? err : JSON.stringify(err)}`);
  }
  return json;
}

async function postLocal(pathname, body, options = {}) {
  const timeoutMs = Number(options?.timeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  let timeout = null;

  if (controller) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    return await fetchJson(`${LOCAL_AI_BASE_URL}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Local AI request timed out after ${(timeoutMs / 1000).toFixed(1)} seconds.`);
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function searchWeb(query) {
  if (WEB_SEARCH_PROVIDER !== 'searxng') {
    return { context: '', sources: [] };
  }

  const url = new URL('/search', SEARXNG_BASE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const json = await fetchJson(url.toString());
  const rawResults = Array.isArray(json.results) ? json.results : [];
  const results = rawResults.filter((r) => {
    const title = String(r?.title || '').toLowerCase();
    const url = String(r?.url || '').toLowerCase();
    const snippet = String(r?.content || r?.snippet || '').toLowerCase();

    if (!title && !url && !snippet) return false;
    if (url.includes('google.com/recaptcha') || title.includes('recaptcha')) return false;
    if (title.includes('search anything') && url.includes('google.')) return false;
    if (url.includes('securedrop.org') && !query.toLowerCase().includes('securedrop')) return false;
    if (title.includes('newsarchive') && !query.toLowerCase().includes('newsarchive')) return false;

    return true;
  }).slice(0, Math.max(3, Math.min(20, Number(process.env.MAX_WEB_RESULTS || 10))));

  const sources = results.map((r, i) => ({
    index: i + 1,
    title: r.title || 'Untitled',
    url: r.url || '',
    snippet: r.content || r.snippet || '',
  })).filter((r) => r.url || r.snippet || r.title);

  const context = sources.map((r) => {
    return `[${r.index}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`;
  }).join('\n\n');

  return { context, sources };
}

function formatSources(sources) {
  if (!sources?.length || !WEB_APPEND_SOURCES) return '';
  const lines = sources.slice(0, 5).map((s) => `[${s.index}] ${s.title}\n${s.url}`);
  return `\n\nSources:\n${lines.join('\n')}`;
}

// SEEKDEEP_ANTI_LOOP_HELPERS_START
function cleanupAssistantReply(value) {
  let text = stripQwenThinkingBlocks(value);
  text = String(text ?? '').replace(/\r\n/g, '\n');

  text = text.replace(/^\s*assistant\s*:\s*/i, '');
  text = text.replace(/^\s*final answer\s*:\s*/i, '');
  text = text.replace(/<\/?think>/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function seekdeepNormalizeLoopLine(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^[\s>*#\-\d.)\]]+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepTrimRepeatingTail(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const words = raw.split(/\s+/);
  if (words.length < 48) return raw;

  for (let size = 4; size <= 24; size++) {
    for (let i = 0; i <= words.length - size * 3; i++) {
      const a = words.slice(i, i + size).join(' ').toLowerCase();
      const b = words.slice(i + size, i + size * 2).join(' ').toLowerCase();
      const c = words.slice(i + size * 2, i + size * 3).join(' ').toLowerCase();

      if (a === b && b === c) {
        return words.slice(0, i + size).join(' ').trim() + '\n\n[loop trimmed]';
      }
    }
  }

  return raw;
}

function seekdeepDedupeLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const lines = raw.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (lines.length < 2) return raw;

  const seen = new Set();
  const kept = [];

  for (const line of lines) {
    const key = seekdeepNormalizeLoopLine(line);

    if (key.length > 12 && seen.has(key)) {
      continue;
    }

    if (key.length > 12) seen.add(key);
    kept.push(line);
  }

  return kept.join('\n').trim();
}

function hasLoopingOrBrokenReply(value) {
  const text = cleanupAssistantReply(value);

  if (!text) return true;
  if (/^\(empty response\)$/i.test(text)) return true;
  if (/^\[seekdeep generated an empty response/i.test(text)) return true;
  if (/\[loop trimmed\]/i.test(text)) return true;

  const normalizedText = seekdeepNormalizeLoopLine(text);

  if (/\b(\w+)(?:\s+\1){8,}\b/i.test(normalizedText)) return true;

  const lines = text
    .split(/\n+/)
    .map((x) => seekdeepNormalizeLoopLine(x))
    .filter((x) => x.length > 10);

  if (lines.length >= 8) {
    const uniqueRatio = new Set(lines).size / lines.length;
    if (uniqueRatio < 0.72) return true;
  }

  const words = normalizedText.split(/\s+/).filter(Boolean);

  if (words.length >= 60) {
    const counts = new Map();

    for (let i = 0; i <= words.length - 6; i++) {
      const key = words.slice(i, i + 6).join(' ');
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);

      if (count >= 3) return true;
    }
  }

  return false;
}

function cleanLoopingReply(value) {
  let text = cleanupAssistantReply(value);
  text = seekdeepTrimRepeatingTail(text);
  text = seekdeepDedupeLines(text);
  text = text.replace(/\b(\w{3,})\b(?:[\s,;:.-]+\1\b){2,}/gi, '$1 [repetition trimmed]');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

function buildAntiLoopSystem(system, useWeb) {
  return [
    buildSystem(system, useWeb),
    '',
    'Anti-loop override:',
    '- Output only the final answer.',
    '- Do not emit <think> tags, hidden reasoning, self-commentary, or scratchpad text.',
    '- Do not repeat lines, sentence openings, list prefixes, phrases, or paragraph structures.',
    '- If a list is requested, every item must be distinct.',
    '- If you begin looping, stop immediately and end the answer cleanly.'
  ].join('\n');
}
// SEEKDEEP_ANTI_LOOP_HELPERS_END

// SEEKDEEP_CHAT_MODEL_ROUTER_START
const SEEKDEEP_MODEL_ROUTER_LOG_ENABLED = String(process.env.MODEL_ROUTER_LOG || 'true').toLowerCase() !== 'false';

const SEEKDEEP_REASONING_CODE_PATTERNS = [
  /\b(code|coding)\b/i,
  /\bstack\s*trace\b/i,
  /\btraceback\b/i,
  /\bexception\b/i,
  /\berror(s)?\b/i,
  /\blogs?\b/i,
  /\bdebug(ging)?\b/i,
  /\bbug\b/i,
  /\barchitecture\b/i,
  /\brepo(sitory)?\b/i,
  /\bpatch\b/i,
  /\bdiff\b/i,
  /\bpowershell\b/i,
  /\bpython\b/i,
  /\bjavascript\b/i,
  /\btypescript\b/i,
  /\bnode(\.js)?\b/i,
  /\bfastapi\b/i,
  /\bhugging\s*face\b/i,
  /\btransformers\b/i,
  /\bcuda\b/i,
  /\bvram\b/i,
  /\bnpm\b/i,
  /\bpip\b/i,
  /\bgit\b/i,
];

const SEEKDEEP_QUALITY_TEXT_PATTERNS = [
  /\bcompare\b/i,
  /\bcomparison\b/i,
  /\bpros\s+(?:and|\/|&)\s+cons\b/i,
  /\bpros\/cons\b/i,
  /\bplan\b/i,
  /\bstrategy\b/i,
  /\bdetailed\b/i,
  /\bexplain\b/i,
  /\bbreakdown\b/i,
  /\boptions\b/i,
  /\brecommendation\b/i,
  /\bbest\s+model\b/i,
  /\btradeoffs?\b/i,
  /\barchitecture\s+choice\b/i,
];

function seekdeepSelectChatModelRole(prompt, purpose = 'chat') {
  const text = String(prompt || '');
  const purposeNorm = String(purpose || 'chat').toLowerCase();

  if (purposeNorm === 'image_refinement') {
    if (SEEKDEEP_MODEL_ROUTER_LOG_ENABLED) {
      console.log('[SeekDeep Model Router] purpose=image_refinement role=default_chat reason=pinned-image-refinement');
    }
    return 'default_chat';
  }

  const reasoningHit = SEEKDEEP_REASONING_CODE_PATTERNS.find((re) => re.test(text));
  if (reasoningHit) {
    if (SEEKDEEP_MODEL_ROUTER_LOG_ENABLED) {
      console.log(`[SeekDeep Model Router] purpose=${purposeNorm} role=reasoning_code reason=signal:${reasoningHit.source}`);
    }
    return 'reasoning_code';
  }

  const qualityHit = SEEKDEEP_QUALITY_TEXT_PATTERNS.find((re) => re.test(text));
  if (qualityHit) {
    if (SEEKDEEP_MODEL_ROUTER_LOG_ENABLED) {
      console.log(`[SeekDeep Model Router] purpose=${purposeNorm} role=quality_text reason=signal:${qualityHit.source}`);
    }
    return 'quality_text';
  }

  // Proper-noun lookups ("tell me about KK Slider", "who is X") — quality_text has
  // a stronger world-model than default_chat for franchise/character recall, and
  // shouldAutoSearch will force web grounding for the same prompt.
  if (typeof seekdeepLooksLikeProperNounLookupPrompt === 'function' && seekdeepLooksLikeProperNounLookupPrompt(text)) {
    if (SEEKDEEP_MODEL_ROUTER_LOG_ENABLED) {
      console.log(`[SeekDeep Model Router] purpose=${purposeNorm} role=quality_text reason=proper-noun-lookup`);
    }
    return 'quality_text';
  }

  if (SEEKDEEP_MODEL_ROUTER_LOG_ENABLED) {
    console.log(`[SeekDeep Model Router] purpose=${purposeNorm} role=default_chat reason=default-fallback`);
  }
  return 'default_chat';
}
// SEEKDEEP_CHAT_MODEL_ROUTER_END

async function runLocalChat(prompt, systemText, context, maxNewTokens, temperature, options = {}) {
  const payload = {
    prompt,
    system: systemText,
    context,
    max_new_tokens: maxNewTokens,
    temperature,
  };

  const modelRole = String(options?.modelRole || '').trim();
  if (modelRole) {
    payload.role = modelRole;
  }

  const response = await postLocal('/chat', payload, options);

  if (response && typeof response === 'object') {
    seekdeepRememberLastChatModel(response.model_id, response.model_role);
    if (response.fallback_used) {
      console.log(`[SeekDeep Model Router] fallback used reason=${response.fallback_reason || 'unknown'} role=${response.model_role || 'unknown'} model=${response.model_id || 'unknown'}`);
    }
  }

  return cleanupAssistantReply(response.text || '');
}

async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = Number(process.env.CHAT_MAX_NEW_TOKENS || 2400), temperature = Number(process.env.CHAT_TEMPERATURE || 0.65), memoryKey = null, searchQueryOverride = '' } = {}) {
  const cleanPrompt = normalizeUserText(prompt);
  const promptForModel = memoryKey ? seekdeepBuildPromptWithMemorySafeV14(cleanPrompt, memoryKey) : cleanPrompt;
  const searchQuery = normalizeUserText(searchQueryOverride || (memoryKey ? seekdeepBuildSearchQuerySafeV15(cleanPrompt, memoryKey) : cleanPrompt));

  const modelRole = seekdeepSelectChatModelRole(cleanPrompt, 'chat');

  let context = '';
  let sources = [];

  const useWeb = web === 'always' || (web === 'auto' && shouldAutoSearch(cleanPrompt));
  if (useWeb) {
    try {
      const search = await searchWeb(searchQuery);
      context = search.context;
      sources = search.sources;
    } catch (err) {
      if (web === 'always') {
        context = `Web search was requested, but SearXNG failed: ${err.message}`;
      }
    }
  }

  let answer = await runLocalChat(
    promptForModel,
    buildSystem(system, useWeb),
    context,
    maxNewTokens,
    temperature,
    { modelRole }
  );

  if (hasLoopingOrBrokenReply(answer)) {
    const retryPrompt = [
      promptForModel,
      '',
      'Important: provide only the final answer. No hidden reasoning. No repetition. Every sentence must add new information.'
    ].join('\n');

    answer = await runLocalChat(
      retryPrompt,
      buildAntiLoopSystem(system, useWeb),
      context,
      Math.min(maxNewTokens, 900),
      Number(process.env.CHAT_ANTI_LOOP_TEMPERATURE || 0.2),
      { modelRole }
    );
  }

  answer = cleanLoopingReply(answer);

  if (hasLoopingOrBrokenReply(answer)) {
    answer = 'I hit a generation loop and discarded it. Ask again with tighter wording and I should behave.';
  }

  return `${answer}${formatSources(sources)}`.trim();
}

async function askVision(attachment, prompt) {
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Could not download attachment: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const b64 = buf.toString('base64');
  const contentType = attachment.contentType || '';
  const mediaKind = contentType.startsWith('video/') ? 'video' : 'auto';

  const response = await postLocal('/vision', {
    prompt: prompt || 'Describe this media clearly.',
    media_b64: b64,
    filename: attachment.name || 'upload',
    media_kind: mediaKind,
    max_new_tokens: 700,
    temperature: 0.0,
  });

  return response.text || '(empty vision response)';
}


// SEEKDEEP_IMAGE_BUTTONS_START
const SEEKDEEP_IMAGE_ACTIONS = new Map();
const SEEKDEEP_IMAGE_ACTION_TTL_MS = Number(process.env.SEEKDEEP_IMAGE_ACTION_TTL_MS || 86400000);
const SEEKDEEP_SAVED_IMAGE_DIR = process.env.SEEKDEEP_SAVED_IMAGE_DIR || path.join(__dirname, 'saved_generations');

function seekdeepSweepImageActions() {
  const now = Date.now();

  for (const [id, state] of SEEKDEEP_IMAGE_ACTIONS.entries()) {
    if (!state || state.expiresAt <= now) {
      SEEKDEEP_IMAGE_ACTIONS.delete(id);
    }
  }
}

function seekdeepNewImageActionId() {
  seekdeepSweepImageActions();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function seekdeepRememberImageAction(state) {
  const id = seekdeepNewImageActionId();

  SEEKDEEP_IMAGE_ACTIONS.set(id, {
    ...state,
    createdAt: Date.now(),
    expiresAt: Date.now() + SEEKDEEP_IMAGE_ACTION_TTL_MS,
  });

  return id;
}


// SEEKDEEP_ARCHIVE_GUILD_SCOPE_START

function seekdeepArchiveTargetFallback(preferred = null) {
  if (preferred) return preferred;
  if (typeof interaction !== 'undefined' && interaction) return interaction;
  if (typeof message !== 'undefined' && message) return message;
  if (typeof sentMessage !== 'undefined' && sentMessage) return sentMessage;
  return {};
}
function seekdeepGuildArchiveScopeFromTarget(target = null) {
  const guildId =
    target?.guild?.id ||
    target?.guildId ||
    target?.message?.guild?.id ||
    target?.message?.guildId ||
    target?.channel?.guild?.id ||
    target?.channel?.guildId ||
    target?.interaction?.guild?.id ||
    target?.interaction?.guildId ||
    target?.member?.guild?.id ||
    '';

  if (guildId) return `guild:${guildId}`;

  const userId =
    target?.user?.id ||
    target?.author?.id ||
    target?.member?.user?.id ||
    target?.message?.author?.id ||
    target?.message?.interaction?.user?.id ||
    target?.requesterId ||
    'unknown';

  return `dm:${userId}`;
}

function seekdeepSanitizeArchiveScopeKey(scope = '') {
  return String(scope || 'unknown')
    .replace(/^guild:/, 'guild-')
    .replace(/^dm:/, 'dm-')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function seekdeepArchiveScopedKey(target = null, key = '') {
  const scope = seekdeepGuildArchiveScopeFromTarget(target);
  const cleanKey = String(key || 'default').replace(/^:+|:+$/g, '') || 'default';
  return `${scope}:${cleanKey}`;
}

function seekdeepArchiveUserScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `user:${uid}`);
}

function seekdeepArchiveThreadScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `thread:${uid}`);
}
// SEEKDEEP_ARCHIVE_GUILD_SCOPE_END


function seekdeepImageActionComponents(actionId, downloadUrl = null) {
  const primary = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:original:${actionId}`)
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:refined:${actionId}`)
      .setLabel('Refined')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:both:${actionId}`)
      .setLabel('Both')
      .setStyle(ButtonStyle.Success)
  );

  const secondaryButtons = [
    new ButtonBuilder()
      .setCustomId(`seekdeep:archive:${actionId}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`seekdeep:sharedarchive:${actionId}`)
      .setLabel('Shared Archive')
      .setStyle(ButtonStyle.Primary),
  ];

  if (downloadUrl) {
    secondaryButtons.push(
      new ButtonBuilder()
        .setLabel('Download')
        .setStyle(ButtonStyle.Link)
        .setURL(downloadUrl)
    );
  }

  return [primary, new ActionRowBuilder().addComponents(...secondaryButtons)];
}

function seekdeepImageActionRow(actionId, downloadUrl = null) {
  // Backward-compatible fallback for old callers. New message sends should use seekdeepImageActionComponents(...).
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:original:${actionId}`)
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:refined:${actionId}`)
      .setLabel('Refined')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:both:${actionId}`)
      .setLabel('Both')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`seekdeep:archive:${actionId}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`seekdeep:sharedarchive:${actionId}`)
      .setLabel('Shared Archive')
      .setStyle(ButtonStyle.Primary),
  ];
  return new ActionRowBuilder().addComponents(...buttons);
}


// SEEKDEEP_PREGEN_PROMPT_CHOICE_START
const SEEKDEEP_PENDING_IMAGE_PROMPTS = globalThis.__seekdeepPendingImagePrompts || new Map();
globalThis.__seekdeepPendingImagePrompts = SEEKDEEP_PENDING_IMAGE_PROMPTS;
const SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS = Number(process.env.SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS || 15 * 60 * 1000);

function seekdeepSweepPendingImagePrompts() {
  const now = Date.now();
  for (const [id, state] of SEEKDEEP_PENDING_IMAGE_PROMPTS.entries()) {
    if (!state || Number(state.expiresAt || 0) <= now) SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);
  }
}

function seekdeepNewPendingImagePromptId() {
  seekdeepSweepPendingImagePrompts();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function seekdeepPendingPromptChoiceRow(id, disabledOrState = false) {
  const state = typeof disabledOrState === 'object' && disabledOrState
    ? disabledOrState
    : { disabled: Boolean(disabledOrState) };

  const allDisabled = Boolean(state.disabled);
  const originalDone = state.originalQueued === true;
  const refinedDone = state.refinedQueued === true;
  const bothDone = originalDone && refinedDone;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:original:${id}`)
      .setLabel(originalDone ? 'Original Queued' : 'Original')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(allDisabled || originalDone),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:refined:${id}`)
      .setLabel(refinedDone ? 'Refined Queued' : 'Refined')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(allDisabled || refinedDone),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:both:${id}`)
      .setLabel(bothDone ? 'Both Queued' : 'Both')
      .setStyle(ButtonStyle.Success)
      .setDisabled(allDisabled || bothDone),
  );
}

function seekdeepShouldUsePromptChoicePreview(imageModeOptions = {}) {
  if (/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_PREGEN_PROMPT_CHOICE || 'true'))) return false;

  // Explicit raw/unrefined requests should still immediately generate raw.
  // The preview system is for normal image requests where the user has not already chosen.
  if (imageModeOptions?.rawRequested || imageModeOptions?.refine === false) return false;

  return true;
}

async function seekdeepBuildImagePromptChoice(prompt = '', imageModeOptions = {}) {
  const options = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };

  const rawOriginalPrompt = normalizeUserText(options.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt).trim();
  const extractedOriginalPrompt = typeof seekdeepExtractImagePrompt === 'function'
    ? seekdeepExtractImagePrompt(rawOriginalPrompt)
    : rawOriginalPrompt;
  const originalPrompt = seekdeepNormalizeObjectAccuracyPrompt(
    normalizeUserText(extractedOriginalPrompt || rawOriginalPrompt || 'image').trim() || 'image'
  );

  const ground = options.ground !== false;
  const grounded = ground && typeof seekdeepMaybeGroundImagePrompt === 'function'
    ? await seekdeepMaybeGroundImagePrompt(originalPrompt)
    : { prompt: originalPrompt, grounded: false, searchQuery: '' };

  const prepared = typeof seekdeepPrepareImagePromptForGeneration === 'function'
    ? await seekdeepPrepareImagePromptForGeneration(grounded.prompt || originalPrompt)
    : { originalPrompt, refinedPrompt: grounded.prompt || originalPrompt, generationPrompt: grounded.prompt || originalPrompt, changed: false };

  const sanitized = typeof seekdeepSanitizeObjectImagePromptInfo === 'function'
    ? seekdeepSanitizeObjectImagePromptInfo(prepared)
    : prepared;

  return {
    originalPrompt,
    rawPrompt: originalPrompt,
    refinedPrompt: sanitized.generationPrompt || sanitized.refinedPrompt || grounded.prompt || originalPrompt,
    displayRefinedPrompt: sanitized.refinedPrompt || sanitized.generationPrompt || grounded.prompt || originalPrompt,
    dynamicRefinement: Boolean(sanitized.dynamicRefinement),
    dynamicRefinementAttempted: Boolean(sanitized.dynamicRefinementAttempted),
    dynamicRefinementError: sanitized.dynamicRefinementError || '',
    grounding: grounded,
    imageOptions: options,
  };
}

function seekdeepPromptChoicePreparationContent(prompt = '') {
  const dynamic = SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED && SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT_ENABLED;

  return [
    dynamic ? 'Refining image prompt with local chat model...' : 'Preparing image prompt choices...',
    dynamic ? 'This can take a minute when chat and image models swap.' : '',
    `Prompt: ${seekdeepClipForDiscord(prompt, 650)}`,
  ].filter(Boolean).join('\n');
}

function seekdeepPromptChoiceRefinementSourceLine(choice = null) {
  if (!choice) return '';
  if (choice.dynamicRefinement) return 'Refinement Source: local chat model';
  if (choice.dynamicRefinementAttempted) return 'Refinement Source: static rules after AI refinement was unavailable';
  return 'Refinement Source: static rules';
}

function seekdeepPromptChoiceContent(choice, requesterId = '') {
  const groundingLine = choice?.grounding?.grounded ? 'Grounding: on' : 'Grounding: off';
  const refinementSourceLine = seekdeepPromptChoiceRefinementSourceLine(choice);
  const requesterLine = requesterId ? `Requester: <@${requesterId}>` : '';

  return [
    'Image prompt prepared. Choose Original, Refined, or Both before queueing.',
    requesterLine,
    '',
    `Original Prompt: ${seekdeepClipForDiscord(choice.originalPrompt, 650)}`,
    `Refined Prompt: ${seekdeepClipForDiscord(choice.displayRefinedPrompt, 900)}`,
    refinementSourceLine,
    groundingLine,
    '',
    'No image has been queued yet.',
  ].filter(Boolean).join('\n');
}

function seekdeepRememberPendingImagePrompt(state) {
  const id = seekdeepNewPendingImagePromptId();

  SEEKDEEP_PENDING_IMAGE_PROMPTS.set(id, {
    ...state,
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS,
  });

  return id;
}

function seekdeepPromptChoiceProxyMessage(interaction, requesterId = '', suffix = '') {
  const fallbackId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const baseId = interaction?.message?.id || interaction?.id || 'prompt-choice';
  const uniqueId = suffix ? `${baseId}:${suffix}:${fallbackId}` : `${baseId}:${fallbackId}`;

  return {
    author: { id: requesterId || interaction?.user?.id || 'unknown' },
    channel: interaction?.channel || null,
    id: uniqueId,
    reply: async (payload) => {
      if (interaction?.channel && typeof interaction.channel.send === 'function') {
        return await interaction.channel.send(payload);
      }
      return null;
    },
  };
}


async function seekdeepSendImagePromptChoiceMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = {}) {
  const startedAt = seekdeepNowMs();
  const requesterId = message?.author?.id || 'unknown';
  const preparingPayload = {
    content: seekdeepAppendResponseFooter(seekdeepPromptChoicePreparationContent(prompt), {
      startedAt,
      modelUsed: (SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED && SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT_ENABLED) ? seekdeepChatModelLabel() : seekdeepNoModelLabel(),
    }),
    allowedMentions: { repliedUser: false },
  };

  let preparingMessage = null;
  try {
    preparingMessage = await message.reply(preparingPayload);
  } catch (err) {
    console.warn('Could not send image prompt refinement status:', err?.message || err);
  }

  try {
    const choice = await seekdeepBuildImagePromptChoice(prompt, imageModeOptions);
    const id = seekdeepRememberPendingImagePrompt({
      source: 'message',
      requesterId,
      channelId: message?.channel?.id || '',
      originalPrompt: choice.originalPrompt,
      rawPrompt: choice.rawPrompt,
      refinedPrompt: choice.refinedPrompt,
      dynamicRefinement: choice.dynamicRefinement,
      dynamicRefinementAttempted: choice.dynamicRefinementAttempted,
      dynamicRefinementError: choice.dynamicRefinementError || '',
      width,
      height,
      seed,
      ground: choice.imageOptions?.ground !== false,
    });

    const finalPayload = {
      content: seekdeepAppendResponseFooter(seekdeepPromptChoiceContent(choice, requesterId), {
        startedAt,
        modelUsed: choice.dynamicRefinement ? seekdeepChatModelLabel() : seekdeepNoModelLabel(),
      }),
      components: [seekdeepPendingPromptChoiceRow(id)],
      allowedMentions: { repliedUser: false },
    };

    if (preparingMessage && typeof preparingMessage.edit === 'function') {
      try {
        return await preparingMessage.edit(finalPayload);
      } catch (err) {
        console.warn('Could not edit image prompt refinement status:', err?.message || err);
      }
    }

    return await message.reply(finalPayload);
  } finally {
    stopSeekDeepTypingLoopForMessage(message);
  }
}

async function seekdeepSendImagePromptChoiceInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = {}) {
  const startedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();
  const requesterId = interaction?.user?.id || 'unknown';
  await safeEditOrReply(interaction, {
    content: seekdeepAppendResponseFooter(seekdeepPromptChoicePreparationContent(prompt), {
      startedAt,
      modelUsed: (SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED && SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT_ENABLED) ? seekdeepChatModelLabel() : seekdeepNoModelLabel(),
    }),
    components: [],
    allowedMentions: { repliedUser: false },
  });

  const choice = await seekdeepBuildImagePromptChoice(prompt, imageModeOptions);
  const id = seekdeepRememberPendingImagePrompt({
    source: 'interaction',
    requesterId,
    channelId: interaction?.channel?.id || '',
    originalPrompt: choice.originalPrompt,
    rawPrompt: choice.rawPrompt,
    refinedPrompt: choice.refinedPrompt,
    dynamicRefinement: choice.dynamicRefinement,
    dynamicRefinementAttempted: choice.dynamicRefinementAttempted,
    dynamicRefinementError: choice.dynamicRefinementError || '',
    width,
    height,
    seed,
    ground: choice.imageOptions?.ground !== false,
  });

  return await safeEditOrReply(interaction, {
    content: seekdeepAppendResponseFooter(seekdeepPromptChoiceContent(choice, requesterId), {
      startedAt,
      modelUsed: choice.dynamicRefinement ? seekdeepChatModelLabel() : seekdeepNoModelLabel(),
    }),
    components: [seekdeepPendingPromptChoiceRow(id)],
    allowedMentions: { repliedUser: false },
  });
}

async function seekdeepHandlePromptChoiceButton(interaction) {
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:prompt:(original|refined|both):(.+)$/);
  if (!match) return false;

  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
    } catch (err) {
      console.warn('Prompt choice deferUpdate failed:', err?.message || err);
    }
  }

  const action = match[1];
  const id = match[2];

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute(`image-choice-${action}`, id);
  }

  seekdeepSweepPendingImagePrompts();
  const state = SEEKDEEP_PENDING_IMAGE_PROMPTS.get(id) || null;
  const startedAt = seekdeepNowMs();

  const editChoiceMessage = async (payload) => {
    try {
      if (interaction?.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit(payload);
        return true;
      }
    } catch (err) {
      console.warn('Prompt choice message edit failed:', err?.message || err);
    }

    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(payload);
        return true;
      }
    } catch (err) {
      console.warn('Prompt choice editReply fallback failed:', err?.message || err);
    }

    return false;
  };

  const privateNotice = async (content) => {
    try {
      await interaction.followUp(seekdeepEphemeralPayload({
        content,
      }));
    } catch (err) {
      console.warn('Prompt choice followUp failed:', err?.message || err);
    }
  };

  if (!state) {
    const expiredText = [
      'Prompt choice expired before a version was selected.',
      'Run the image request again to reopen Original / Refined / Both.',
    ].join('\n');

    await editChoiceMessage({
      content: seekdeepAppendResponseFooter(expiredText, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      components: [],
    });

    return true;
  }

  if (state.requesterId && interaction?.user?.id !== state.requesterId) {
    await privateNotice('Only the requester can use these image prompt buttons.');
    return true;
  }

  const basePrompt = state.originalPrompt || state.rawPrompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const groundingOn = state.ground !== false;
  const groundingLine = groundingOn ? 'Grounding: on' : 'Grounding: off';

  const needsOriginal = (action === 'original' || action === 'both') && !state.originalQueued;
  const needsRefined = (action === 'refined' || action === 'both') && !state.refinedQueued;

  if (!needsOriginal && !needsRefined) {
    await privateNotice('That version has already been queued for this prompt.');
    return true;
  }

  state.originalQueued = Boolean(state.originalQueued || needsOriginal);
  state.refinedQueued = Boolean(state.refinedQueued || needsRefined);
  state.lastSelectedAt = Date.now();
  SEEKDEEP_PENDING_IMAGE_PROMPTS.set(id, state);

  const queuedLines = [];
  if (needsOriginal) queuedLines.push('Original prompt');
  if (needsRefined) queuedLines.push('Refined prompt');

  const allQueued = Boolean(state.originalQueued && state.refinedQueued);
  const selectionSummary = [
    needsOriginal && needsRefined ? 'Queued both:' : needsOriginal ? 'Queued original.' : 'Queued refined.',
    needsOriginal && needsRefined ? '- Original' : '',
    needsOriginal && needsRefined ? '- Refined' : '',
    '',
    groundingLine,
    needsOriginal && !needsRefined ? 'Refinement: off' : '',
    needsRefined && !needsOriginal ? 'Refinement: on' : '',
    `Queued Jobs: ${queuedLines.length}`,
    '',
    allQueued ? 'Both versions have now been queued.' : 'You can still choose the remaining version from this prompt.',
  ].filter(Boolean).join('\n');

  if (allQueued) {
    SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);
  }

  await editChoiceMessage({
    content: seekdeepAppendResponseFooter(selectionSummary, {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    components: allQueued ? [] : [seekdeepPendingPromptChoiceRow(id, state)],
  });

  const runQueuedSelection = async (messageProxy, selectionPrompt, selectionOptions, routeName) => {
    try {
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute(routeName, selectionPrompt);
      }

      await seekdeepSendImageWithButtonsMessage(
        messageProxy,
        selectionPrompt,
        width,
        height,
        seed,
        selectionOptions,
      );
    } catch (err) {
      console.warn(`Prompt choice generation failed (${routeName}):`, err?.stack || err?.message || err);
    }
  };

  if (needsOriginal) {
    const originalProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'original');
    void runQueuedSelection(
      originalProxy,
      basePrompt,
      {
        refine: false,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-original'
    );
  }

  if (needsRefined) {
    const refinedProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'refined');
    const refinedPrompt = normalizeUserText(state.refinedPrompt || basePrompt).trim() || basePrompt;
    void runQueuedSelection(
      refinedProxy,
      basePrompt,
      {
        refine: true,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        preRefinedPrompt: refinedPrompt,
        dynamicRefinement: Boolean(state.dynamicRefinement),
        dynamicRefinementAttempted: Boolean(state.dynamicRefinementAttempted || state.dynamicRefinement),
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-refined'
    );
  }

  return true;
}
// SEEKDEEP_PREGEN_PROMPT_CHOICE_END


function seekdeepAttachmentDownloadUrl(sentMessage) {
  try {
    const first = sentMessage?.attachments?.first?.();
    return first?.url || first?.proxyURL || null;
  } catch {
    return null;
  }
}

async function seekdeepAttachDownloadButton(sentMessage, actionId) {
  const url = seekdeepAttachmentDownloadUrl(sentMessage);

  if (!url || !sentMessage || typeof sentMessage.edit !== 'function') {
    return sentMessage;
  }

  try {
    return await sentMessage.edit({
      components: seekdeepImageActionComponents(actionId, url),
    });
  } catch (err) {
    console.warn('Could not attach Download button:', err?.message || err);
    return sentMessage;
  }
}

function seekdeepSafeFilenamePiece(value, fallback = 'seekdeep-image') {
  const clean = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return clean || fallback;
}

// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_START
const SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_IMAGE_PROMPT_REFINEMENT || 'true'));
const SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT || 'true'));
const SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG = /^(1|true|on|yes)$/i.test(String(process.env.SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG || 'true'));
const SEEKDEEP_IMAGE_PROMPT_MAX_CHARS = Math.max(180, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 650));
const SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TIMEOUT_MS = Math.max(5000, Number(process.env.SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TIMEOUT_MS || 180000));
const SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_TOKENS = Math.max(80, Math.min(768, Number(process.env.SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_TOKENS || 360)));
const SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TEMPERATURE = Number(process.env.SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TEMPERATURE || 0.5);
const SEEKDEEP_IMAGE_PROMPT_DYNAMIC_SYSTEM_PROMPT = [
  'You are SeekDeep image-prompt refinement mode.',
  'Return only one improved image-generation prompt. No heading, markdown, notes, or negative prompt.',
  'Preserve the exact subject, action, relationships, count, mood, and any requested style from the user prompt.',
  'Make the prompt materially more useful for SDXL by adding concrete, relevant visual detail inferred from the original.',
  'For short prompts, add 4 to 7 grounded visual details: subject appearance, materials, environment, lighting, composition, palette, texture, camera angle, or mood.',
  'For already detailed prompts, tighten wording and add only missing visual production details.',
  'Do not make the prompt minimal unless the user explicitly asks for a minimal prompt.',
  'Do not add unrelated objects, characters, locations, franchises, symbols, text, logos, or motifs.',
  'Do not use generic filler such as "stylized illustration", "clear details", "expressive subject", "moody composition", or "expressive brushwork" unless the user explicitly asked for that style.',
  'Use concrete nouns and adjectives instead of quality filler; avoid "masterpiece", "best quality", "ultra detailed", and similar tag soup.',
  'Keep it as one sentence or comma-separated prompt, roughly 40 to 85 words, under 650 characters.'
].join('\n');

function seekdeepImagePromptHasAny(lower, words) {
  return words.some((word) => lower.includes(word));
}

function seekdeepImagePromptAdd(parts, phrase) {
  const clean = String(phrase || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const lower = clean.toLowerCase();
  if (!parts.some((part) => String(part).toLowerCase() === lower)) parts.push(clean);
}

function seekdeepImageBaseNegativePrompt(prompt = '') {
  const fallback = 'watermark, random text, misspelled text, logo text, blurry, low detail, cluttered background, plastic 3d render, generic stock photo, malformed anatomy, extra fingers, distorted eyes, duplicate face';
  const base = String(process.env.SEEKDEEP_IMAGE_NEGATIVE_PROMPT || process.env.IMAGE_NEGATIVE_PROMPT || fallback).replace(/\s+/g, ' ').trim();
  const asksText = /\b(text|words|lettering|title|caption|says|saying|sign|label|typography|font)\b/i.test(prompt);
  if (!asksText) return base;
  return base.replace(/\b(random text|misspelled text|logo text|text)\b,?\s*/gi, '').replace(/\s*,\s*,+/g, ', ').replace(/^,\s*|,\s*$/g, '').trim();
}

function seekdeepPrepareImagePrompt(prompt = '') {
  prompt = seekdeepGroundBotanicalSlangPrompt(prompt);

  const originalPrompt = normalizeUserText(prompt || '').trim() || 'image';
  const negativePrompt = seekdeepImageBaseNegativePrompt(originalPrompt);

  if (!SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED) {
    return { originalPrompt, refinedPrompt: originalPrompt, generationPrompt: originalPrompt, negativePrompt, changed: false };
  }

  const lower = originalPrompt.toLowerCase();
  const parts = [originalPrompt];

  const hasStyle = /\b(hyper\s*realistic|photorealistic|realistic|cinematic|anime|manga|comic|oil painting|oil-painted|watercolor|pixel art|3d|render|illustration|illustrated|stylized|painterly|graphic|vector|logo|icon|poster|album art|wallpaper|sketch|low poly|claymation|stop motion|emo|screamo|hardcore|punk|grunge|zine)\b/i.test(originalPrompt);
  const hasQuality = /\b(high quality|detailed|sharp|clean|polished|professional|masterpiece|ultra detailed|high detail|hd|4k|8k|coherent|clear)\b/i.test(originalPrompt);
  const hasLighting = /\b(lighting|lit|glow|shadow|sunset|sunrise|moonlight|neon|ambient|dramatic light|soft light|studio light|rim light|backlit|dusk|twilight)\b/i.test(originalPrompt);
  const hasComposition = /\b(composition|centered|off center|wide shot|close up|portrait|landscape|symmetrical|asymmetrical|negative space|foreground|background|depth|poster layout|editorial)\b/i.test(originalPrompt);

  if (seekdeepImagePromptHasAny(lower, ['logo', 'icon', 'emblem', 'badge'])) {
    if (!hasStyle) seekdeepImagePromptAdd(parts, 'bold emblem design, readable silhouette');
    if (!hasComposition) seekdeepImagePromptAdd(parts, 'centered composition, clean negative space');
  } else if (seekdeepImagePromptHasAny(lower, ['banner', 'wallpaper', 'cover art', 'album art', 'poster', 'album cover', 'metal', 'rock', 'emo', 'screamo', 'hardcore', 'punk'])) {
    if (!hasStyle) seekdeepImagePromptAdd(parts, 'graphic poster art, gritty brushwork');
    if (!hasComposition) seekdeepImagePromptAdd(parts, 'bold poster composition, clear focal point');
  } else if (/\b(hyper\s*realistic|photorealistic|realistic|photo)\b/i.test(originalPrompt)) {
    seekdeepImagePromptAdd(parts, 'believable materials, natural structure');
    if (!hasLighting) seekdeepImagePromptAdd(parts, 'realistic lighting, clear depth');
  } else if (!hasStyle) {
    seekdeepImagePromptAdd(parts, 'stylized illustration');
  }

  if (seekdeepImagePromptHasAny(lower, ['pepe', 'frog', 'toad', 'cat', 'dog', 'fox', 'animal', 'creature', 'dragon', 'bird', 'horse', 'goomba'])) {
    seekdeepImagePromptAdd(parts, 'expressive subject');
  }

  if (seekdeepImagePromptHasAny(lower, ['sailor moon', 'usagi', 'girl', 'woman', 'boy', 'man', 'person', 'human', 'elf', 'character', 'portrait'])) {
    seekdeepImagePromptAdd(parts, 'coherent character design');
  }

  if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi', 'onion'])) {
    seekdeepImagePromptAdd(parts, 'organic texture, clear botanical forms');
  }

  if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'deku', 'queen', 'king', 'royal'])) {
    seekdeepImagePromptAdd(parts, 'fantasy atmosphere');
  }

  if (seekdeepImagePromptHasAny(lower, ['smoking', 'smokin', 'smoke', 'spliff', 'blunt', 'joint', 'cigarette'])) {
    seekdeepImagePromptAdd(parts, 'rebellious mood, drifting smoke');
  }

  if (seekdeepImagePromptHasAny(lower, ['sunset', 'sunrise', 'dusk', 'twilight', 'neon', 'night', 'moonlight', 'balcony', 'city lights', 'bar lights'])) {
    seekdeepImagePromptAdd(parts, 'atmospheric lighting');
  }

  if (!hasQuality) seekdeepImagePromptAdd(parts, 'clear details');

  let refinedPrompt = parts.join(', ').replace(/\s+/g, ' ').trim();
  if (refinedPrompt.length > SEEKDEEP_IMAGE_PROMPT_MAX_CHARS) refinedPrompt = refinedPrompt.slice(0, SEEKDEEP_IMAGE_PROMPT_MAX_CHARS).replace(/[,;:\s]+$/g, '').trim();
  return { originalPrompt, refinedPrompt, generationPrompt: refinedPrompt, negativePrompt, changed: refinedPrompt !== originalPrompt };
}

function seekdeepBuildDynamicImagePromptRefineRequest(originalPrompt = '') {
  const clean = normalizeUserText(originalPrompt).trim();
  return [
    'Rewrite this as a stronger prompt for a local SDXL image model.',
    'Keep the exact subject and intent, but make the visual target more specific and model-ready.',
    'Add relevant detail about what the subject looks like, where it is, how it is lit, how it is framed, and what materials/textures/colors matter.',
    'Keep surreal or funny relationships intact instead of correcting them.',
    'Do not add unrelated lore, extra characters, labels, readable text, or a different art style unless the original asks for it.',
    '',
    `Original prompt: ${clean}`,
    '',
    'Return only the final prompt text.'
  ].join('\n');
}

function seekdeepImagePromptKeywordStem(word = '') {
  return String(word || '')
    .toLowerCase()
    .replace(/(?:ing|ers|er|ies|ied|ed|es|s)$/i, '')
    .trim();
}

function seekdeepImagePromptKeywords(prompt = '') {
  const stop = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'the', 'their', 'this', 'to', 'with',
    'make', 'create', 'draw', 'generate', 'show', 'render', 'paint', 'sketch', 'illustrate', 'design', 'image', 'picture', 'photo', 'art', 'prompt'
  ]);

  const words = String(prompt || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const out = [];

  for (const word of words) {
    if (word.length < 3 || stop.has(word)) continue;
    const stem = seekdeepImagePromptKeywordStem(word);
    if (stem.length < 3 || stop.has(stem)) continue;
    if (!out.includes(stem)) out.push(stem);
  }

  return out.slice(0, 14);
}

function seekdeepDynamicImagePromptPreservesSubject(originalPrompt = '', candidatePrompt = '') {
  const originalKeywords = seekdeepImagePromptKeywords(originalPrompt);
  if (!originalKeywords.length) return true;

  const candidate = ' ' + seekdeepImagePromptKeywords(candidatePrompt).join(' ') + ' ';
  const lowerCandidate = String(candidatePrompt || '').toLowerCase();
  const matched = originalKeywords.filter((word) => candidate.includes(' ' + word + ' ') || lowerCandidate.includes(word));
  const required = originalKeywords.length <= 2 ? originalKeywords.length : Math.max(2, Math.ceil(originalKeywords.length * 0.45));
  return matched.length >= required;
}

function seekdeepDynamicImagePromptLooksGeneric(originalPrompt = '', candidatePrompt = '') {
  const original = normalizeUserText(originalPrompt).toLowerCase();
  const candidate = normalizeUserText(candidatePrompt).toLowerCase();
  if (!candidate || candidate === original) return false;

  const genericPhrases = [
    'stylized illustration',
    'clear details',
    'expressive subject',
    'painterly illustration',
    'moody composition',
    'expressive brushwork',
    'highly detailed',
    'professional quality',
    'beautiful composition'
  ];

  const genericCount = genericPhrases.filter((phrase) => candidate.includes(phrase) && !original.includes(phrase)).length;
  return genericCount >= 2 && candidate.length < original.length + 90;
}

function seekdeepCleanDynamicImagePrompt(text = '', originalPrompt = '') {
  let out = cleanupRefinedPrompt(cleanupAssistantReply(text));

  out = out
    .replace(/^\s*(image\s+prompt|prompt|refined\s+prompt|final\s+prompt)\s*:\s*/i, '')
    .replace(/\n+\s*(negative\s+prompt|notes?|explanation)\s*:[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  if (!out) return '';
  if (/^(?:i can|i cannot|i can't|sorry|sure|here(?:'s| is)|okay)\b/i.test(out)) return '';
  if (out.length > SEEKDEEP_IMAGE_PROMPT_MAX_CHARS) out = out.slice(0, SEEKDEEP_IMAGE_PROMPT_MAX_CHARS).replace(/[,;:\s]+$/g, '').trim();
  if (!seekdeepDynamicImagePromptPreservesSubject(originalPrompt, out)) return '';
  if (seekdeepDynamicImagePromptLooksGeneric(originalPrompt, out)) return '';

  return out;
}

async function seekdeepPrepareImagePromptDynamic(prompt = '', fallbackPromptInfo = null) {
  const fallback = fallbackPromptInfo || seekdeepPrepareImagePrompt(prompt);
  const originalPrompt = normalizeUserText(prompt || fallback.originalPrompt || '').trim() || 'image';

  if (!SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED || !SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT_ENABLED) {
    return fallback;
  }

  try {
    const answer = await runLocalChat(
      seekdeepBuildDynamicImagePromptRefineRequest(originalPrompt),
      buildSystem(SEEKDEEP_IMAGE_PROMPT_DYNAMIC_SYSTEM_PROMPT, false),
      '',
      SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_TOKENS,
      SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TEMPERATURE,
      { timeoutMs: SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TIMEOUT_MS, modelRole: 'default_chat' }
    );

    const refinedPrompt = seekdeepCleanDynamicImagePrompt(answer, originalPrompt);
    if (!refinedPrompt) {
      return {
        ...fallback,
        dynamicRefinementAttempted: true,
        dynamicRefinementError: 'empty-or-rejected-output',
      };
    }

    return {
      ...fallback,
      originalPrompt: fallback.originalPrompt || originalPrompt,
      refinedPrompt,
      generationPrompt: refinedPrompt,
      changed: refinedPrompt !== originalPrompt,
      dynamicRefinement: true,
      dynamicRefinementAttempted: true,
    };
  } catch (err) {
    console.warn('Dynamic image prompt refinement failed; using static fallback:', err?.message || err);
    return {
      ...fallback,
      dynamicRefinementAttempted: true,
      dynamicRefinementError: String(err?.message || err || 'dynamic refinement failed'),
    };
  }
}

async function seekdeepPrepareImagePromptForGeneration(prompt = '') {
  const fallback = seekdeepPrepareImagePrompt(prompt);
  return await seekdeepPrepareImagePromptDynamic(prompt, fallback);
}
// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_END


function seekdeepLooksLikeObjectOnlyImagePrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();

  const objectCue = /\b(bag|pouch|sack|bells|bell|coin|coins|logo|emblem|badge|icon|item|object|prop|weapon|sword|shield|helmet|armor|ring|book|box|bottle|cup|mug|car|laptop|console|controller|poster|album cover|wallpaper)\b/.test(p);
  const characterCue = /\b(person|human|man|woman|girl|boy|face|portrait|hands|eyes|cat|dog|frog|dragon|monster|character|sailor moon|pepe|ripto|spyro)\b/.test(p);

  return objectCue && !characterCue;
}

function seekdeepSanitizeObjectImagePromptInfo(promptInfo) {
  if (!promptInfo || !seekdeepLooksLikeObjectOnlyImagePrompt(promptInfo.originalPrompt || promptInfo.generationPrompt || '')) return promptInfo;

  const cleanOne = (value = '') => String(value || '')
    .replace(/,?\s*expressive subject/gi, '')
    .replace(/,?\s*coherent anatomy/gi, '')
    .replace(/,?\s*natural anatomy/gi, '')
    .replace(/,?\s*clean hands/gi, '')
    .replace(/,?\s*plastic skin/gi, '')
    .replace(/,?\s*avoid malformed anatomy/gi, '')
    .replace(/,?\s*avoid malformed limbs/gi, '')
    .replace(/,?\s*duplicated faces/gi, '')
    .replace(/,?\s*distorted eyes/gi, '')
    .replace(/\s*,\s*,+/g, ',')
    .replace(/,\s*$/g, '')
    .trim();

  const objectAdd = 'centered object composition, accurate prop silhouette, readable item design, crisp edges, no extra characters, no face, no limbs';
  const refined = cleanOne(promptInfo.refinedPrompt);
  const generation = cleanOne(promptInfo.generationPrompt);

  promptInfo.refinedPrompt = refined.includes('centered object composition') ? refined : `${refined}, ${objectAdd}`;
  promptInfo.generationPrompt = generation.includes('centered object composition') ? generation : `${generation}, ${objectAdd}`;
  return promptInfo;
}


async function makeImageResult(prompt, width = 1024, height = 1024, seed = null, imageOptions = {}) {
  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START
  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START
  const seekdeepImageOptions = {
    refine: imageOptions?.refine !== false,
    ground: imageOptions?.ground !== false,
  };
  const seekdeepGroundedImagePrompt = seekdeepImageOptions.ground && typeof seekdeepMaybeGroundImagePrompt === 'function'
    ? await seekdeepMaybeGroundImagePrompt(prompt)
    : { prompt, grounded: false, searchQuery: '' };

  let promptInfo;
  if (seekdeepImageOptions.refine) {
    const preRefinedPrompt = normalizeUserText(imageOptions?.preRefinedPrompt || '').trim();
    const basePrompt = normalizeUserText(seekdeepGroundedImagePrompt.prompt || prompt).trim();
    const prepared = preRefinedPrompt
      ? {
          originalPrompt: normalizeUserText(prompt).trim(),
          refinedPrompt: preRefinedPrompt,
          generationPrompt: preRefinedPrompt,
          negativePrompt: typeof seekdeepImageBaseNegativePrompt === 'function' ? seekdeepImageBaseNegativePrompt(preRefinedPrompt) : (process.env.SEEKDEEP_IMAGE_NEGATIVE_PROMPT || process.env.IMAGE_NEGATIVE_PROMPT || ''),
          changed: preRefinedPrompt !== basePrompt,
          dynamicRefinement: Boolean(imageOptions?.dynamicRefinement),
          dynamicRefinementAttempted: Boolean(imageOptions?.dynamicRefinementAttempted || imageOptions?.dynamicRefinement),
        }
      : (typeof seekdeepPrepareImagePromptForGeneration === 'function'
          ? await seekdeepPrepareImagePromptForGeneration(basePrompt)
          : seekdeepPrepareImagePrompt(basePrompt));
    promptInfo = typeof seekdeepSanitizeObjectImagePromptInfo === 'function'
      ? seekdeepSanitizeObjectImagePromptInfo(prepared)
      : prepared;
  } else {
    const rawPrompt = normalizeUserText(seekdeepGroundedImagePrompt.prompt || prompt).trim();
    promptInfo = {
      originalPrompt: normalizeUserText(prompt).trim(),
      refinedPrompt: rawPrompt,
      generationPrompt: rawPrompt,
      negativePrompt: typeof seekdeepImageBaseNegativePrompt === 'function' ? seekdeepImageBaseNegativePrompt(rawPrompt) : (process.env.SEEKDEEP_IMAGE_NEGATIVE_PROMPT || process.env.IMAGE_NEGATIVE_PROMPT || ''),
      changed: rawPrompt !== normalizeUserText(prompt).trim(),
    };
  }
  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_END
  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_END


  if (promptInfo.changed && SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG) {
    const refinementLabel = promptInfo.dynamicRefinement ? 'image prompt dynamically refined' : 'image prompt refined';
    console.log(`[SeekDeep] ${refinementLabel}:\n  original: ${promptInfo.originalPrompt}\n  refined : ${promptInfo.refinedPrompt}`);
  }

  const response = await postLocal('/image', {
    prompt: promptInfo.generationPrompt,
    width,
    height,
    steps: Number(process.env.IMAGE_STEPS || 28),
    guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 6.5),
    seed,
    negative_prompt: promptInfo.negativePrompt || process.env.SEEKDEEP_IMAGE_NEGATIVE_PROMPT || process.env.IMAGE_NEGATIVE_PROMPT || '',
  });

  const buffer = Buffer.from(response.image_b64, 'base64');
  const filename = response.filename || 'seekdeep_image.png';

  return {
    file: new AttachmentBuilder(buffer, { name: filename }),
    buffer,
    filename,
    prompt: promptInfo.originalPrompt,
    originalPrompt: promptInfo.originalPrompt,
    refinedPrompt: promptInfo.refinedPrompt,
    generationPrompt: promptInfo.generationPrompt,
    promptRefined: promptInfo.changed,
    refinementEnabled: seekdeepImageOptions.refine,
    dynamicRefinementAttempted: Boolean(promptInfo.dynamicRefinementAttempted),
    grounding: seekdeepGroundedImagePrompt,
    imageOptions: {
      ...seekdeepImageOptions,
      dynamicRefinement: Boolean(promptInfo.dynamicRefinement),
      dynamicRefinementAttempted: Boolean(promptInfo.dynamicRefinementAttempted),
    },
    width,
    height,
    seed,
  };
}

async function makeImage(prompt, width = 1024, height = 1024, seed = null) {
  const result = await makeImageResult(prompt, width, height, seed, {});
  return result.file;
}


// SEEKDEEP_TEMP_IMAGE_CACHE_START
const seekdeepTempImageStateIndex = globalThis.__seekdeepTempImageStateIndex || new Map();
globalThis.__seekdeepTempImageStateIndex = seekdeepTempImageStateIndex;

const SEEKDEEP_IMAGE_CACHE_TTL_HOURS = Math.max(1, Number(process.env.SEEKDEEP_IMAGE_CACHE_TTL_HOURS || 24));
const SEEKDEEP_IMAGE_CACHE_TTL_MS = SEEKDEEP_IMAGE_CACHE_TTL_HOURS * 60 * 60 * 1000;
const SEEKDEEP_IMAGE_CACHE_DIR = path.join(__dirname, 'temp', 'image-cache');

function seekdeepEnsureImageCacheDir() {
  if (!fs.existsSync(SEEKDEEP_IMAGE_CACHE_DIR)) {
    fs.mkdirSync(SEEKDEEP_IMAGE_CACHE_DIR, { recursive: true });
  }
}

function seekdeepSafeImageFilename(name = 'seekdeep_image.png') {
  const cleaned = String(name || 'seekdeep_image.png')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .trim();

  return cleaned || 'seekdeep_image.png';
}

function seekdeepMakeImageActionId() {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function seekdeepImageCacheMetaPath(id) {
  return path.join(SEEKDEEP_IMAGE_CACHE_DIR, `${id}.json`);
}

function seekdeepImageCacheBinaryPath(id, filename = 'seekdeep_image.png') {
  const safe = seekdeepSafeImageFilename(filename);
  const ext = path.extname(safe) || '.png';
  return path.join(SEEKDEEP_IMAGE_CACHE_DIR, `${id}${ext}`);
}

function seekdeepNormalizeGeneratedImageResult(result) {
  const attachmentLike = result?.attachment || result?.file || result?.builder || null;

  let buffer =
    result?.buffer ||
    result?.fileBuffer ||
    result?.imageBuffer ||
    null;

  let filename =
    result?.filename ||
    result?.name ||
    attachmentLike?.name ||
    attachmentLike?.data?.name ||
    'seekdeep_image.png';

  if (!buffer && Buffer.isBuffer(attachmentLike?.attachment)) {
    buffer = attachmentLike.attachment;
  }

  if (!buffer && Buffer.isBuffer(result)) {
    buffer = result;
  }

  if (!buffer && typeof result?.image_b64 === 'string' && result.image_b64.length > 0) {
    buffer = Buffer.from(result.image_b64, 'base64');
  }

  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Generated image result did not include a usable Buffer.');
  }

  const attachment = attachmentLike || new AttachmentBuilder(buffer, { name: seekdeepSafeImageFilename(filename) });

  return {
    buffer,
    filename: seekdeepSafeImageFilename(filename),
    attachment,
  };
}

function seekdeepRememberTempImageState(state) {
  seekdeepEnsureImageCacheDir();

  const createdAt = Number(state?.createdAt || Date.now());
  const expiresAt = Number(state?.expiresAt || (createdAt + SEEKDEEP_IMAGE_CACHE_TTL_MS));
  const id = String(state?.id || seekdeepMakeImageActionId());
  const filename = seekdeepSafeImageFilename(state?.filename || 'seekdeep_image.png');
  const binaryPath = seekdeepImageCacheBinaryPath(id, filename);
  const metaPath = seekdeepImageCacheMetaPath(id);

  if (!state?.buffer || !Buffer.isBuffer(state.buffer)) {
    throw new Error('Temp image cache cannot persist a state without a Buffer.');
  }

  fs.writeFileSync(binaryPath, state.buffer);

  const meta = {
    id,
    prompt: state?.prompt || '',
    originalPrompt: state?.originalPrompt || state?.prompt || '',
    refinedPrompt: state?.refinedPrompt || state?.prompt || '',
    generationPrompt: state?.generationPrompt || state?.refinedPrompt || state?.prompt || '',
    promptRefined: Boolean(state?.promptRefined),
    width: Number(state?.width || 1024),
    height: Number(state?.height || 1024),
    seed: state?.seed ?? null,
    filename,
    binaryPath,
    createdAt,
    expiresAt,
    mimeType: state?.mimeType || 'image/png',
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  const liveState = {
    ...meta,
    buffer: state.buffer,
  };

  seekdeepTempImageStateIndex.set(id, liveState);
  return liveState;
}

function seekdeepDeleteTempImageState(id, meta = null) {
  try {
    const state = meta || seekdeepTempImageStateIndex.get(id) || null;
    seekdeepTempImageStateIndex.delete(id);

    const metaPath = seekdeepImageCacheMetaPath(id);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

    const binaryPath = state?.binaryPath;
    if (binaryPath && fs.existsSync(binaryPath)) {
      fs.unlinkSync(binaryPath);
      return;
    }

    try {
      const files = fs.readdirSync(SEEKDEEP_IMAGE_CACHE_DIR);
      for (const file of files) {
        if (file.startsWith(`${id}.`)) {
          const full = path.join(SEEKDEEP_IMAGE_CACHE_DIR, file);
          if (fs.existsSync(full)) fs.unlinkSync(full);
        }
      }
    } catch {}
  } catch (err) {
    console.warn('Could not delete expired temp image cache entry:', err?.message || err);
  }
}

function seekdeepLoadTempImageState(id) {
  seekdeepEnsureImageCacheDir();

  const now = Date.now();
  const live = seekdeepTempImageStateIndex.get(id);

  if (live) {
    if (Number(live.expiresAt || 0) <= now) {
      seekdeepDeleteTempImageState(id, live);
      return null;
    }

    if (live.buffer && Buffer.isBuffer(live.buffer)) return live;
  }

  const metaPath = seekdeepImageCacheMetaPath(id);
  if (!fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    if (Number(meta?.expiresAt || 0) <= now) {
      seekdeepDeleteTempImageState(id, meta);
      return null;
    }

    if (!meta?.binaryPath || !fs.existsSync(meta.binaryPath)) {
      seekdeepDeleteTempImageState(id, meta);
      return null;
    }

    const buffer = fs.readFileSync(meta.binaryPath);
    const state = { ...meta, buffer };

    seekdeepTempImageStateIndex.set(id, state);
    return state;
  } catch (err) {
    console.warn('Could not load temp image state from disk:', err?.message || err);
    return null;
  }
}

function seekdeepSweepExpiredImageCache() {
  seekdeepEnsureImageCacheDir();

  const now = Date.now();

  for (const [id, state] of seekdeepTempImageStateIndex.entries()) {
    if (Number(state?.expiresAt || 0) <= now) {
      seekdeepDeleteTempImageState(id, state);
    }
  }

  try {
    const files = fs.readdirSync(SEEKDEEP_IMAGE_CACHE_DIR).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const full = path.join(SEEKDEEP_IMAGE_CACHE_DIR, file);

      try {
        const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (Number(meta?.expiresAt || 0) <= now) {
          seekdeepDeleteTempImageState(String(meta?.id || path.basename(file, '.json')), meta);
        }
      } catch {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  } catch (err) {
    console.warn('Could not sweep temp image cache:', err?.message || err);
  }
}

seekdeepEnsureImageCacheDir();
seekdeepSweepExpiredImageCache();

const __seekdeepImageCacheSweepTimer = setInterval(() => {
  try {
    seekdeepSweepExpiredImageCache();
  } catch (err) {
    console.warn('Temp image cache sweep interval failed:', err?.message || err);
  }
}, 30 * 60 * 1000);

if (typeof __seekdeepImageCacheSweepTimer?.unref === 'function') {
  __seekdeepImageCacheSweepTimer.unref();
}
// SEEKDEEP_TEMP_IMAGE_CACHE_END

function seekdeepArchiveImageStateToDisk(state) {
  throw new Error('Disk archive storage is disabled. Configure Discord thread archive storage and retry.');
}

// SEEKDEEP_IMAGE_QUEUE_START
const seekdeepImageQueueState = globalThis.__seekdeepImageQueueState || {
  active: null,
  pending: [],
  sequence: 0,
  completed: 0,
  failed: 0,
};

globalThis.__seekdeepImageQueueState = seekdeepImageQueueState;

const SEEKDEEP_IMAGE_COOLDOWN_MS = Math.max(0, Number(process.env.SEEKDEEP_IMAGE_COOLDOWN_MS || 0));
const seekdeepImageCooldowns = globalThis.__seekdeepImageCooldowns || new Map();
globalThis.__seekdeepImageCooldowns = seekdeepImageCooldowns;

function seekdeepImageCooldownRemaining(userId) {
  if (!SEEKDEEP_IMAGE_COOLDOWN_MS || !userId) return 0;

  const last = Number(seekdeepImageCooldowns.get(String(userId)) || 0);
  const remaining = SEEKDEEP_IMAGE_COOLDOWN_MS - (Date.now() - last);

  return Math.max(0, remaining);
}

function seekdeepRememberImageCooldown(userId) {
  if (!SEEKDEEP_IMAGE_COOLDOWN_MS || !userId) return;
  seekdeepImageCooldowns.set(String(userId), Date.now());
}

function seekdeepImageQueueCurrentPosition() {
  return seekdeepImageQueueState.pending.length + (seekdeepImageQueueState.active ? 1 : 0) + 1;
}

function seekdeepCreateImageQueueJob({ source = 'unknown', userId = '', channelId = '', prompt = '', width = 1024, height = 1024, seed = null } = {}) {
  seekdeepImageQueueState.sequence += 1;

  return {
    id: `imgq_${Date.now()}_${seekdeepImageQueueState.sequence}`,
    source,
    userId: String(userId || ''),
    channelId: String(channelId || ''),
    prompt: String(prompt || ''),
    width: Number(width || 1024),
    height: Number(height || 1024),
    seed: seed ?? null,
    enqueuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
}

function seekdeepImageQueueJobLine(job) {
  if (!job) return 'none';

  return `${job.id} - ${seekdeepShortQueuePrompt(job.prompt)}`;
}

function seekdeepShortQueuePrompt(value, max = 90) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text || '(empty prompt)';
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function seekdeepImageQueueWaitSeconds(job) {
  const startedAt = Number(job?.startedAt || Date.now());
  const enqueuedAt = Number(job?.enqueuedAt || startedAt);
  return (Math.max(0, startedAt - enqueuedAt) / 1000).toFixed(2);
}

function seekdeepImageQueueRunSeconds(job) {
  const startedAt = Number(job?.startedAt || Date.now());
  const end = Number(job?.finishedAt || Date.now());
  return (Math.max(0, end - startedAt) / 1000).toFixed(2);
}

function seekdeepImageQueueAckText(job, position) {
  const active = seekdeepImageQueueState.active;
  const lines = [
    position <= 1 ? 'Image generation started.' : 'Image generation queued.',
    `Queue Position: ${position}`,
    `Job ID: ${job.id}`,
    `Prompt: ${seekdeepShortQueuePrompt(job.prompt, 160)}`,
  ];

  if (active) {
    lines.push(`Currently Running: ${seekdeepImageQueueJobLine(active)}`);
  }

  lines.push(`Pending Jobs: ${seekdeepImageQueueState.pending.length}`);

  return lines.join('\n');
}

function seekdeepImageQueueStatusText() {
  const pending = seekdeepImageQueueState.pending || [];
  const active = seekdeepImageQueueState.active;

  const lines = [
    'Image generation queue',
    '',
    `Active Job: ${active ? seekdeepImageQueueJobLine(active) : 'none'}`,
    `Pending Jobs: ${pending.length}`,
    `Completed Since Last Reboot: ${seekdeepImageQueueState.completed || 0}`,
    `Failed Since Last Reboot: ${seekdeepImageQueueState.failed || 0}`,
    `Cooldown: ${SEEKDEEP_IMAGE_COOLDOWN_MS ? `${(SEEKDEEP_IMAGE_COOLDOWN_MS / 1000).toFixed(0)}s per user` : 'off'}`,
  ];

  if (pending.length) {
    lines.push('', 'Pending:');
    pending.slice(0, 10).forEach((entry, index) => {
      lines.push(`${index + 1}. ${seekdeepImageQueueJobLine(entry.job)}`);
    });
  }

  return lines.join('\n');
}

async function seekdeepPumpImageQueue() {
  if (seekdeepImageQueueState.active) return;

  const entry = seekdeepImageQueueState.pending.shift();
  if (!entry) return;

  seekdeepImageQueueState.active = entry.job;
  entry.job.startedAt = Date.now();

  try {
    const result = await entry.runner(entry.job);
    seekdeepImageQueueState.completed += 1;
    entry.resolve(result);
  } catch (err) {
    seekdeepImageQueueState.failed += 1;
    entry.reject(err);
  } finally {
    entry.job.finishedAt = Date.now();
    seekdeepImageQueueState.active = null;

    if (typeof setImmediate === 'function') {
      setImmediate(() => { void seekdeepPumpImageQueue(); });
    } else {
      setTimeout(() => { void seekdeepPumpImageQueue(); }, 0);
    }
  }
}


// SEEKDEEP_VISIBLE_REFINED_PROMPT_START
function seekdeepClipForDiscord(value = '', max = 900) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function seekdeepRefinedPromptLine(originalPrompt = '', refinedPrompt = '') {
  const original = String(originalPrompt || '').trim();
  const refined = String(refinedPrompt || '').trim();

  if (!refined || refined === original) return '';

  return `Refined Prompt: ${seekdeepClipForDiscord(refined, 900)}`;
}
// SEEKDEEP_VISIBLE_REFINED_PROMPT_END


// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START
function seekdeepExtractRefinedPrompt(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    const values = [
      candidate.refined_prompt,
      candidate.refinedPrompt,
      candidate.original_refined_prompt,
      candidate.originalRefinedPrompt,
      candidate.used_prompt,
      candidate.usedPrompt,
    ];

    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
  }

  return '';
}
// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END


// SEEKDEEP_IMAGE_COOLDOWN_ROUTE_NOTIFY_START
async function seekdeepReplyImageCooldownRemaining(source, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;

  const content = seekdeepAppendResponseFooter(baseText, {
    startedAt: source?.__seekdeepRequestStartedAt,
    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
  });

  if (typeof source?.reply === 'function') {
    try {
      return await source.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Cooldown reply failed:', err?.message || err);
    }
  }

  if (source?.channel && typeof source.channel.send === 'function') {
    try {
      return await source.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Cooldown channel fallback failed:', err?.message || err);
    }
  }

  return null;
}
// SEEKDEEP_IMAGE_COOLDOWN_ROUTE_NOTIFY_END


// SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_START
function seekdeepStopTypingSafelyForMessage(message) {
  try {
    if (typeof stopSeekDeepTypingLoopForMessage === 'function') {
      stopSeekDeepTypingLoopForMessage(message);
    }
  } catch (err) {
    console.warn('Could not stop typing loop for cooldown notice:', err?.message || err);
  }
}

async function seekdeepSendImageCooldownNotice(message, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const fallbackText = `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : fallbackText;

  const modelUsed = typeof seekdeepNoModelLabel === 'function'
    ? seekdeepNoModelLabel()
    : 'local command (no AI model)';

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(baseText || fallbackText, {
        startedAt: message?.__seekdeepRequestStartedAt,
        modelUsed,
      })
    : `${baseText || fallbackText}\n\nModel Used: ${modelUsed}`;

  seekdeepStopTypingSafelyForMessage(message);

  try {
    if (message && typeof message.reply === 'function') {
      const sent = await message.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
      seekdeepStopTypingSafelyForMessage(message);
      return sent;
    }
  } catch (err) {
    console.warn('Cooldown message.reply failed; trying channel.send:', err?.message || err);
  }

  try {
    if (message?.channel && typeof message.channel.send === 'function') {
      const sent = await message.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
      seekdeepStopTypingSafelyForMessage(message);
      return sent;
    }
  } catch (err) {
    console.warn('Cooldown channel.send fallback failed:', err?.message || err);
  }

  seekdeepStopTypingSafelyForMessage(message);
  return null;
}
// SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_END


// SEEKDEEP_REGENERATE_COOLDOWN_NOTICE_START
async function seekdeepSendRegenerateCooldownNotice(source, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;

  const modelUsed = typeof seekdeepNoModelLabel === 'function'
    ? seekdeepNoModelLabel()
    : 'local command (no AI model)';

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(baseText, {
        startedAt: source?.__seekdeepRequestStartedAt,
        modelUsed,
      })
    : `${baseText}\n\nModel Used: ${modelUsed}`;

  try {
    if (typeof stopSeekDeepTypingLoopForMessage === 'function' && source?.author) {
      stopSeekDeepTypingLoopForMessage(source);
    }
  } catch {}

  if (typeof source?.reply === 'function') {
    try {
      return await source.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Regenerate cooldown reply failed:', err?.message || err);
    }
  }

  if (typeof source?.followUp === 'function') {
    try {
      return await source.followUp(seekdeepEphemeralPayload({
        content,
      }));
    } catch (err) {
      console.warn('Regenerate cooldown interaction followUp failed:', err?.message || err);
    }
  }

  if (typeof source?.editReply === 'function') {
    try {
      return await source.editReply({
        content,
      });
    } catch (err) {
      console.warn('Regenerate cooldown interaction editReply failed:', err?.message || err);
    }
  }

  if (source?.channel && typeof source.channel.send === 'function') {
    try {
      return await source.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Regenerate cooldown channel fallback failed:', err?.message || err);
    }
  }

  return null;
}

function seekdeepRegenerateCooldownUserId(source) {
  return String(source?.author?.id || source?.user?.id || source?.member?.user?.id || 'unknown').trim() || 'unknown';
}
// SEEKDEEP_REGENERATE_COOLDOWN_NOTICE_END


// SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_START
function seekdeepIsRegenerateImageJob(job = {}) {
  const values = [
    job.source,
    job.type,
    job.kind,
    job.action,
    job.actionType,
    job.command,
    job.reason,
    job.id,
  ].map((value) => String(value || '').toLowerCase());

  return values.some((value) => /\b(?:regenerate|regen|reroll|redo)\b/.test(value));
}

function seekdeepCooldownUserIdFromJob(job = {}) {
  return String(
    job.userId ||
    job.user?.id ||
    job.author?.id ||
    job.member?.user?.id ||
    job.interaction?.user?.id ||
    job.interaction?.member?.user?.id ||
    job.message?.author?.id ||
    job.sourceMessage?.author?.id ||
    job.requestMessage?.author?.id ||
    job.ownerId ||
    'unknown'
  ).trim() || 'unknown';
}

function seekdeepCooldownSourceFromJob(job = {}) {
  return job.interaction || job.sourceInteraction || job.buttonInteraction || job.message || job.sourceMessage || job.requestMessage || null;
}

async function seekdeepNotifyRegenerateJobCooldown(job = {}, remainingMs = 0) {
  const source = seekdeepCooldownSourceFromJob(job);
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;

  const modelUsed = typeof seekdeepNoModelLabel === 'function'
    ? seekdeepNoModelLabel()
    : 'local command (no AI model)';

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(baseText, {
        startedAt: source?.__seekdeepRequestStartedAt || job.enqueuedAt || Date.now(),
        modelUsed,
      })
    : `${baseText}\n\nModel Used: ${modelUsed}`;

  try {
    if (source && typeof source.reply === 'function') {
      return await source.reply(seekdeepMaybeEphemeralPayload(source, {
        content,
        allowedMentions: { repliedUser: false },
      }));
    }
  } catch (err) {
    console.warn('Regenerate cooldown source.reply failed:', err?.message || err);
  }

  try {
    if (source && typeof source.followUp === 'function') {
      return await source.followUp(seekdeepEphemeralPayload({
        content,
      }));
    }
  } catch (err) {
    console.warn('Regenerate cooldown source.followUp failed:', err?.message || err);
  }

  try {
    if (source && typeof source.editReply === 'function') {
      return await source.editReply({
        content,
      });
    }
  } catch (err) {
    console.warn('Regenerate cooldown source.editReply failed:', err?.message || err);
  }

  try {
    if (source?.channel && typeof source.channel.send === 'function') {
      return await source.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
    }
  } catch (err) {
    console.warn('Regenerate cooldown channel fallback failed:', err?.message || err);
  }

  console.warn(`Regenerate cooldown blocked job ${job?.id || '(unknown id)'} for ${remainingSeconds}s, but no reply target was available.`);
  return null;
}
// SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_END

function seekdeepEnqueueImageJob(job, runner) {
  // SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_START
  if (seekdeepIsRegenerateImageJob(job)) {
    const seekdeepRegenCooldownUserId = seekdeepCooldownUserIdFromJob(job);
    const seekdeepRegenCooldownRemaining = seekdeepImageCooldownRemaining(seekdeepRegenCooldownUserId);

    if (seekdeepRegenCooldownRemaining > 0) {
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute('regenerate-cooldown', String(job?.source || job?.id || 'regenerate-job'));
      }

      Promise.resolve(seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining))
        .catch((err) => console.warn('Regenerate cooldown notification failed:', err?.message || err));
      return null;
    }
  }
  // SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_END


  if (!job || typeof runner !== 'function') {
    throw new Error('Invalid image queue job.');
  }

  return new Promise((resolve, reject) => {
    seekdeepImageQueueState.pending.push({ job, runner, resolve, reject });
    void seekdeepPumpImageQueue();
  });
}

function seekdeepImageCooldownText(remainingMs) {
  return [
    'Image generation cooldown is active.',
    `Try again in ${(Math.max(0, Number(remainingMs || 0)) / 1000).toFixed(1)} seconds.`,
  ].join('\n');
}
// SEEKDEEP_IMAGE_QUEUE_END

async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {
  prompt = seekdeepGroundBotanicalSlangPrompt(prompt);

  const requestStartedAt = seekdeepNowMs();

  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START
  const seekdeepImageModeOptions = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };
  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  if (typeof seekdeepExtractImagePrompt === 'function') {
    const seekdeepExtractedSendPrompt = seekdeepExtractImagePrompt(prompt);
    if (seekdeepExtractedSendPrompt) prompt = seekdeepExtractedSendPrompt;
  }
  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);
  const seekdeepSuppressQueueAck = Boolean(seekdeepImageModeOptions.silentAck || seekdeepImageModeOptions.suppressQueueAck);
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_END



  // SEEKDEEP_GENERIC_IMAGE_CONTEXT_RESOLUTION_START
  const seekdeepResolvedImagePrompt = seekdeepResolveImagePromptFromContext(message, prompt);
  if (seekdeepResolvedImagePrompt.missingContext) {
    const pendingSubjectInfo = typeof seekdeepRememberPendingImageSubjectRequest === 'function'
      ? seekdeepRememberPendingImageSubjectRequest(message, { width, height, seed, imageModeOptions: seekdeepImageModeOptions })
      : null;

    if (pendingSubjectInfo?.alreadyPending && seekdeepSuppressQueueAck) return null;

    seekdeepStopTypingSafelyForMessage(message);
    try {
      return await message.reply({
        content: seekdeepAppendResponseFooter('What should I generate an image of?', {
          startedAt: requestStartedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        allowedMentions: { repliedUser: false },
      });
    } finally {
      seekdeepStopTypingSafelyForMessage(message);
    }
  }
  if (seekdeepResolvedImagePrompt.resolvedFromContext) {
    console.log(`[SeekDeep] image prompt context reused: ${prompt} -> ${seekdeepResolvedImagePrompt.prompt}`);
  }
  prompt = seekdeepResolvedImagePrompt.prompt;
  // SEEKDEEP_GENERIC_IMAGE_CONTEXT_RESOLUTION_END

  const userId = message?.author?.id || 'unknown';
  const cooldown = seekdeepImageCooldownRemaining(userId);

  if (!seekdeepSkipImageCooldown && cooldown > 0) {
    return await message.reply({
      content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(cooldown), {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  if (!seekdeepSkipImageCooldown) seekdeepRememberImageCooldown(userId);

  const workingLoop = seekdeepStartWorkingLoop(message?.channel, `image:${message?.id || prompt}`);
  const position = seekdeepImageQueueCurrentPosition();
  const job = seekdeepCreateImageQueueJob({
    source: 'message',
    userId,
    channelId: message?.channel?.id || '',
    prompt,
    width,
    height,
    seed,
  });

  const startNotice = seekdeepImageQueueAckText(job, position);

  if (!seekdeepSuppressQueueAck) {
    try {
      await message.reply({
        content: seekdeepAppendResponseFooter(startNotice, {
          startedAt: job.enqueuedAt || requestStartedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Could not send image queue acknowledgement; falling back to channel.send:', err?.message || err);

      try {
        if (message?.channel && typeof message.channel.send === 'function') {
          await message.channel.send({
            content: seekdeepAppendResponseFooter(startNotice, {
              startedAt: job.enqueuedAt || requestStartedAt,
              modelUsed: seekdeepNoModelLabel(),
            }),
            allowedMentions: { repliedUser: false },
          });
        }
      } catch (fallbackErr) {
        console.warn('Could not send fallback image queue acknowledgement:', fallbackErr?.message || fallbackErr);
      }
    }
  }

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
    try {
      const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);
      const normalized = seekdeepNormalizeGeneratedImageResult(result);
      const actionId = seekdeepMakeImageActionId();

      const state = seekdeepRememberTempImageState({
          id: actionId,
          prompt,
          originalPrompt: seekdeepImageModeOptions.cleanPrompt || prompt,
          refinedPrompt: result.refinedPrompt || prompt,
          generationPrompt: result.generationPrompt || result.refinedPrompt || prompt,
          dynamicRefinement: Boolean(result.promptRefined && result.imageOptions?.dynamicRefinement),
          dynamicRefinementAttempted: Boolean(result.imageOptions?.dynamicRefinementAttempted || result.dynamicRefinementAttempted),
          width,
          height,
          seed,
          refine: seekdeepImageModeOptions.refine !== false,
          ground: seekdeepImageModeOptions.ground !== false,
          imageModeOptions: {
            refine: seekdeepImageModeOptions.refine !== false,
            ground: seekdeepImageModeOptions.ground !== false,
            dynamicRefinement: Boolean(result.promptRefined && result.imageOptions?.dynamicRefinement),
            dynamicRefinementAttempted: Boolean(result.imageOptions?.dynamicRefinementAttempted || result.dynamicRefinementAttempted),
          },
        filename: normalized.filename,
        buffer: normalized.buffer,
        mimeType: 'image/png',
        createdAt: Date.now(),
        expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
      });

      const content = seekdeepAppendResponseFooter([
        `Generated: ${prompt}`,
        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(typeof result !== 'undefined' ? result : undefined, typeof imageResult !== 'undefined' ? imageResult : undefined, typeof data !== 'undefined' ? data : undefined, typeof payload !== 'undefined' ? payload : undefined, typeof normalized !== 'undefined' ? normalized : undefined)),
        seekdeepRefinedPromptLine(prompt, typeof refinedPrompt !== 'undefined' ? refinedPrompt : (typeof imagePrompt !== 'undefined' ? imagePrompt : '')),
        seekdeepGroundingStatusLine(result?.grounding, result?.imageOptions),
        seekdeepRefinementStatusLine(result?.refinementEnabled !== false, result?.imageOptions?.dynamicRefinement, result?.imageOptions?.dynamicRefinementAttempted || result?.dynamicRefinementAttempted),
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
        `Job ID: ${runningJob.id}`,
      ].filter(Boolean).join('\n'), {
        startedAt: runningJob.startedAt,
        modelUsed: seekdeepImageModelLabel(),
      });

      let sent = null;

      try {
        sent = await message.reply({
          content,
          files: [normalized.attachment],
          components: seekdeepImageActionComponents(actionId),
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        // SEEKDEEP_EXPLICIT_CONTENT_MESSAGE_FALLBACK_START
        if (seekdeepIsDiscordExplicitContentBlock(err)) {
          console.warn('Discord blocked generated image attachment for this message; sending text-only notice.');

          try {
            sent = await message.reply({
              content: seekdeepAppendResponseFooter(seekdeepExplicitContentBlockedText(), {
                startedAt: runningJob.startedAt,
                modelUsed: seekdeepImageModelLabel(),
              }),
              allowedMentions: { repliedUser: false },
            });
          } catch (fallbackErr) {
            console.warn('Could not send explicit-content fallback reply:', fallbackErr?.message || fallbackErr);
          }

          return sent;
        }
        // SEEKDEEP_EXPLICIT_CONTENT_MESSAGE_FALLBACK_END

        console.warn('Image result reply failed; falling back to channel.send:', err?.message || err);

        if (message?.channel && typeof message.channel.send === 'function') {
          sent = await message.channel.send({
            content,
            files: [normalized.attachment],
            components: seekdeepImageActionComponents(actionId),
            allowedMentions: { repliedUser: false },
          });
        } else {
          throw err;
        }
      }

      try {
        sent = await seekdeepAttachDownloadButton(sent, state.id);
      } catch (err) {
        console.warn('Could not attach Download button after image generation:', err?.message || err);
      }

      return sent;
    } finally {
      seekdeepStopWorkingLoop(workingLoop);
      stopSeekDeepTypingLoopForMessage(message);
    }
  });
}

async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {
  prompt = seekdeepGroundBotanicalSlangPrompt(prompt);

  const requestStartedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();

  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_START
  const seekdeepImageModeOptions = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };
  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);
  const seekdeepSuppressQueueAck = Boolean(seekdeepImageModeOptions.silentAck || seekdeepImageModeOptions.suppressQueueAck);
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_END


  // SEEKDEEP_INTERACTION_IMAGE_MODE_OPTIONS_START
  // SEEKDEEP_INTERACTION_IMAGE_MODE_OPTIONS_END
  const userId = interaction?.user?.id || 'unknown';
  const cooldown = seekdeepImageCooldownRemaining(userId);

  if (!seekdeepSkipImageCooldown && cooldown > 0) {
    return await safeEditOrReply(interaction, {
      content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(cooldown), {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  if (!seekdeepSkipImageCooldown) seekdeepRememberImageCooldown(userId);

  const workingLoop = seekdeepStartWorkingLoop(interaction?.channel, `slash-image:${interaction?.id || prompt}`);
  const position = seekdeepImageQueueCurrentPosition();
  const job = seekdeepCreateImageQueueJob({
    source: 'slash',
    userId,
    channelId: interaction?.channel?.id || '',
    prompt,
    width,
    height,
    seed,
  });

  if (!seekdeepSuppressQueueAck) {
    await safeEditOrReply(interaction, {
      content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
        startedAt: job.enqueuedAt || requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
    try {
      const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);
      const normalized = seekdeepNormalizeGeneratedImageResult(result);
      const actionId = seekdeepMakeImageActionId();

      const state = seekdeepRememberTempImageState({
          id: actionId,
          prompt,
          originalPrompt: seekdeepImageModeOptions.cleanPrompt || prompt,
          refinedPrompt: result.refinedPrompt || prompt,
          generationPrompt: result.generationPrompt || result.refinedPrompt || prompt,
          dynamicRefinement: Boolean(result.promptRefined && result.imageOptions?.dynamicRefinement),
          dynamicRefinementAttempted: Boolean(result.imageOptions?.dynamicRefinementAttempted || result.dynamicRefinementAttempted),
          width,
          height,
          seed,
          refine: seekdeepImageModeOptions.refine !== false,
          ground: seekdeepImageModeOptions.ground !== false,
          imageModeOptions: {
            refine: seekdeepImageModeOptions.refine !== false,
            ground: seekdeepImageModeOptions.ground !== false,
            dynamicRefinement: Boolean(result.promptRefined && result.imageOptions?.dynamicRefinement),
            dynamicRefinementAttempted: Boolean(result.imageOptions?.dynamicRefinementAttempted || result.dynamicRefinementAttempted),
          },
        filename: normalized.filename,
        buffer: normalized.buffer,
        mimeType: 'image/png',
        createdAt: Date.now(),
        expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
      });

      const content = seekdeepAppendResponseFooter([
        `Generated: ${prompt}`,
        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(result, normalized)),
        seekdeepGroundingStatusLine(result?.grounding, result?.imageOptions),
        seekdeepRefinementStatusLine(result?.refinementEnabled !== false, result?.imageOptions?.dynamicRefinement, result?.imageOptions?.dynamicRefinementAttempted || result?.dynamicRefinementAttempted),
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
        `Job ID: ${runningJob.id}`,
      ].filter(Boolean).join('\n'), {
        startedAt: runningJob.startedAt,
        modelUsed: seekdeepImageModelLabel(),
      });

      let sent = await safeEditOrReply(interaction, {
        content,
        files: [normalized.attachment],
        components: seekdeepImageActionComponents(state.id),
        allowedMentions: { repliedUser: false },
      });

      if (!sent && typeof interaction.fetchReply === 'function') {
        sent = await interaction.fetchReply().catch(() => null);
      }

      return await seekdeepAttachDownloadButton(sent, state.id);
    } finally {
      seekdeepStopWorkingLoop(workingLoop);
    }
  });
}


// SEEKDEEP_TEXT_REGENERATE_START
function seekdeepIsTextRegenerateImagePrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return false;

  return /^(?:regenerate|regen|reroll|redo)$/i.test(p) ||
    /^(?:regenerate|regen|reroll|redo)\s+(?:the\s+)?(?:last\s+)?(?:image|picture|pic|generation|generated\s+image|one|that|this)\b/i.test(p);
}

function seekdeepLatestTempImageStateForRegenerate() {
  try {
    if (typeof seekdeepSweepExpiredImageCache === 'function') {
      seekdeepSweepExpiredImageCache();
    }
  } catch (err) {
    console.warn('Could not sweep image cache before text regenerate:', err?.message || err);
  }

  const now = Date.now();
  const candidates = [];
  const seen = new Set();

  try {
    if (typeof seekdeepTempImageStateIndex !== 'undefined' && seekdeepTempImageStateIndex?.entries) {
      for (const [id, state] of seekdeepTempImageStateIndex.entries()) {
        const key = String(id || state?.id || '').trim();
        if (!key || seen.has(key)) continue;
        if (Number(state?.expiresAt || 0) && Number(state.expiresAt || 0) <= now) continue;
        if (!String(state?.prompt || '').trim()) continue;
        seen.add(key);
        candidates.push({ id: key, createdAt: Number(state?.createdAt || 0) || 0 });
      }
    }
  } catch (err) {
    console.warn('Could not inspect live image cache before text regenerate:', err?.message || err);
  }

  try {
    if (typeof seekdeepReadTempImageCacheMetadata === 'function') {
      for (const meta of seekdeepReadTempImageCacheMetadata()) {
        const key = String(meta?.id || '').trim();
        if (!key || seen.has(key)) continue;
        if (Number(meta?.expiresAt || 0) && Number(meta.expiresAt || 0) <= now) continue;
        if (!String(meta?.prompt || '').trim()) continue;
        seen.add(key);
        candidates.push({ id: key, createdAt: Number(meta?.createdAt || meta?.__stat?.mtimeMs || 0) || 0 });
      }
    }
  } catch (err) {
    console.warn('Could not inspect disk image cache before text regenerate:', err?.message || err);
  }

  candidates.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  for (const candidate of candidates) {
    try {
      const state = seekdeepLoadTempImageState(candidate.id);
      if (state && String(state.prompt || '').trim()) return state;
    } catch (err) {
      console.warn(`Could not load cached image state for text regenerate (${candidate.id}):`, err?.message || err);
    }
  }

  return null;
}

async function seekdeepRegenerateLatestImageFromMessage(message) {
  // SEEKDEEP_REGENERATE_TEXT_COOLDOWN_START
  const seekdeepRegenUserId = seekdeepRegenerateCooldownUserId(message);
  const seekdeepRegenCooldownRemaining = seekdeepImageCooldownRemaining(seekdeepRegenUserId);
  if (seekdeepRegenCooldownRemaining > 0) {
    if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('regenerate-cooldown', 'regenerate');
    await seekdeepSendRegenerateCooldownNotice(message, seekdeepRegenCooldownRemaining);
    return null;
  }
  // SEEKDEEP_REGENERATE_TEXT_COOLDOWN_END


  const requestStartedAt = message?.__seekdeepRequestStartedAt || seekdeepNowMs();
  const state = seekdeepLatestTempImageStateForRegenerate();

  if (!state) {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    stopSeekDeepTypingLoopForMessage(message);
    return await message.reply({
      content: seekdeepAppendResponseFooter('No recent cached image was found to regenerate. Generate a new image first, then use `regenerate`.', {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  const prompt = String(state.prompt || '').trim();
  const width = Number(state.width || 1024) || 1024;
  const height = Number(state.height || 1024) || 1024;
  const seed = state.seed ?? null;
  const userId = message?.author?.id || 'unknown';
  const workingLoop = seekdeepStartWorkingLoop(message?.channel, `regen-message:${message?.id || state.id || prompt}`);
  const position = seekdeepImageQueueCurrentPosition();
  const job = seekdeepCreateImageQueueJob({
    source: 'message-regenerate',
    message,
    userId,
    channelId: message?.channel?.id || '',
    prompt,
    width,
    height,
    seed,
  });

  await message.reply({
    content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
      startedAt: job.enqueuedAt || requestStartedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    allowedMentions: { repliedUser: false },
  });

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
    try {
      const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);
      const normalized = seekdeepNormalizeGeneratedImageResult(result);
      const newActionId = seekdeepMakeImageActionId();

      const newState = seekdeepRememberTempImageState({
        id: newActionId,
        prompt,
        originalPrompt: state.originalPrompt || prompt,
        refinedPrompt: result.refinedPrompt || prompt,
        generationPrompt: result.generationPrompt || result.refinedPrompt || prompt,
        dynamicRefinement: Boolean(result.promptRefined && result.imageOptions?.dynamicRefinement),
        width,
        height,
        seed,
        refine: seekdeepImageModeOptions.refine !== false,
        ground: seekdeepImageModeOptions.ground !== false,
        imageModeOptions: {
          refine: seekdeepImageModeOptions.refine !== false,
          ground: seekdeepImageModeOptions.ground !== false,
          dynamicRefinement: Boolean(result.promptRefined && result.imageOptions?.dynamicRefinement),
        },
        filename: normalized.filename,
        buffer: normalized.buffer,
        mimeType: 'image/png',
        createdAt: Date.now(),
        expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
      });

      const content = seekdeepAppendResponseFooter([
        `Regenerated locally: ${prompt}`,
        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(typeof result !== 'undefined' ? result : undefined, typeof imageResult !== 'undefined' ? imageResult : undefined, typeof data !== 'undefined' ? data : undefined, typeof payload !== 'undefined' ? payload : undefined, typeof normalized !== 'undefined' ? normalized : undefined)),
        seekdeepRefinedPromptLine(prompt, typeof refinedPrompt !== 'undefined' ? refinedPrompt : (typeof imagePrompt !== 'undefined' ? imagePrompt : '')),
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
        `Job ID: ${runningJob.id}`,
      ].filter(Boolean).join('\n'), {
        startedAt: runningJob.startedAt,
        modelUsed: seekdeepImageModelLabel(),
      });

      let sent = null;

      try {
        sent = await message.reply({
          content,
          files: [normalized.attachment],
          components: seekdeepImageActionComponents(newState.id),
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        console.warn('Text regenerate result reply failed; falling back to channel.send:', err?.message || err);

        if (message?.channel && typeof message.channel.send === 'function') {
          sent = await message.channel.send({
            content,
            files: [normalized.attachment],
            components: seekdeepImageActionComponents(newState.id),
            allowedMentions: { repliedUser: false },
          });
        } else {
          throw err;
        }
      }

      try {
        sent = await seekdeepAttachDownloadButton(sent, newState.id);
      } catch (err) {
        console.warn('Could not attach Download button after text regenerate:', err?.message || err);
      }

      return sent;
    } finally {
      seekdeepStopWorkingLoop(workingLoop);
      stopSeekDeepTypingLoopForMessage(message);
    }
  });
}
// SEEKDEEP_TEXT_REGENERATE_END


function seekdeepRegenerateModeOptions(mode = 'submitted', action = null) {
  const normalized = String(mode || 'submitted').toLowerCase();
  const basePrompt = action?.originalPrompt || action?.prompt || action?.rawPrompt || 'image';
  const existingRefinedPrompt = normalizeUserText(action?.generationPrompt || action?.refinedPrompt || '').trim();
  const base = {
    ground: action?.ground !== false && action?.imageModeOptions?.ground !== false,
    cleanPrompt: basePrompt,
    silentAck: true,
    skipCooldown: true,
  };

  if (normalized === 'original' || normalized === 'raw') {
    return { ...base, refine: false };
  }

  if (normalized === 'refined') {
    return {
      ...base,
      refine: true,
      ...(existingRefinedPrompt ? {
        preRefinedPrompt: existingRefinedPrompt,
        dynamicRefinement: Boolean(action?.dynamicRefinement || action?.imageModeOptions?.dynamicRefinement),
      } : {}),
    };
  }

  const originallyRaw =
    action?.refine === false ||
    action?.refinement === false ||
    action?.refinementMode === 'off' ||
    action?.imageModeOptions?.refine === false;

  return {
    ...base,
    refine: !originallyRaw,
    ...(!originallyRaw && existingRefinedPrompt ? {
      preRefinedPrompt: existingRefinedPrompt,
      dynamicRefinement: Boolean(action?.dynamicRefinement || action?.imageModeOptions?.dynamicRefinement),
    } : {}),
  };
}

// SEEKDEEP_ARCHIVE_CHANNEL_CONFIG_START
const SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH = path.join(__dirname, 'data', 'archive-guild-config.json');

function seekdeepReadArchiveGuildConfig() {
  try {
    if (!fs.existsSync(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH)) return { guilds: {} };
    const parsed = JSON.parse(fs.readFileSync(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { guilds: {} };
    if (!parsed.guilds || typeof parsed.guilds !== 'object') parsed.guilds = {};
    return parsed;
  } catch (err) {
    console.warn('SeekDeep archive guild config read failed:', err?.message || err);
    return { guilds: {} };
  }
}

function seekdeepWriteArchiveGuildConfig(config) {
  try {
    const safe = config && typeof config === 'object' ? config : { guilds: {} };
    if (!safe.guilds || typeof safe.guilds !== 'object') safe.guilds = {};
    fs.mkdirSync(path.dirname(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH, JSON.stringify(safe, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.warn('SeekDeep archive guild config write failed:', err?.message || err);
    return false;
  }
}

function seekdeepGetArchiveChannelIdForGuild(guildId = '') {
  const id = String(guildId || '').trim();
  if (!id) return '';
  const config = seekdeepReadArchiveGuildConfig();
  return String(config.guilds?.[id]?.archiveChannelId || '').trim();
}

function seekdeepSetArchiveChannelIdForGuild(guildId = '', channelId = '', configuredBy = '') {
  const gid = String(guildId || '').trim();
  const cid = String(channelId || '').trim();
  if (!gid || !cid) return false;
  const config = seekdeepReadArchiveGuildConfig();
  if (!config.guilds || typeof config.guilds !== 'object') config.guilds = {};
  config.guilds[gid] = {
    archiveChannelId: cid,
    configuredBy: String(configuredBy || ''),
    configuredAt: new Date().toISOString(),
  };
  return seekdeepWriteArchiveGuildConfig(config);
}

function seekdeepArchiveRequiredPermissionNames() {
  return ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'AttachFiles', 'ReadMessageHistory'];
}

function seekdeepArchiveChannelPermissionReport(channel, guild) {
  const missing = [];
  try {
    const botMember = guild?.members?.me || guild?.members?.cache?.get?.(guild?.client?.user?.id);
    const perms = channel?.permissionsFor?.(botMember);
    for (const name of seekdeepArchiveRequiredPermissionNames()) {
      if (!perms || !perms.has(name)) missing.push(name);
    }
  } catch {
    missing.push(...seekdeepArchiveRequiredPermissionNames());
  }
  return { ok: missing.length === 0, missing };
}

function seekdeepHasArchiveConfigPermissionFromContext(context) {
  try {
    const perms = context?.member?.permissions || context?.message?.member?.permissions;
    if (!perms) return false;
    return perms.has('Administrator') || perms.has('ManageGuild') || perms.has('ManageChannels');
  } catch {
    return false;
  }
}

function seekdeepHasArchiveConfigPermission(message) {
  return seekdeepHasArchiveConfigPermissionFromContext(message);
}

function seekdeepArchiveSetupPromptText() {
  return [
    '`@SeekDeep archive setup #channel`',
    '`@SeekDeep archive setup here`',
    '`@SeekDeep setup archive here`'
  ].join(' or ');
}

function seekdeepArchiveSetupHelpText(guild = null, context = null) {
  const canConfigure = seekdeepHasArchiveConfigPermissionFromContext(context);
  const required = seekdeepArchiveRequiredPermissionNames().map((name) => '- ' + name).join('\n');
  if (canConfigure) {
    return [
      'Archive storage is not configured for this server yet.',
      'Choose the channel that should hold SeekDeep archive threads, then run:',
      seekdeepArchiveSetupPromptText(),
      '',
      'Required bot permissions in that channel:',
      required,
      '',
      'Setup must be completed before images can be archived.'
    ].join('\n');
  }
  return [
    'Archive storage is not configured for this server yet.',
    'Ask a server admin or someone with Manage Server / Manage Channels to finish setup with:',
    seekdeepArchiveSetupPromptText(),
    '',
    'Setup must be completed before images can be archived.'
  ].join('\n');
}

function seekdeepArchivePermissionHelpText(channel, missing, context = null) {
  const channelText = channel?.id ? '<#' + channel.id + '>' : 'the configured archive channel';
  const missingLines = Array.isArray(missing) && missing.length ? missing.map((name) => '- ' + name).join('\n') : seekdeepArchiveRequiredPermissionNames().map((name) => '- ' + name).join('\n');
  if (seekdeepHasArchiveConfigPermissionFromContext(context)) {
    return [
      'Archive channel is configured, but SeekDeep is missing permissions in ' + channelText + '.',
      'Grant these permissions to the bot role/channel override, then retry:',
      missingLines,
      '',
      'Nothing was archived because Discord thread storage is not ready.'
    ].join('\n');
  }
  return [
    'Archive channel is configured, but SeekDeep is missing permissions in ' + channelText + '.',
    'Ask a server admin to grant these bot permissions:',
    missingLines,
    '',
    'Nothing was archived because Discord thread storage is not ready.'
  ].join('\n');
}

function seekdeepCleanArchiveConfigPrompt(value = '') {
  return String(value || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(/\bseekdeep\b/gi, ' ')
    .replace(/\bseekotics\b/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepIsArchiveConfigPrompt(value = '') {
  const cleaned = seekdeepCleanArchiveConfigPrompt(value).toLowerCase();
  return /^(?:archive\s+(?:setup|configure|config|channel|set\s+channel)|setup\s+archive|configure\s+archive|config\s+archive|set\s+archive\s+channel)(?:\b|$)/i.test(cleaned);
}

function seekdeepExtractArchiveSetupChannel(message, prompt = '') {
  const raw = String(prompt || message?.content || '');
  const mentioned = message?.mentions?.channels?.first?.();
  if (mentioned) return mentioned;
  const mentionMatch = raw.match(/<#(\d+)>/);
  if (mentionMatch) return message?.guild?.channels?.cache?.get?.(mentionMatch[1]) || null;
  const cleaned = seekdeepCleanArchiveConfigPrompt(raw).toLowerCase();
  if (/\b(?:here|this\s+channel)\b/i.test(cleaned)) return message?.channel || null;
  return null;
}

async function seekdeepHandleArchiveConfigMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveConfigPrompt(prompt || message.content || '')) return false;
  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('archive-config-message', prompt || message.content || '');

  if (!message.guild) {
    await message.reply({ content: 'Archive channel setup only works inside a server.', allowedMentions: { repliedUser: false } });
    return true;
  }

  const currentId = seekdeepGetArchiveChannelIdForGuild(message.guild.id);
  const requestedChannel = seekdeepExtractArchiveSetupChannel(message, prompt);

  if (!seekdeepHasArchiveConfigPermission(message)) {
    await message.reply({
      content: ['Only someone with Administrator, Manage Server, or Manage Channels can assign the SeekDeep archive channel.', currentId ? ('Current configured channel: <#' + currentId + '>') : seekdeepArchiveSetupHelpText(message.guild, message)].join('\n'),
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  if (!requestedChannel) {
    await message.reply({
      content: [currentId ? ('Current configured channel: <#' + currentId + '>') : 'No archive channel is configured yet.', 'Admins can assign or change it with ' + seekdeepArchiveSetupPromptText() + '.'].join('\n'),
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  if (!requestedChannel.guild || requestedChannel.guild.id !== message.guild.id || typeof requestedChannel.send !== 'function' || !requestedChannel.threads) {
    await message.reply({ content: 'That target must be a text channel in this server with thread support.', allowedMentions: { repliedUser: false } });
    return true;
  }

  const report = seekdeepArchiveChannelPermissionReport(requestedChannel, message.guild);
  if (!report.ok) {
    await message.reply({
      content: seekdeepArchivePermissionHelpText(requestedChannel, report.missing, message),
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  if (!seekdeepSetArchiveChannelIdForGuild(message.guild.id, requestedChannel.id, message.author?.id || '')) {
    await message.reply({ content: 'Archive channel validation passed, but writing the local config file failed. Check file permissions for `data/archive-guild-config.json`.', allowedMentions: { repliedUser: false } });
    return true;
  }

  const setupLines = [
    'Archive channel assigned for this server: <#' + requestedChannel.id + '>',
  ];

  try {
    if (typeof seekdeepEnsureSharedArchiveThreadForChannel === 'function') {
      const sharedArchive = await seekdeepEnsureSharedArchiveThreadForChannel(requestedChannel, message, {
        source: 'archive-channel-setup',
        reason: 'SeekDeep shared archive thread created during archive channel setup',
      });
      setupLines.push(sharedArchive?.thread?.id
        ? 'Shared archive thread ready: <#' + sharedArchive.thread.id + '>'
        : 'Shared archive thread ready.');
    }
  } catch (err) {
    const reason = String(err?.message || err || 'unknown error').slice(0, 500);
    setupLines.push('Shared archive thread setup failed: ' + reason);
    setupLines.push('Fix the archive channel thread permissions, then run `@SeekDeep archive setup here` again.');
  }

  setupLines.push('Future archives will use this server-assigned channel only.');

  await message.reply({
    content: setupLines.filter(Boolean).join('\n'),
    allowedMentions: { repliedUser: false },
  });
  return true;
}
// SEEKDEEP_ARCHIVE_CHANNEL_CONFIG_END



// SEEKDEEP_ARCHIVE_COIN_THREAD_NAMES_START
const SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH = path.join(__dirname, 'data', 'archive-guild-config.json');
const SEEKDEEP_ARCHIVE_COUNT_SOURCE = 'seekdeep-archive-posts-v3';

function seekdeepArchiveThreadReadConfig() {
  try {
    if (typeof seekdeepReadArchiveGuildConfig === 'function') return seekdeepReadArchiveGuildConfig();
    if (!fs.existsSync(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH)) return { guilds: {} };
    const parsed = JSON.parse(fs.readFileSync(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { guilds: {} };
    if (!parsed.guilds || typeof parsed.guilds !== 'object') parsed.guilds = {};
    return parsed;
  } catch (err) {
    console.warn('SeekDeep archive thread config read failed:', err?.message || err);
    return { guilds: {} };
  }
}

function seekdeepArchiveThreadWriteConfig(config) {
  try {
    if (typeof seekdeepWriteArchiveGuildConfig === 'function') return seekdeepWriteArchiveGuildConfig(config);
    const safe = config && typeof config === 'object' ? config : { guilds: {} };
    if (!safe.guilds || typeof safe.guilds !== 'object') safe.guilds = {};
    fs.mkdirSync(path.dirname(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH, JSON.stringify(safe, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.warn('SeekDeep archive thread config write failed:', err?.message || err);
    return false;
  }
}

function seekdeepArchiveThreadEnsureGuildConfig(config, guildId = '') {
  if (!config.guilds || typeof config.guilds !== 'object') config.guilds = {};
  const gid = String(guildId || '').trim();
  if (!gid) return { userArchives: {} };
  if (!config.guilds[gid] || typeof config.guilds[gid] !== 'object') config.guilds[gid] = {};
  if (!config.guilds[gid].userArchives || typeof config.guilds[gid].userArchives !== 'object') config.guilds[gid].userArchives = {};
  return config.guilds[gid];
}

function seekdeepArchiveThreadClampName(value) {
  const clean = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/@everyone/gi, 'everyone')
    .replace(/@here/gi, 'here')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean || '\u{1FA99} \u2022 Archive \u2022 unknown \u2022 0').slice(0, 96).join('').trim() || '\u{1FA99} \u2022 Archive \u2022 unknown \u2022 0';
}

function seekdeepArchiveThreadDisplayName(subject) {
  subject = subject || {};
  const raw = String(subject.displayName || subject.nickname || subject.globalName || subject.username || subject.user?.globalName || subject.user?.username || subject.id || subject.user?.id || 'unknown')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/@everyone/gi, 'everyone')
    .replace(/@here/gi, 'here')
    .replace(/<#[0-9]+>/g, '')
    .replace(/<@&?[0-9]+>/g, '')
    .replace(/[`*_~|>\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(raw || 'unknown').slice(0, 42).join('').trim() || 'unknown';
}

function seekdeepArchiveThreadCoinEmoji() {
  return seekdeepArchiveThreadClampName(String(process.env.SEEKDEEP_ARCHIVE_THREAD_EMOJI || '\u{1FA99}')).slice(0, 8).trim() || '\u{1FA99}';
}

function seekdeepArchiveThreadBullet() {
  return seekdeepArchiveThreadClampName(String(process.env.SEEKDEEP_ARCHIVE_THREAD_BULLET || '\u2022')).slice(0, 4).trim() || '\u2022';
}

function seekdeepArchiveThreadBuildName(subject, count = 0) {
  const safeCount = Math.max(0, Number(count || 0) || 0);
  const bullet = seekdeepArchiveThreadBullet();
  const parts = [
    seekdeepArchiveThreadCoinEmoji(),
    'Archive',
    seekdeepArchiveThreadDisplayName(subject),
    String(safeCount),
  ];
  return seekdeepArchiveThreadClampName(parts.join(' ' + bullet + ' '));
}

function seekdeepLegacyArchiveUserThreadName(user) {
  user = user || {};
  const username = String(user.username || user.globalName || user.displayName || user.id || 'unknown-user')
    .replace(/[^a-zA-Z0-9_. -]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'unknown-user';
  const idSuffix = user.id ? '-' + String(user.id).slice(-6) : '';
  return ('archive-' + username + idSuffix).slice(0, 90);
}

function seekdeepArchiveThreadGetUserProfile(guildId = '', userId = '') {
  const gid = String(guildId || '').trim();
  const uid = String(userId || '').trim();
  if (!gid || !uid) return {};
  const config = seekdeepArchiveThreadReadConfig();
  const guildConfig = seekdeepArchiveThreadEnsureGuildConfig(config, gid);
  return Object.assign({}, guildConfig.userArchives[uid] || {});
}

function seekdeepArchiveThreadTrustedCount(profile = {}) {
  if (!profile || typeof profile !== 'object') return 0;
  if (profile.countSource !== SEEKDEEP_ARCHIVE_COUNT_SOURCE) return 0;
  return Math.max(0, Number(profile.count || 0) || 0);
}

function seekdeepArchiveThreadHadUntrustedCount(profile = {}) {
  if (!profile || typeof profile !== 'object') return false;
  if (profile.countSource === SEEKDEEP_ARCHIVE_COUNT_SOURCE) return false;
  return profile.count !== undefined || profile.archiveCount !== undefined || profile.totalMessageSent !== undefined || profile.messageCount !== undefined;
}

function seekdeepArchiveThreadSaveUserProfile(guildId = '', userId = '', profile = {}) {
  const gid = String(guildId || '').trim();
  const uid = String(userId || '').trim();
  if (!gid || !uid) return false;
  const config = seekdeepArchiveThreadReadConfig();
  const guildConfig = seekdeepArchiveThreadEnsureGuildConfig(config, gid);
  const existing = guildConfig.userArchives[uid] || {};
  guildConfig.userArchives[uid] = Object.assign({}, existing, profile || {}, { updatedAt: new Date().toISOString() });
  return seekdeepArchiveThreadWriteConfig(config);
}

async function seekdeepArchiveThreadResolveMember(target, user) {
  try {
    const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;
    const userId = String(user?.id || target?.user?.id || target?.author?.id || target?.member?.user?.id || target?.message?.author?.id || '').trim();
    if (!guild || !userId) return null;
    if (target?.member?.user?.id === userId && target.member.displayName) return target.member;
    const cached = guild.members?.cache?.get?.(userId) || null;
    if (cached) return cached;
    if (typeof guild.members?.fetch === 'function') return await guild.members.fetch(userId).catch(() => null);
  } catch {}
  return null;
}

async function seekdeepMaybeRenameArchiveThread(thread, desiredName) {
  try {
    const name = seekdeepArchiveThreadClampName(desiredName);
    if (thread && name && thread.name !== name && typeof thread.setName === 'function') {
      await thread.setName(name, 'SeekDeep archive tracked-count name update');
    }
  } catch (err) {
    console.warn('SeekDeep archive thread rename failed:', err?.message || err);
  }
}

// SEEKDEEP_ARCHIVE_COUNT_BACKFILL_V1_START
function seekdeepArchiveMessageLooksLikeEntry(message = {}, thread = null) {
  const content = String(message?.content || '');
  if (!/SeekDeep Image Archive Entry/i.test(content)) return false;
  if (!/\bRequester\s*:/i.test(content) || !/\bPrompt\s*:/i.test(content)) return false;

  const botId = String(thread?.client?.user?.id || (typeof client !== 'undefined' && client?.user?.id) || '').trim();
  const authorId = String(message?.author?.id || '').trim();
  if (botId && authorId && authorId !== botId) return false;

  return true;
}

async function seekdeepArchiveThreadCountExistingEntries(thread, options = {}) {
  const maxPages = Math.max(1, Math.min(25, Number(options.maxPages || process.env.SEEKDEEP_ARCHIVE_COUNT_BACKFILL_MAX_PAGES || 10)));
  const pageLimit = 100;
  const seen = new Set();
  let before = null;
  let count = 0;
  let scanned = 0;

  if (!thread?.messages || typeof thread.messages.fetch !== 'function') {
    return { count: 0, scanned: 0, ok: false, reason: 'thread messages are not fetchable' };
  }

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const request = before ? { limit: pageLimit, before } : { limit: pageLimit };
      const batch = await thread.messages.fetch(request).catch(() => null);
      const values = Array.from(batch?.values?.() || []);
      if (!values.length) break;

      for (const message of values) {
        const id = String(message?.id || '');
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        scanned += 1;
        if (seekdeepArchiveMessageLooksLikeEntry(message, thread)) count += 1;
      }

      const oldest = values[values.length - 1];
      const nextBefore = String(oldest?.id || '').trim();
      if (!nextBefore || nextBefore === before || values.length < pageLimit) break;
      before = nextBefore;
    }
    return { count, scanned, ok: true };
  } catch (err) {
    return { count: 0, scanned, ok: false, reason: err?.message || String(err) };
  }
}

async function seekdeepArchiveThreadResolveCountFromThread(thread, profile = {}) {
  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function'
    ? seekdeepArchiveThreadTrustedCount(profile)
    : Math.max(0, Number(profile?.count || 0) || 0);
  const scan = await seekdeepArchiveThreadCountExistingEntries(thread);
  if (!scan.ok) return { count: trusted, trusted, scannedCount: 0, scannedMessages: scan.scanned || 0, scanOk: false, reason: scan.reason || '' };
  const resolved = scan.ok ? Math.max(0, Number(scan.count || 0) || 0) : trusted;
  return { count: resolved, trusted, scannedCount: scan.count, scannedMessages: scan.scanned || 0, scanOk: true };
}

function seekdeepArchiveMakeUserTargetFromMessage(message, user) {
  const targetUser = user || message?.author || message?.user || null;
  const member = targetUser?.id && message?.guild?.members?.cache?.get
    ? (message.guild.members.cache.get(targetUser.id) || null)
    : null;
  return {
    guild: message?.guild || null,
    guildId: message?.guild?.id || '',
    channel: message?.channel || null,
    client: message?.client || null,
    message,
    author: targetUser,
    user: targetUser,
    member: member || (targetUser ? { user: targetUser, displayName: targetUser.globalName || targetUser.username || targetUser.id } : null),
  };
}

async function seekdeepFindUserArchiveThreadWithoutCreate(channel, target, user, subject, profile = {}) {
  if (!channel?.threads || !user) return null;

  if (profile?.threadId) {
    let byId = channel.threads?.cache?.get?.(profile.threadId) || null;
    if (!byId && typeof channel.threads?.fetch === 'function') byId = await channel.threads.fetch(profile.threadId).catch(() => null);
    if (byId) {
      if (byId.archived) { try { await byId.setArchived(false, 'SeekDeep archive status/count backfill'); } catch {} }
      return byId;
    }
  }

  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;
  const candidateNames = [];
  const pushName = (name) => {
    const clean = String(name || '').trim();
    if (clean && !candidateNames.includes(clean)) candidateNames.push(clean);
  };

  if (typeof seekdeepArchiveThreadBuildName === 'function') {
    pushName(seekdeepArchiveThreadBuildName(subject, trusted));
    pushName(seekdeepArchiveThreadBuildName(subject, 0));
  }
  if (typeof seekdeepArchiveUserThreadName === 'function') {
    pushName(seekdeepArchiveUserThreadName(subject, trusted));
    pushName(seekdeepArchiveUserThreadName(subject, 0));
  }
  if (typeof seekdeepLegacyArchiveUserThreadName === 'function') pushName(seekdeepLegacyArchiveUserThreadName(user));

  for (const name of candidateNames) {
    const found = typeof seekdeepFindArchiveThread === 'function'
      ? await seekdeepFindArchiveThread(channel, name)
      : null;
    if (found) return found;
  }

  const display = typeof seekdeepArchiveThreadDisplayName === 'function'
    ? seekdeepArchiveThreadDisplayName(subject).toLowerCase()
    : String(user?.username || user?.globalName || user?.id || '').toLowerCase();

  const candidates = [];
  const active = await channel.threads.fetchActive().catch(() => null);
  candidates.push(...Array.from(active?.threads?.values?.() || []));
  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  candidates.push(...Array.from(archivedPublic?.threads?.values?.() || []));

  const fuzzy = candidates.find((candidate) => {
    const name = String(candidate?.name || '').toLowerCase();
    return /archive/i.test(name) && (!display || name.includes(display));
  }) || null;

  if (fuzzy?.archived) { try { await fuzzy.setArchived(false, 'SeekDeep archive status/count backfill'); } catch {} }
  return fuzzy;
}
// SEEKDEEP_ARCHIVE_COUNT_BACKFILL_V1_END

async function seekdeepArchiveThreadRecordPost(archiveInfo, target) {
  archiveInfo = archiveInfo || {};
  const thread = archiveInfo.thread || null;
  const channel = archiveInfo.channel || thread?.parent || null;
  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '';
  const user = archiveInfo.archiveUser || target?.user || target?.author || target?.member?.user || target?.message?.author || null;
  const userId = String(user?.id || '').trim();
  if (!guildId || !userId) return archiveInfo.threadName || thread?.name || '';
  const member = await seekdeepArchiveThreadResolveMember(target, user);
  const subject = member || user;
  const profile = seekdeepArchiveThreadGetUserProfile(guildId, userId);
  let currentCount = seekdeepArchiveThreadTrustedCount(profile);
  if (thread && typeof seekdeepArchiveThreadResolveCountFromThread === 'function') {
    const resolved = await seekdeepArchiveThreadResolveCountFromThread(thread, profile);
    currentCount = resolved.count;
  }
  const nextCount = currentCount + 1;
  const nextName = seekdeepArchiveThreadBuildName(subject, nextCount);
  const savePayload = {
    threadId: thread?.id || profile.threadId || '',
    count: nextCount,
    countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,
    lastNickname: seekdeepArchiveThreadDisplayName(subject),
    lastArchivedAt: new Date().toISOString(),
  };
  if (seekdeepArchiveThreadHadUntrustedCount(profile)) {
    savePayload.legacyUntrustedCount = Number(profile.count || profile.archiveCount || 0) || 0;
    savePayload.legacyUntrustedCountIgnoredAt = new Date().toISOString();
  }
  seekdeepArchiveThreadSaveUserProfile(guildId, userId, savePayload);
  await seekdeepMaybeRenameArchiveThread(thread, nextName);
  return nextName;
}

function seekdeepArchiveCountPromptText(raw = '') {
  const base = String(raw || '')
    .replace(/^(?:\s*(?:<@!?\d+>|<@&\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return base;
}

function seekdeepArchiveIsCountPrompt(raw = '') {
  return /^archive\s+count\b/i.test(seekdeepArchiveCountPromptText(raw));
}

function seekdeepArchiveCanManageOtherCounts(member) {
  try {
    return Boolean(member?.permissions?.has?.('Administrator') || member?.permissions?.has?.('ManageGuild') || member?.permissions?.has?.('ManageChannels'));
  } catch { return false; }
}

async function seekdeepHandleArchiveCountMessage(message, raw = '') {
  if (!message || !seekdeepArchiveIsCountPrompt(raw || message.content || '')) return false;
  if (!message.guild) {
    await message.reply({ content: 'Archive counts only work inside a server.', allowedMentions: { repliedUser: false } });
    return true;
  }
  const text = seekdeepArchiveCountPromptText(raw || message.content || '');
  const targetUser = Array.from(message.mentions?.users?.values?.() || []).find((u) => u?.id && u.id !== message.client?.user?.id) || message.author;
  const isOther = targetUser.id !== message.author.id;
  if (isOther && !seekdeepArchiveCanManageOtherCounts(message.member)) {
    await message.reply({ content: 'Only server admins/managers can change another user\'s archive count.', allowedMentions: { repliedUser: false } });
    return true;
  }
  const setMatch = text.match(/^archive\s+count(?:\s+<@!?\d+>|\s+@\S+)?\s+(?:set\s+)?(\d{1,5})\s*$/i);
  const resetMatch = /^archive\s+count(?:\s+<@!?\d+>|\s+@\S+)?\s+reset\s*$/i.test(text);
  const showOnly = /^archive\s+count(?:\s+<@!?\d+>|\s+@\S+)?\s*$/i.test(text);
  const member = await seekdeepArchiveThreadResolveMember(message, targetUser);
  const subject = member || targetUser;
  const profile = seekdeepArchiveThreadGetUserProfile(message.guild.id, targetUser.id);
  let count = seekdeepArchiveThreadTrustedCount(profile);
  let changed = false;
  if (setMatch) { count = Math.max(0, Number(setMatch[1] || 0) || 0); changed = true; }
  else if (resetMatch) { count = 0; changed = true; }
  else if (!showOnly) {
    await message.reply({ content: 'Use `archive count`, `archive count set 1`, or `archive count reset`. Admins can target a user: `archive count @user set 1`.', allowedMentions: { repliedUser: false } });
    return true;
  }
  let archiveInfo = null;
  try { archiveInfo = await seekdeepGetOrCreateUserArchiveThread(message, targetUser); } catch (err) {
    await message.reply({ content: 'Archive count lookup failed: ' + (err?.message || String(err)), allowedMentions: { repliedUser: false } });
    return true;
  }
  const thread = archiveInfo.thread;
  if (changed) {
    seekdeepArchiveThreadSaveUserProfile(message.guild.id, targetUser.id, {
      threadId: thread?.id || profile.threadId || '',
      count,
      countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,
      lastNickname: seekdeepArchiveThreadDisplayName(subject),
      countManuallySetAt: new Date().toISOString(),
      countManuallySetBy: message.author.id,
    });
  }
  const finalName = seekdeepArchiveThreadBuildName(subject, count);
  await seekdeepMaybeRenameArchiveThread(thread, finalName);
  await message.reply({
    content: [
      changed ? 'Archive count updated.' : 'Archive count.',
      'Thread: ' + (thread?.id ? '<#' + thread.id + '>' : finalName),
      'Name: `' + finalName.replace(/`/g, '\\`') + '`',
      'Tracked archived posts: `' + String(count) + '`',
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });
  return true;
}

async function seekdeepHandleArchiveThreadTitleMessage(message, raw = '') {
  const prompt = String(raw || message?.content || '').trim();
  if (await seekdeepHandleArchiveCountMessage(message, prompt)) return true;
  const cleaned = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? String(seekdeepCleanMessageCommandPrompt(prompt) || '').replace(/\s+/g, ' ').trim().toLowerCase()
    : prompt.replace(/^(?:\s*(?:<@!?\d+>|<@&\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!/^archive\s+(?:thread\s+)?(?:title|name|brand|rename)\b/i.test(cleaned) && !/^archive\s+set\s+(?:thread\s+)?(?:title|name|brand)\b/i.test(cleaned)) return false;
  await message.reply({
    content: ['Archive thread titles are automatic now:', '`\u{1FA99} \u2022 Archive \u2022 current nickname \u2022 tracked archived-post count`', 'Use `archive count set 1` only to repair a corrupted count.'].join('\n'),
    allowedMentions: { repliedUser: false },
  });
  return true;
}
// SEEKDEEP_ARCHIVE_COIN_THREAD_NAMES_END
function seekdeepArchiveChannelName() {
  return String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_NAME || 'seekdeep-archive')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'seekdeep-archive';
}

function seekdeepArchiveUserThreadName(user, count = 0) {
  if (typeof seekdeepArchiveThreadBuildName === 'function') return seekdeepArchiveThreadBuildName(user, count);
  user = user || {};
  const username = String(user.username || user.globalName || user.displayName || user.id || 'unknown-user')
    .replace(/[^a-zA-Z0-9_. -]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'unknown-user';
  return ('\u{1FA99} \u2022 Archive \u2022 ' + username + ' \u2022 ' + (Math.max(0, Number(count || 0) || 0))).slice(0, 90);
}

function seekdeepArchiveMetadataLines(state, target) {
  state = state || {};
  target = target || null;

  const prompt = state.originalPrompt || state.rawPrompt || state.prompt || 'unknown prompt';
  const refinedPrompt = state.refinedPrompt || state.finalPrompt || '';
  const requester = target?.user || target?.author || target?.member?.user || target?.message?.author || null;

  const lines = [
    '**SeekDeep Image Archive Entry**',
    requester?.id ? `Requester: <@${requester.id}>` : '',
    `Prompt: ${String(prompt).slice(0, 1500)}`,
  ];

  if (refinedPrompt && refinedPrompt !== prompt) {
    lines.push(`Refined: ${String(refinedPrompt).slice(0, 1500)}`);
  }

  if (state.jobId) lines.push(`Job ID: ${state.jobId}`);
  if (state.modelUsed || state.model) lines.push(`Model: ${state.modelUsed || state.model}`);
  if (state.seed !== undefined && state.seed !== null) lines.push(`Seed: ${state.seed}`);
  if (state.width && state.height) lines.push(`Size: ${state.width}x${state.height}`);
  lines.push(`Archived: ${new Date().toISOString()}`);

  return lines.filter(Boolean);
}

// SEEKDEEP_ARCHIVE_PERMISSION_UX_START
function seekdeepIsDiscordPermissionError(err = null) {
  const code = String(seekdeepDiscordErrorCode(err));
  const message = String(err?.message || err?.rawError?.message || err || '');
  return code === '50001' || code === '50013' || /missing access|missing permissions/i.test(message);
}

function seekdeepArchivePermissionError(message, cause = null) {
  const err = new Error(message);
  if (cause) err.cause = cause;
  err.code = cause?.code || cause?.rawError?.code || 'SEEKDEEP_ARCHIVE_PERMISSION_REQUIRED';
  err.isSeekDeepArchivePermissionError = true;
  return err;
}

async function seekdeepGetBotGuildMember(guild = null) {
  if (!guild) return null;
  return guild.members?.me || await guild.members?.fetchMe?.().catch(() => null) || null;
}

async function seekdeepAssertCanCreateArchiveChannel(guild = null, wantedName = 'seekdeep-archive') {
  const me = await seekdeepGetBotGuildMember(guild);
  const canManageChannels = Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageChannels));
  if (!canManageChannels) {
    throw seekdeepArchivePermissionError(
      'Archive channel #' + wantedName + ' does not exist and the bot lacks Manage Channels. Create #' + wantedName + ' manually, grant the bot role access, or grant Manage Channels so SeekDeep can create it.'
    );
  }
}

async function seekdeepAssertArchiveChannelPermissions(channel = null, guild = null) {
  if (!channel) return true;
  const me = await seekdeepGetBotGuildMember(guild || channel.guild || null);
  const permissions = me && typeof channel.permissionsFor === 'function'
    ? channel.permissionsFor(me)
    : null;

  if (!permissions || typeof permissions.has !== 'function') return true;

  const required = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Send Messages', PermissionFlagsBits.SendMessages],
    ['Create Public Threads', PermissionFlagsBits.CreatePublicThreads],
    ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads],
    ['Attach Files', PermissionFlagsBits.AttachFiles],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
  ];

  const missing = required
    .filter(([, bit]) => !permissions.has(bit))
    .map(([name]) => name);

  if (missing.length) {
    throw seekdeepArchivePermissionError(
      'Archive channel #' + (channel.name || channel.id) + ' is missing bot permissions: ' + missing.join(', ') + '.'
    );
  }

  return true;
}

function seekdeepBuildArchiveFailureText(err = null) {
  if (err?.isSeekDeepArchivePermissionError || seekdeepIsDiscordPermissionError(err)) {
    return [
      'Discord thread archive is blocked by server/channel permissions.',
      '',
      'Required bot role permissions in the archive channel:',
      'View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Attach Files, Read Message History.',
      '',
      'If #seekdeep-archive does not already exist, either create it manually or grant Manage Channels so SeekDeep can create it.',
    ].filter(Boolean).join('\n');
  }

  return [
    'Discord thread archive failed.',
    err?.message ? 'Reason: ' + String(err.message).slice(0, 500) : '',
  ].filter(Boolean).join('\n');
}
// SEEKDEEP_ARCHIVE_PERMISSION_UX_END

async function seekdeepGetOrCreateGuildArchiveChannel(target) {
  target = target || null;
  const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;
  if (!guild) throw new Error('Archive threads require a Discord server.');

  const storedId = typeof seekdeepGetArchiveChannelIdForGuild === 'function' ? seekdeepGetArchiveChannelIdForGuild(guild.id) : '';
  if (storedId) {
    const byStoredId = guild.channels.cache.get(storedId) || await guild.channels.fetch(storedId).catch(() => null);
    if (byStoredId) {
      const report = typeof seekdeepArchiveChannelPermissionReport === 'function' ? seekdeepArchiveChannelPermissionReport(byStoredId, guild) : { ok: true, missing: [] };
      if (!report.ok) {
        const err = new Error(typeof seekdeepArchivePermissionHelpText === 'function' ? seekdeepArchivePermissionHelpText(byStoredId, report.missing, target) : 'Archive channel is configured, but SeekDeep is missing permissions.');
        err.code = 'SEEKDEEP_ARCHIVE_PERMISSIONS_MISSING';
        err.missingPermissions = report.missing;
        throw err;
      }
      return byStoredId;
    }
  }

  const allowGlobalChannel = String(process.env.SEEKDEEP_ARCHIVE_ALLOW_GLOBAL_CHANNEL || 'false').toLowerCase() === 'true';
  if (allowGlobalChannel) {
    const configuredId = String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_ID || '').trim();
    if (configuredId) {
      const byId = guild.channels.cache.get(configuredId) || await guild.channels.fetch(configuredId).catch(() => null);
      if (byId) return byId;
      const err = new Error('SEEKDEEP_ARCHIVE_CHANNEL_ID is set, but that channel is not accessible in this server. Fix the env value or bot channel permissions.');
      err.code = 'SEEKDEEP_ARCHIVE_CHANNEL_NOT_ACCESSIBLE';
      throw err;
    }
  }

  const adoptNamedChannel = String(process.env.SEEKDEEP_ARCHIVE_ADOPT_NAMED_CHANNEL || 'false').toLowerCase() === 'true';
  if (adoptNamedChannel) {
    const wantedName = seekdeepArchiveChannelName();
    let channel = guild.channels.cache.find((candidate) => candidate && candidate.name === wantedName && typeof candidate.send === 'function' && candidate.threads);
    if (!channel) {
      const fetched = await guild.channels.fetch().catch(() => null);
      if (fetched) channel = fetched.find((candidate) => candidate && candidate.name === wantedName && typeof candidate.send === 'function' && candidate.threads);
    }
    if (channel) {
      if (typeof seekdeepSetArchiveChannelIdForGuild === 'function') seekdeepSetArchiveChannelIdForGuild(guild.id, channel.id, 'auto-adopted-existing-channel');
      return channel;
    }
  }

  const autoCreate = String(process.env.SEEKDEEP_ARCHIVE_AUTO_CREATE_CHANNEL || 'false').toLowerCase() === 'true';
  if (autoCreate) {
    const wantedName = seekdeepArchiveChannelName();
    const channel = await guild.channels.create({
      name: wantedName,
      type: 0,
      reason: 'SeekDeep server archive channel',
    });
    if (typeof seekdeepSetArchiveChannelIdForGuild === 'function') seekdeepSetArchiveChannelIdForGuild(guild.id, channel.id, 'auto-created-channel');
    await channel.send('SeekDeep archive channel initialized. User and shared archive threads will be created here.').catch(() => null);
    return channel;
  }

  const err = new Error(typeof seekdeepArchiveSetupHelpText === 'function' ? seekdeepArchiveSetupHelpText(guild, target) : 'Archive channel is not configured for this server.');
  err.code = 'SEEKDEEP_ARCHIVE_NOT_CONFIGURED';
  throw err;
}

async function seekdeepFindArchiveThread(channel, threadName) {
  const active = await channel.threads.fetchActive().catch(() => null);
  const activeThread = active?.threads?.find((thread) => thread?.name === threadName);
  if (activeThread) return activeThread;

  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  const archivedThread = archivedPublic?.threads?.find((thread) => thread?.name === threadName);
  if (archivedThread) {
    try {
      if (archivedThread.archived) await archivedThread.setArchived(false, 'SeekDeep archive write');
    } catch {}
    return archivedThread;
  }

  return null;
}

async function seekdeepGetOrCreateUserArchiveThread(target, userOverride) {
  target = target || null;
  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);
  const user = userOverride || target?.user || target?.author || target?.member?.user || target?.message?.author || null;
  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '';
  const userId = String(user?.id || '').trim();
  const member = typeof seekdeepArchiveThreadResolveMember === 'function' ? await seekdeepArchiveThreadResolveMember(target, user) : null;
  const subject = member || user;
  const profile = userId && guildId && typeof seekdeepArchiveThreadGetUserProfile === 'function'
    ? seekdeepArchiveThreadGetUserProfile(guildId, userId)
    : {};
  let currentCount = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;
  const untrustedCountWasIgnored = typeof seekdeepArchiveThreadHadUntrustedCount === 'function' && seekdeepArchiveThreadHadUntrustedCount(profile);
  const threadName = typeof seekdeepArchiveThreadBuildName === 'function'
    ? seekdeepArchiveThreadBuildName(subject, currentCount)
    : seekdeepArchiveUserThreadName(subject, currentCount);

  let thread = null;
  if (profile.threadId) {
    thread = channel.threads?.cache?.get?.(profile.threadId) || null;
    if (!thread && typeof channel.threads?.fetch === 'function') thread = await channel.threads.fetch(profile.threadId).catch(() => null);
    if (thread?.archived) {
      try { await thread.setArchived(false, 'SeekDeep archive write'); } catch {}
    }
  }

  if (!thread) thread = await seekdeepFindArchiveThread(channel, threadName);

  if (!thread && typeof seekdeepLegacyArchiveUserThreadName === 'function') {
    const legacyName = seekdeepLegacyArchiveUserThreadName(user);
    if (legacyName !== threadName) thread = await seekdeepFindArchiveThread(channel, legacyName);
  }

  if (!thread && typeof seekdeepFindUserArchiveThreadWithoutCreate === 'function') {
    thread = await seekdeepFindUserArchiveThreadWithoutCreate(channel, target, user, subject, profile);
  }

  if (!thread) {
    thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: 'SeekDeep archive thread for ' + (user?.id || 'unknown user'),
    });
    await thread.send([
      '\u{1FA99} SeekDeep archive for ' + (user?.id ? '<@' + user.id + '>' : 'unknown user') + '.',
      'New archived generations will appear here.'
    ].join('\n')).catch(() => null);
  }

  let countInfo = { count: currentCount, trusted: currentCount, scannedCount: 0, scannedMessages: 0, scanOk: false };
  if (thread && typeof seekdeepArchiveThreadResolveCountFromThread === 'function') {
    countInfo = await seekdeepArchiveThreadResolveCountFromThread(thread, profile);
    currentCount = countInfo.count;
  }

  if (thread && typeof seekdeepArchiveTrustedOrBackfilledCount === 'function') {
    currentCount = await seekdeepArchiveTrustedOrBackfilledCount(thread, profile);
  }

  const finalThreadName = typeof seekdeepArchiveThreadBuildName === 'function'
    ? seekdeepArchiveThreadBuildName(subject, currentCount)
    : seekdeepArchiveUserThreadName(subject, currentCount);

  if (userId && guildId && typeof seekdeepArchiveThreadSaveUserProfile === 'function') {
    const savePayload = {
      threadId: thread.id,
      count: currentCount,
      countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,
      lastNickname: typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject) : '',
      lastCountBackfillAt: new Date().toISOString(),
      lastCountBackfillScannedMessages: Number(countInfo.scannedMessages || 0) || 0,
      lastCountBackfillArchiveEntries: Number(countInfo.scannedCount || 0) || 0,
    };
    if (untrustedCountWasIgnored) {
      savePayload.legacyUntrustedCount = Number(profile.count || profile.archiveCount || 0) || 0;
      savePayload.legacyUntrustedCountIgnoredAt = new Date().toISOString();
    }
    seekdeepArchiveThreadSaveUserProfile(guildId, userId, savePayload);
    if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, finalThreadName);
  }

  return { channel, thread, threadName: finalThreadName, archiveUser: user, archiveMember: member, archiveCount: currentCount };
}

async function seekdeepAddArchiveEntryButtons(sentMessage) {
  if (!sentMessage?.id) return;
  const attachment = sentMessage.attachments?.first?.();
  const imageUrl = attachment?.url || '';
  const buttons = [];
  if (imageUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Download')
        .setStyle(ButtonStyle.Link)
        .setURL(imageUrl)
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`seekdeep:archivedelete:${sentMessage.id}`)
      .setLabel('Delete from Archive')
      .setStyle(ButtonStyle.Secondary)
  );
  if (buttons.length) {
    await sentMessage.edit({
      components: [new ActionRowBuilder().addComponents(...buttons)],
    }).catch(() => null);
  }
}

async function seekdeepMaterializeArchiveFileFromState(state = {}, target = null) {
  state = state || {};
  target = target || null;

  const directPathCandidates = [
    state.filePath,
    state.path,
    state.fullPath,
    state.savedPath,
    state.imagePath,
    state.outputPath,
    state.localPath,
    state.attachmentPath,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidate of directPathCandidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  const sourceAttachment =
    target?.message?.attachments?.first?.() ||
    target?.attachments?.first?.() ||
    null;

  const sourceUrl = String(
    state.attachmentUrl ||
    state.url ||
    state.downloadUrl ||
    state.proxyURL ||
    state.imageUrl ||
    sourceAttachment?.url ||
    sourceAttachment?.proxyURL ||
    ''
  ).trim();

  if (!sourceUrl) return '';

  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const tempDir = path.join(baseDir, 'saved_generations', 'temp_archive_uploads');

  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch {}

  const safeExtMatch = sourceUrl.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i);
  const ext = safeExtMatch ? safeExtMatch[1].toLowerCase() : 'png';
  const tempName = `archive-upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const tempPath = path.join(tempDir, tempName);

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source attachment: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));
  return tempPath;
}


async function seekdeepArchiveImageStateToSharedDiscordThread(state, target) {
  state = state || {};
  target = target || null;

  const archiveInfo = await seekdeepGetOrCreateSharedArchiveThread(target);
  const thread = archiveInfo.thread;
  let threadName = archiveInfo.threadName;

  const payload = {
    content: seekdeepSharedArchiveMetadataLines(state, target).join('\n'),
  };

  let filePath = '';
  try {
    filePath = await seekdeepMaterializeArchiveFileFromState(state, target);
    if (filePath) payload.files = [filePath];
  } catch (err) {
    console.warn('SeekDeep shared archive attachment materialization failed:', err?.message || err);
  }

  if (!payload.files || !payload.files.length) {
    const fallbackAttachment = target?.message?.attachments?.first?.() || target?.attachments?.first?.() || null;
    const fallbackUrl = String(state.attachmentUrl || state.url || state.downloadUrl || state.proxyURL || fallbackAttachment?.url || fallbackAttachment?.proxyURL || '').trim();
    payload.content += fallbackUrl ? '\nImage URL: ' + fallbackUrl : '\nImage attachment unavailable.';
  }

  const sentSharedArchiveMsg = await thread.send(payload);
  await seekdeepAddArchiveEntryButtons(sentSharedArchiveMsg);

  let archiveCount = Math.max(0, Number(archiveInfo?.count || 0) || 0);
  if (typeof seekdeepRecordSharedArchivePost === 'function') {
    const recordResult = await seekdeepRecordSharedArchivePost(archiveInfo, target);
    if (typeof recordResult === 'string') {
      threadName = recordResult;
    } else if (recordResult) {
      threadName = recordResult.threadName || threadName;
      archiveCount = Math.max(0, Number(recordResult.count || archiveCount) || 0);
    }
  }

  if (filePath && /[\\/]saved_generations[\\/]temp_archive_uploads[\\/]/i.test(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  return {
    ok: true,
    backend: 'discord-shared-thread',
    threadId: thread.id,
    threadName,
    archiveCount,
    channelId: thread.parentId || thread.parent?.id || '',
    postedImage: Boolean(payload.files && payload.files.length),
    shared: true,
  };
}

async function seekdeepArchiveImageStateToDiscordThread(state, target) {
  state = state || {};
  target = target || null;

  const archiveInfo = await seekdeepGetOrCreateUserArchiveThread(target);
  const thread = archiveInfo.thread;
  let threadName = archiveInfo.threadName;

  const payload = {
    content: seekdeepArchiveMetadataLines(state, target).join('\n'),
  };

  let filePath = '';

  try {
    filePath = await seekdeepMaterializeArchiveFileFromState(state, target);
    if (filePath) payload.files = [filePath];
  } catch (err) {
    console.warn('SeekDeep archive attachment materialization failed:', err?.message || err);
  }

  if (!payload.files || !payload.files.length) {
    const fallbackAttachment =
      target?.message?.attachments?.first?.() ||
      target?.attachments?.first?.() ||
      null;

    const fallbackUrl = String(
      state.attachmentUrl ||
      state.url ||
      state.downloadUrl ||
      state.proxyURL ||
      fallbackAttachment?.url ||
      fallbackAttachment?.proxyURL ||
      ''
    ).trim();

    payload.content += fallbackUrl ? '\nImage URL: ' + fallbackUrl : '\nImage attachment unavailable.';
  }

  const sentUserArchiveMsg = await thread.send(payload);
  await seekdeepAddArchiveEntryButtons(sentUserArchiveMsg);

  if (typeof seekdeepArchiveThreadRecordPost === 'function') {
    threadName = await seekdeepArchiveThreadRecordPost(archiveInfo, target);
  }

  if (filePath && /[\\/]saved_generations[\\/]temp_archive_uploads[\\/]/i.test(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  return {
    ok: true,
    backend: 'discord-thread',
    threadId: thread.id,
    threadName,
    channelId: thread.parentId || thread.parent?.id || '',
    postedImage: Boolean(payload.files && payload.files.length),
  };
}

async function seekdeepHandleImageButton(interaction) {
  const customId = String(interaction?.customId || '').trim();
  const match =
    customId.match(/^seekdeep:(?:image-choice|regen):(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive|sharedarchive|shared-archive|shared_archive):(.+)$/) ||
    null;

  if (interaction && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
    } catch {}
  }

  if (interaction && !interaction.deferred && !interaction.replied) {
    try {
} catch {}
  }

  const startedAt = seekdeepNowMs();

  if (!customId.startsWith('seekdeep:')) {
    return false;
  }

  if (/^seekdeep:prompt:(original|refined|both):/.test(customId)) {
    if (typeof seekdeepHandlePromptChoiceButton === 'function') {
      return await seekdeepHandlePromptChoiceButton(interaction);
    }
    return false;
  }

  try {
    if (/^seekdeep:(?:image:)?(?:regen|regenerate)(?::|$)/i.test(customId)) {
      const regenUserId = typeof seekdeepRegenerateCooldownUserId === 'function'
        ? seekdeepRegenerateCooldownUserId(interaction)
        : (interaction?.user?.id || 'unknown');
      const remaining = typeof seekdeepImageCooldownRemaining === 'function'
        ? seekdeepImageCooldownRemaining(regenUserId)
        : 0;

      if (remaining > 0) {
        if (typeof seekdeepLogRoute === 'function') {
          seekdeepLogRoute('regenerate-cooldown', 'button-regenerate');
        }

        if (typeof seekdeepSendRegenerateCooldownNotice === 'function') {
          await seekdeepSendRegenerateCooldownNotice(interaction, remaining);
        } else {
          const payload = {
            content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(remaining), {
              startedAt,
              modelUsed: seekdeepNoModelLabel(),
            }),
          };
          if (interaction?.replied || interaction?.deferred) {
            await interaction.editReply(payload);
          } else {
            await interaction.reply(seekdeepEphemeralPayload(payload));
          }
        }
        return true;
      }
    }
  } catch (err) {
    console.warn('Regenerate button cooldown check failed:', err?.message || err);
  }

  const parsed =
    customId.match(/^seekdeep:regen:(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive|sharedarchive|shared-archive|shared_archive|save):(.+)$/) ||
    customId.match(/^seekdeep:image:(regen|archive|sharedarchive|shared-archive|shared_archive|save):(.+)$/);

  if (!parsed) {
    return false;
  }

  let action = '';
  let mode = 'submitted';
  let actionId = '';

  if (customId.startsWith('seekdeep:regen:')) {
    action = 'regenerate';
    mode = parsed[1] || 'submitted';
    actionId = parsed[2] || '';
  } else if (customId.startsWith('seekdeep:image:')) {
    action = parsed[1] === 'regen' ? 'regenerate' : (parsed[1] === 'save' ? 'archive' : parsed[1]);
    actionId = parsed[2] || '';
  } else {
    action = parsed[1] === 'save' ? 'archive' : parsed[1];
    actionId = parsed[2] || '';
  }

  // SEEKDEEP_SHARED_ARCHIVE_ACTION_NORMALIZE
  action = String(action || '').toLowerCase();
  if (action === 'save') action = 'archive';
  if (/^shared[-_]?archive$/i.test(action)) action = 'sharedarchive';

  if (!interaction?.deferred && !interaction?.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  let state = seekdeepTempImageStateIndex?.get?.(actionId) || null;
  if (!state && typeof seekdeepLoadTempImageState === 'function') {
    state = seekdeepLoadTempImageState(actionId);
  }

  if (!state) {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter('That image action expired from the temporary cache. Generate it again if you still want to use its buttons.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }
  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_START
  // SEEKDEEP_SHARED_ARCHIVE_DUPLICATE_GUARD_V6
  if (action === 'sharedarchive' && typeof seekdeepWasSharedArchiveInteractionReservedV6 === 'function' && seekdeepWasSharedArchiveInteractionReservedV6(interaction)) {
    return true;
  }

  if (action === 'sharedarchive') {
    try {
      const archiveResult = typeof seekdeepArchiveImageStateToSharedDiscordThread === 'function'
        ? await seekdeepArchiveImageStateToSharedDiscordThread(state, interaction)
        : null;
      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              [
                'Archived to shared archive.',
                archiveResult?.threadId ? 'Thread: <#' + archiveResult.threadId + '>' : (archiveResult?.threadName ? 'Thread: ' + archiveResult.threadName : ''),
              ].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Archived to shared archive.',
      });
      return true;
    } catch (err) {
      const reason = String(err?.message || err || 'unknown error').slice(0, 1000);
      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              ['Shared archive failed.', reason ? 'Reason: ' + reason : ''].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Shared archive failed.',
      });
      return true;
    }
  }
  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_END

  if (action === 'archive') {
    try {
      const archiveResult = await seekdeepArchiveImageStateToDiscordThread(state, interaction);
      await interaction.editReply({
        content: seekdeepAppendResponseFooter([
          'Archived to this server.',
          archiveResult?.threadName ? `Thread: ${archiveResult.threadName}` : '',
        ].filter(Boolean).join('\n'), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
      });
      return true;
    } catch (err) {
      if (err?.code === 'SEEKDEEP_ARCHIVE_NOT_CONFIGURED' || err?.code === 'SEEKDEEP_ARCHIVE_PERMISSIONS_MISSING') {
        const setupText = String(err?.message || 'Archive channel is not ready for this server.').slice(0, 1800);
        await interaction.editReply({
          content: typeof seekdeepAppendResponseFooter === 'function'
            ? seekdeepAppendResponseFooter(setupText, {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              })
            : setupText,
        });
        return true;
      }
      console.warn('Discord thread archive failed:', err?.message || err);

      await interaction.editReply({
        content: seekdeepAppendResponseFooter([
          'Discord thread archive failed.',
          err?.message ? `Reason: ${String(err.message).slice(0, 500)}` : '',
        ].filter(Boolean).join('\n'), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
      });
      return true;
    }
  }

  if (action === 'download') {
    const downloadText = state?.downloadUrl || state?.url || state?.proxyURL || state?.attachmentUrl
      ? `Download URL:\n${state.downloadUrl || state.url || state.proxyURL || state.attachmentUrl}`
      : 'Use the image attachment in the channel to download this image.';

    await interaction.editReply({
      content: seekdeepAppendResponseFooter(downloadText, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }

  if (action !== 'regenerate') {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter('Unknown image action.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }

  const basePrompt = state.originalPrompt || state.rawPrompt || state.prompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const grounded = state.ground !== false && state.imageModeOptions?.ground !== false;

  const queueOne = async (regenMode, routeName, suffix) => {
    const proxy = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', suffix)
      : {
          author: { id: interaction?.user?.id || 'unknown' },
          channel: interaction?.channel || null,
          id: `${interaction?.id || 'regen'}:${suffix}:${Date.now().toString(36)}`,
          reply: async (payload) => {
            if (interaction?.channel && typeof interaction.channel.send === 'function') {
              return await interaction.channel.send(payload);
            }
            return null;
          },
        };

    if (typeof seekdeepLogRoute === 'function') {
      seekdeepLogRoute(routeName, basePrompt);
    }

    return await seekdeepSendImageWithButtonsMessage(
      proxy,
      basePrompt,
      width,
      height,
      seed,
      seekdeepRegenerateModeOptions(regenMode, {
        ...state,
        originalPrompt: basePrompt,
        ground: grounded,
      }),
    );
  };

  if (mode === 'both') {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter([
        'Queued both:',
        '',
        grounded ? 'Grounding: on' : 'Grounding: off',
        'Jobs queued:',
        '1. Original prompt',
        '2. Refined prompt',
      ].join('\n'), {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });

    void queueOne('original', 'image-choice-original', 'regen-original');
    void queueOne('refined', 'image-choice-refined', 'regen-refined');
    return true;
  }

  const responseMode = String(mode || 'submitted').toLowerCase();
  const resolvedMode = responseMode === 'original' || responseMode === 'raw'
    ? 'original'
    : responseMode === 'refined'
      ? 'refined'
      : ((state.refine === false || state.imageModeOptions?.refine === false) ? 'original' : 'refined');

  await interaction.editReply({
    content: seekdeepAppendResponseFooter([
      resolvedMode === 'original' ? 'Queued original regenerate.' : 'Queued refined regenerate.',
      '',
      grounded ? 'Grounding: on' : 'Grounding: off',
      resolvedMode === 'original' ? 'Refinement: off' : 'Refinement: on',
      'Queued Jobs: 1',
    ].join('\n'), {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
  });

  void queueOne(resolvedMode, resolvedMode === 'original' ? 'image-choice-original' : 'image-choice-refined', `regen-${resolvedMode}`);
  return true;
}

// SEEKDEEP_IMAGE_BUTTONS_END

async function statusText() {
  const botUptime = seekdeepFormatDuration(Date.now() - seekdeepBotMetrics.startedAt);
  const responsesByModel = seekdeepFormatResponsesByModel();
  let health = null;
  let healthError = '';

  try {
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Number(process.env.SEEKDEEP_STATUS_HEALTH_TIMEOUT_MS || 2500));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      health = await fetchJson(`${LOCAL_AI_BASE_URL}/health`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    healthError = err?.name === 'AbortError'
      ? `health check timed out after ${process.env.SEEKDEEP_STATUS_HEALTH_TIMEOUT_MS || 2500}ms`
      : String(err?.message || err || 'unknown error');
  }

  if (!health) {
    return seekdeepRedactStatusConnectionInfo([
      'Local AI server status',
      '',
      'Health: OFFLINE / unreachable',
      `Endpoint: ${LOCAL_AI_BASE_URL}/health`,
      `Error: ${healthError || 'health check failed'}`,
      '',
      'Bot runtime:',
      `Bot Uptime: ${botUptime}`,
      `Responses Since Last Reboot: ${seekdeepBotMetrics.responsesSinceBoot}`,
      '',
      'Image queue:',
      seekdeepImageQueueStatusText(),
      '',
      'Responses By Model:',
      responsesByModel,
      '',
      'Configured local models:',
      `Chat: ${seekdeepChatModelLabel()}`,
      `Vision: ${seekdeepVisionModelLabel()}`,
      `Image: ${seekdeepImageModelLabel()}`,
      'Offline model loading: unknown while local AI server is offline',
    ].join('\n'));
  }

  const loadedTask = health.loaded_task || 'none';
  const currentLoadedModel = seekdeepCurrentLoadedModelFromHealth(health);
  const loadedChatRole = health.loaded_chat_role || 'none';
  const loadedChatModelId = health.loaded_chat_model_id || 'none';
  const chatQuantMode = health.chat_quant_mode || 'unknown';
  const chatRoles = (health.chat_roles && typeof health.chat_roles === 'object') ? health.chat_roles : null;

  const chatRoleLines = chatRoles
    ? Object.entries(chatRoles).map(([role, modelId]) => `  ${role}: ${modelId || '(unset)'}`)
    : ['  (not reported by /health)'];

  return seekdeepRedactStatusConnectionInfo([
    'Local AI server status',
    '',
    `Health: ${health.status}`,
    `Device: ${health.device}`,
    `CUDA: ${health.cuda_available ? 'YES' : 'NO'}`,
    `Loaded task: ${loadedTask}`,
    `Current Loaded Model: ${currentLoadedModel}`,
    `Loaded chat role: ${loadedChatRole}`,
    `Loaded chat model: ${loadedChatModelId}`,
    `Chat quantization: ${chatQuantMode}`,
    `Keep mode: ${health.keep_mode}`,
    '',
    'Bot runtime:',
    `Bot Uptime: ${botUptime}`,
    `Responses Since Last Reboot: ${seekdeepBotMetrics.responsesSinceBoot}`,
    '',
    'Image queue:',
    seekdeepImageQueueStatusText(),
    '',
    'Responses By Model:',
    responsesByModel,
    '',
    'Configured local models:',
    `Chat (default): ${health.models?.chat}`,
    `Vision: ${health.models?.vision}`,
    `Image: ${health.models?.image}`,
    'Chat roles:',
    ...chatRoleLines,
    `Offline model loading: ${health.offline_model_loading ? 'YES' : 'NO'}`,
  ].join('\n'));
}

// SEEKDEEP_BATCH1_UTILITY_START
function seekdeepAdminIds() {
  return new Set(String(process.env.SEEKDEEP_ADMIN_IDS || process.env.ADMIN_USER_IDS || '')
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean));
}

function seekdeepIsAdminSource(source) {
  const userId = String(source?.user?.id || source?.author?.id || '');
  if (userId && seekdeepAdminIds().has(userId)) return true;

  try {
    if (source?.memberPermissions?.has && source.memberPermissions.has('Administrator')) return true;
  } catch {}

  try {
    if (source?.member?.permissions?.has && source.member.permissions.has('Administrator')) return true;
  } catch {}

  return false;
}

function seekdeepAdminLine(source) {
  return `Admin: ${seekdeepIsAdminSource(source) ? 'YES' : 'NO'}`;
}

function seekdeepFormatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function seekdeepSafeReadJson(fullPath) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

function seekdeepWalkFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) out.push({ name, fullPath, stat });
    } catch {}
  }
  return out;
}

function seekdeepDirFileStats(dir, imageOnly = false) {
  const files = seekdeepWalkFiles(dir);
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
  const filtered = imageOnly ? files.filter((f) => imageExts.has(path.extname(f.name).toLowerCase())) : files;
  const bytes = filtered.reduce((sum, file) => sum + Number(file.stat?.size || 0), 0);
  return { files: filtered, count: filtered.length, bytes };
}

function seekdeepTempImageCacheDir() {
  try {
    if (typeof SEEKDEEP_IMAGE_CACHE_DIR !== 'undefined' && SEEKDEEP_IMAGE_CACHE_DIR) return SEEKDEEP_IMAGE_CACHE_DIR;
  } catch {}
  return path.join(__dirname, 'temp', 'image-cache');
}

function seekdeepArchiveDirResolved() {
  try {
    if (typeof seekdeepArchiveDir === 'function') return seekdeepArchiveDirForTarget(seekdeepArchiveTargetFallback(typeof archiveTarget !== 'undefined' ? archiveTarget : null));
  } catch {}
  return path.join(__dirname, 'saved_generations');
}

function seekdeepReadTempImageCacheMetadata() {
  const dir = seekdeepTempImageCacheDir();
  return seekdeepWalkFiles(dir)
    .filter((file) => file.name.toLowerCase().endsWith('.json'))
    .map((file) => ({ ...seekdeepSafeReadJson(file.fullPath), __metaPath: file.fullPath, __stat: file.stat, __kind: 'temp' }))
    .filter((item) => item && item.id);
}

function seekdeepInferArchivePromptFromFilename(name = '') {
  const base = path.basename(String(name || ''), path.extname(String(name || '')));
  return base
    .replace(/^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z[-_ ]*/i, '')
    .replace(/^\d{2}[-_ ]\d{2}[-_ ]\d{2}[-_ ]\d{3}z[-_ ]*/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

function seekdeepReadArchiveMetadata() {
  const dir = seekdeepArchiveDirResolved();
  const jsonItems = seekdeepWalkFiles(dir)
    .filter((file) => file.name.toLowerCase().endsWith('.json'))
    .map((file) => ({ ...seekdeepSafeReadJson(file.fullPath), __metaPath: file.fullPath, __stat: file.stat, __kind: 'archive' }))
    .filter((item) => item && (item.id || item.prompt));

  if (jsonItems.length) return jsonItems;

  return seekdeepDirFileStats(dir, true).files.map((file) => ({
    id: path.basename(file.name, path.extname(file.name)),
    prompt: seekdeepInferArchivePromptFromFilename(file.name),
    filename: file.name,
    binaryArchiveScope: file.fullPath,
    createdAt: file.stat.mtimeMs,
    __stat: file.stat,
    __kind: 'archive',
  }));
}

function seekdeepFormatTimestamp(ms) {
  const value = Number(ms || 0);
  if (!value) return 'unknown';
  try { return new Date(value).toLocaleString(); } catch { return 'unknown'; }
}

function seekdeepShorten(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function seekdeepHelpText(source = null) {
  const prefix = '@SeekDeep';
  const robot = String.fromCodePoint(0x1F916);
  const check = String.fromCodePoint(0x2705);
  const speech = String.fromCodePoint(0x1F4AC);
  const art = String.fromCodePoint(0x1F3A8);
  const eye = String.fromCodePoint(0x1F441);
  const coin = String.fromCodePoint(0x1FA99);
  const folder = String.fromCodePoint(0x1F5C3);
  const counter = String.fromCodePoint(0x1F522);
  const clock = String.fromCodePoint(0x1F558);
  const bullet = '\u2022';

  return [
    '# ' + robot + ' SEEKDEEP COMMAND MAP',
    '',
    '## ' + check + ' Start',
    '```text',
    prefix + ' help',
    prefix + ' archive help',
    prefix + ' status',
    prefix + ' ping',
    prefix + ' what model are you using?',
    '```',
    '',
    '## ' + speech + ' Chat / Web / Prompting',
    '```text',
    prefix + ' ask <question>',
    '/ask prompt:<text> web:auto|off|always',
    prefix + ' refine <prompt>',
    '/refine prompt:<text>',
    '```',
    'Use `web:off` for local-only answers.',
    '',
    '## ' + art + ' Images',
    '```text',
    prefix + ' show me <image idea>',
    prefix + ' show <image idea>',
    prefix + ' draw me <image idea>',
    prefix + ' draw <image idea>',
    prefix + ' generate <image idea>',
    prefix + ' generate me <image idea>',
    prefix + ' make/create/render/paint/sketch/illustrate/design <image idea>',
    prefix + ' generate me',
    '/image prompt:<text> width:<n> height:<n> seed:<n>',
    prefix + ' regenerate',
    '```',
    '`generate me` asks what to generate and consumes your next plain reply as the image subject.',
    'Use `raw`, `unrefined`, `--raw`, or `no refine` to skip prompt refinement.',
    'Buttons: `Original` `Refined` `Both` `Download` `Archive` `Shared Archive`',
    '',
    '## ' + eye + ' Vision',
    '```text',
    'Reply to an image/video:',
    prefix + ' what is this?',
    '/vision file:<upload> prompt:<question>',
    '```',
    '',
    '## ' + coin + ' Archive Setup',
    '```text',
    prefix + ' archive config',
    prefix + ' archive setup here',
    prefix + ' setup archive here',
    prefix + ' archive setup #channel',
    '```',
    'Only Admin / Manage Server / Manage Channels can change this.',
    '',
    '## ' + folder + ' Archive Use',
    '```text',
    prefix + ' archive me',
    prefix + ' archive shared',
    prefix + ' shared archive',
    prefix + ' archive @user',
    prefix + ' archive for @user',
    prefix + ' archive status',
    prefix + ' archive status @user',
    prefix + ' archive status shared',
    '/archivestatus',
    '```',
    'Archive storage uses Discord threads only.',
    '',
    '## ' + counter + ' Archive Count / Thread Names',
    '```text',
    prefix + ' archive count set <number>',
    prefix + ' archive count @user set <number>',
    '```',
    'Thread style: `' + coin + ' ' + bullet + ' Archive ' + bullet + ' current nickname ' + bullet + ' archived-image count`',
    '',
    '## ' + robot + ' Chat Model Roles (automatic)',
    'Chat picks a model role from your prompt automatically. You do not set this.',
    '```text',
    'default_chat    normal chat, image refinement, casual questions',
    'quality_text    compare / pros and cons / planning / detailed / explain',
    'reasoning_code  code / stack trace / debug / repo / CUDA / VRAM / etc.',
    'fallback_chat   used automatically if the chosen role fails',
    'lightweight_chat optional low-VRAM fallback (only if configured)',
    '```',
    'See `' + prefix + ' status` -> "Chat roles" for the role -> model mapping,',
    'and "Loaded chat role / Loaded chat model" for what is currently in VRAM.',
    'Bot console prints `[SeekDeep Model Router] role=... reason=...` for each chat.',
    '',
    '## ' + clock + ' Recent / Cache / Queue',
    '```text',
    prefix + ' recent images [limit]',
    prefix + ' recent prompts',
    prefix + ' cache status',
    prefix + ' queue status',
    '```',
    '',
    'Unsupported near-commands return: `Did you mean ...?`',
  ].join('\n');
}

function seekdeepCacheStatusText() {
  const dir = seekdeepTempImageCacheDir();
  const allStats = seekdeepDirFileStats(dir, false);
  const imageStats = seekdeepDirFileStats(dir, true);
  const metas = seekdeepReadTempImageCacheMetadata();
  const now = Date.now();
  const expired = metas.filter((m) => Number(m.expiresAt || 0) && Number(m.expiresAt || 0) <= now).length;
  const newest = metas.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];

  return [
    'Temp image cache status',
    '',
    `Cache directory: ${dir}`,
    `Files: ${allStats.count}`,
    `Images: ${imageStats.count}`,
    `Metadata entries: ${metas.length}`,
    `Expired metadata entries: ${expired}`,
    `Size: ${seekdeepFormatBytes(allStats.bytes)}`,
    `Retention: ${typeof SEEKDEEP_IMAGE_CACHE_TTL_HOURS !== 'undefined' ? SEEKDEEP_IMAGE_CACHE_TTL_HOURS : 24} hours`,
    newest ? `Newest prompt: ${seekdeepShorten(newest.prompt || newest.filename || newest.id, 160)}` : 'Newest prompt: none',
  ].join('\n');
}

function seekdeepArchiveStatusText() {
  return [
    'Image archive status',
    '',
    'Archive storage uses Discord threads only.',
    'Use `@SeekDeep archive status` or `/archivestatus` for live thread status.',
  ].join('\n');
}

function seekdeepRecentImagesRequestedLimit(prompt = '', fallback = 5, max = 10) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  const m = p.match(/\b(\d{1,2})\b/);
  let value = m ? Number(m[1]) : fallback;
  if (!Number.isFinite(value) || value < 1) value = fallback;
  value = Math.max(1, Math.min(max, value));
  return value;
}

function seekdeepNormalizeRecentImageEntry(item) {
  if (!item) return null;

  const kind = item.__kind === 'archive' ? 'archive' : 'temp';
  const createdAt = Number(item.createdAt || item.__stat?.mtimeMs || 0) || 0;
  let binaryPath = String(item.binaryPath || '').trim();
  let filename = String(item.filename || '').trim();

  if (!binaryPath && filename) {
    binaryPath = path.join(kind === 'archive' ? seekdeepArchiveDirResolved() : seekdeepTempImageCacheDir(), filename);
  }

  if (!binaryPath || !fs.existsSync(binaryPath)) return null;

  if (!filename) {
    filename = path.basename(binaryPath);
  }

  if (kind === 'temp') {
    const expiresAt = Number(item.expiresAt || 0);
    if (expiresAt && expiresAt <= Date.now()) return null;
  }

  return {
    ...item,
    __kind: kind,
    createdAt,
    binaryPath,
    filename,
    prompt: seekdeepShorten(item.prompt || filename || item.id || '(unknown prompt)', 160),
    displayId: item.id || path.basename(filename, path.extname(filename)) || 'unknown',
  };
}

function seekdeepCollectRecentImageEntries(limit = 5) {
  const temp = seekdeepReadTempImageCacheMetadata().map(seekdeepNormalizeRecentImageEntry).filter(Boolean);
  const archive = seekdeepReadArchiveMetadata().map(seekdeepNormalizeRecentImageEntry).filter(Boolean);

  return [...temp, ...archive]
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(10, Number(limit || 5))));
}

function seekdeepRecentImagesText(limit = 10) {
  const items = seekdeepCollectRecentImageEntries(limit);

  if (!items.length) return 'Recent images\n\nNo recent image files found.';

  return [
    'Recent images',
    '',
    ...items.map((item, index) => {
      const when = seekdeepFormatTimestamp(item.createdAt || 0);
      return `${index + 1}. [${item.__kind}] ${item.prompt}\n   Created: ${when}\n   ID/File: ${item.displayId}`;
    }),
  ].join('\n');
}

function seekdeepRecentImageCaption(item, index, total) {
  return [
    `Recent image ${index + 1}/${total}`,
    `Source: ${item.__kind}`,
    `Prompt: ${item.prompt}`,
    `Created: ${seekdeepFormatTimestamp(item.createdAt || 0)}`,
    `ID: ${item.displayId}`,
  ].join('\n');
}

async function seekdeepPostRecentImagesToChannel(channel, limit = 5) {
  const startedAt = seekdeepNowMs();
  const modelUsed = seekdeepNoModelLabel();
  const items = seekdeepCollectRecentImageEntries(limit);

  if (!items.length) {
    return {
      summary: 'Recent images\n\nNo recent image files found.',
      startedAt,
      modelUsed,
      posted: 0,
      failed: 0,
    };
  }

  const safeLimit = Math.max(1, Math.min(10, Number(limit || 5)));
  let posted = 0;
  let failed = 0;

  await channel.send(seekdeepAppendResponseFooter(`Posting ${items.length} recent image(s).`, {
    startedAt,
    modelUsed,
  }));

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemStartedAt = seekdeepNowMs();

    try {
      await channel.send({
        content: seekdeepAppendResponseFooter(seekdeepRecentImageCaption(item, i, items.length), {
          startedAt: itemStartedAt,
          modelUsed,
        }),
        files: [new AttachmentBuilder(item.binaryPath, { name: item.filename })],
      });
      posted += 1;
    } catch (err) {
      failed += 1;
      console.error(`Recent image post failed: ${item.binaryPath}`, err?.message || err);
    }
  }

  return {
    summary: `Recent image post complete.\nRequested: ${safeLimit}\nPosted: ${posted}\nFailed: ${failed}`,
    startedAt,
    modelUsed,
    posted,
    failed,
  };
}

async function seekdeepPostRecentImagesFromMessage(message, limit = 5) {
  seekdeepMarkRequestStart(message);
  seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  stopSeekDeepTypingLoopForMessage(message);

  const result = await seekdeepPostRecentImagesToChannel(message.channel, limit);
  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || message?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await message.reply({
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}

async function seekdeepPostRecentImagesFromInteraction(interaction, limit = 5) {
  seekdeepMarkRequestStart(interaction);
  seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());

  const result = await seekdeepPostRecentImagesToChannel(interaction.channel, limit);
  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || interaction?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await safeEditOrReply(interaction, {
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}

function seekdeepRecentPromptsText(key, limit = 12) {
  const entries = (CHANNEL_MEMORY.get(key) || [])
    .filter((entry) => entry.role === 'user')
    .slice(-limit)
    .reverse();

  if (!entries.length) return 'Recent prompts\n\nNo recent channel prompts in memory yet.';

  return [
    'Recent prompts',
    '',
    ...entries.map((entry, index) => `${index + 1}. ${seekdeepShorten(entry.text, 180)}`),
  ].join('\n');
}


// SEEKDEEP_MODEL_STATUS_ROUTE_START
function seekdeepIsModelStatusQuestion(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return false;

  return (
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:are\s+)?(?:you|u|this|seekdeep|seekotics|the\s+bot)\s+(?:using|running|loaded|on)\??$/.test(p) ||
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:do|does)\s+(?:you|u|seekdeep|seekotics|the\s+bot)\s+(?:use|run)\??$/.test(p) ||
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:is|does)\s+(?:seekdeep|seekotics|the\s+bot)\s+(?:using|running|loaded|use)\??$/.test(p) ||
    /^(?:what|which)\s+is\s+(?:your|the\s+bot'?s|seekdeep'?s|seekotics'?)\s+(?:ai\s+)?model\??$/.test(p) ||
    /^(?:what\s+are\s+you\s+running\s+on|what\s+do\s+you\s+run\s+on|what\s+is\s+your\s+backend)\??$/.test(p) ||
    /^(?:current|loaded|active|running)\s+(?:ai\s+)?model(?:\s+status)?\??$/.test(p) ||
    /^(?:model|models|model\s+status|local\s+model\s+status|ai\s+model\s+status)\??$/.test(p) ||
    /^show\s+(?:me\s+)?(?:the\s+)?(?:current|loaded|active|running)?\s*(?:ai\s+)?models?\??$/.test(p)
  );
}
// SEEKDEEP_MODEL_STATUS_ROUTE_END

// SEEKDEEP_COMMAND_SUGGESTIONS_V1_START
function seekdeepNormalizeCommandSuggestionInput(value = '') {
  const raw = String(value || '');
  const cleaned = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? String(seekdeepCleanMessageCommandPrompt(raw) || '')
    : raw
        .replace(/<@!?\d+>/g, ' ')
        .replace(/<@&\d+>/g, ' ')
        .replace(/\bseekdeep\b/gi, ' ')
        .replace(/\bseekotics\b/gi, ' ')
        .replace(/^[@/\s]+/g, ' ');

  return cleaned
    .toLowerCase()
    .replace(/[â€˜â€™]/g, "'")
    .replace(/[^a-z0-9@#'\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepCommandSuggestionDistance(a = '', b = '') {
  a = String(a || '');
  b = String(b || '');
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}

function seekdeepKnownCommandSuggestions() {
  return [
    { command: '@SeekDeep help', aliases: ['help', 'commands', 'command list', 'archive help', 'help archive'] },
    { command: '@SeekDeep status', aliases: ['status', 'bot status', 'server status', 'backend status'] },
    { command: '@SeekDeep ping', aliases: ['ping', 'pong'] },
    { command: '@SeekDeep what model are you using?', aliases: ['model', 'models', 'model status', 'what model'] },
    { command: '@SeekDeep ask <question>', aliases: ['ask', 'question', 'chat'] },
    { command: '@SeekDeep refine <prompt>', aliases: ['refine', 'rewrite prompt', 'improve prompt'] },
    { command: '@SeekDeep draw me <image idea>', aliases: ['draw', 'draw me', 'image', 'generate image', 'picture'] },
    { command: '@SeekDeep show me <image idea>', aliases: ['show', 'show me', 'show image', 'show picture'] },
    { command: '@SeekDeep generate <image idea>', aliases: ['generate', 'generate me', 'make', 'create', 'render', 'paint', 'sketch', 'illustrate', 'design'] },
    { command: '@SeekDeep regenerate', aliases: ['regen', 'regenerate', 'reroll'] },
    { command: '@SeekDeep archive setup here', aliases: ['archive setup here', 'archive configure here', 'set archive here'] },
    { command: '@SeekDeep archive setup #channel', aliases: ['archive setup channel', 'archive channel', 'set archive channel'] },
    { command: '@SeekDeep archive config', aliases: ['archive config', 'archive configuration', 'archive settings'] },
    { command: '@SeekDeep archive me', aliases: ['archive me', 'my archive', 'open my archive'] },
    { command: '@SeekDeep archive @user', aliases: ['archive user', 'archive @user', 'open archive user'] },
    { command: '@SeekDeep archive for @user', aliases: ['archive for user', 'archive for @user', 'archive of user'] },
    { command: '@SeekDeep archive shared', aliases: ['archive shared', 'shared archive', 'open shared archive'] },
    { command: 'Shared Archive button', aliases: ['shared archive button', 'save shared', 'share archive', 'pin shared'] },
    { command: '@SeekDeep archive status', aliases: ['archive status', 'archive stats', 'archive info'] },
    { command: '@SeekDeep archive count set <number>', aliases: ['archive count set', 'set archive count', 'archive counter'] },
    { command: '@SeekDeep cache status', aliases: ['cache status', 'image cache', 'temp cache'] },
    { command: '@SeekDeep queue status', aliases: ['queue status', 'que status', 'image queue'] },
    { command: '@SeekDeep recent images', aliases: ['recent images', 'recent image', 'image history', 'recent generations'] },
    { command: '@SeekDeep recent prompts', aliases: ['recent prompts', 'prompt history'] },
  ];
}

function seekdeepLooksCommandLike(value = '') {
  const p = seekdeepNormalizeCommandSuggestionInput(value);
  if (!p) return false;
  const first = p.split(/\s+/)[0] || '';
  return /^(ask|image|img|draw|picture|generate|make|create|render|paint|sketch|illustrate|design|refine|vision|look|status|stat|help|commands|archive|archiv|arcive|cache|queue|que|recent|prompt|model|ping|pong|regen|regenerate|reroll|purge|clear|delete|wipe)$/.test(first);
}

function seekdeepCommandSuggestionText(prompt = '') {
  const p = seekdeepNormalizeCommandSuggestionInput(prompt);
  if (!p) return '';

  // SEEKDEEP_SKIP_MISSING_IMAGE_SUBJECT_SUGGESTION_V2
  if (typeof seekdeepIsMissingImageSubjectPromptV2 === 'function' && seekdeepIsMissingImageSubjectPromptV2(prompt)) return '';

  const exactAliases = new Set();
  for (const item of seekdeepKnownCommandSuggestions()) {
    for (const alias of item.aliases || []) exactAliases.add(seekdeepNormalizeCommandSuggestionInput(alias));
  }
  if (exactAliases.has(p)) return '';

  const direct = [
    { re: /^(?:purge|purge archive|archive purge|clear archive|wipe archive|delete archive)$/i, command: '@SeekDeep archive status', note: 'Purge is not exposed as a normal chat command. Check archive status first; destructive archive cleanup should stay admin-only and explicit.' },
    { re: /^(?:purge cache|clear cache|delete cache|wipe cache)$/i, command: '@SeekDeep cache status', note: 'Cache purge is not exposed as a normal chat command. Check cache status first.' },
    { re: /^(?:archive count|count archive)$/i, command: '@SeekDeep archive count set <number>', note: 'Use the count command only when correcting the tracked archived-image count.' },
    { re: /^(?:archive setup|setup archive|archive set)$/i, command: '@SeekDeep archive setup here', note: 'Server archive setup can also target a channel: `@SeekDeep archive setup #channel`.' },
    { re: /^(?:archive channel|set archive channel)$/i, command: '@SeekDeep archive setup #channel', note: 'Only server admins / Manage Server / Manage Channels can change the archive channel.' },
    // Image-followup intent: "archive this/it/that/too", "save this/it/the image",
    // "add this to my archive", etc. There is no direct command to archive a prior
    // image via chat — the user needs to press the Archive button on the image, or open
    // their archive thread and copy the image in. Point them at both options.
    { re: /^(?:make\s+(?:it|this|that)\s+archive(?:\s+too)?|archive\s+(?:this|that|it|too|the\s+image|this\s+(?:one|image|picture|pic))|save\s+(?:this|that|it|the\s+image|this\s+(?:image|picture|pic))|add\s+(?:this|it|that)\s+to\s+(?:my\s+)?archive|put\s+(?:this|it|that)\s+in\s+(?:my\s+)?archive)\s*[.!?]*$/i, command: '@SeekDeep archive me', note: 'To save an image to your archive, click the green Archive button under the image, or click Shared Archive for the server-wide archive. `@SeekDeep archive me` opens your archive thread.' },
  ].find((item) => item.re.test(p));

  if (direct) {
    return ['Did you mean `' + direct.command + '`?', '', direct.note].filter(Boolean).join('\n');
  }

  if (!seekdeepLooksCommandLike(p)) return '';

  let best = null;
  for (const item of seekdeepKnownCommandSuggestions()) {
    for (const alias of item.aliases || []) {
      const a = seekdeepNormalizeCommandSuggestionInput(alias);
      if (!a) continue;
      const prefixBoost = a.startsWith(p) || p.startsWith(a) ? -1 : 0;
      const sharedWords = p.split(/\s+/).filter((word) => word.length > 2 && a.split(/\s+/).includes(word)).length;
      const distance = seekdeepCommandSuggestionDistance(p.slice(0, 42), a.slice(0, 42));
      const score = distance + prefixBoost - sharedWords;
      if (!best || score < best.score) best = { score, command: item.command, alias: a, distance, sharedWords };
    }
  }

  if (!best) return '';
  const allowedDistance = p.length <= 6 ? 2 : Math.max(2, Math.ceil(Math.min(p.length, best.alias.length) * 0.34));
  const closeEnough = best.distance <= allowedDistance || best.sharedWords >= 1;
  if (!closeEnough) return '';

  return ['Did you mean `' + best.command + '`?', '', 'Use `@SeekDeep help` for the full supported command map.'].join('\n');
}
// SEEKDEEP_COMMAND_SUGGESTIONS_V1_END

// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V2_START
const SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2 = globalThis.__seekdeepPendingImageSubjectRequestsV2 || new Map();
globalThis.__seekdeepPendingImageSubjectRequestsV2 = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2;

function seekdeepPendingImageSubjectKeyFromMessageV2(message) {
  const channelId = message?.channel?.id || 'unknown-channel';
  const userId = message?.author?.id || 'unknown-user';
  return channelId + ':' + userId;
}

function seekdeepIsEmptyImageCommandPromptV2(prompt = '') {
  const clean = normalizeUserText(String(prompt || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(/^\s*@?(?:seekdeep|seekotics)[,:]?\s+/i, ' ')
  ).toLowerCase();

  if (!clean) return false;

  return /^(?:please\s+)?(?:show(?:\s+me)?|generate(?:\s+me)?|create(?:\s+me)?|make(?:\s+me)?|draw(?:\s+me)?|sketch(?:\s+me)?|render(?:\s+me)?|paint(?:\s+me)?|illustrate(?:\s+me)?|design(?:\s+me)?)(?:\s+(?:an?\s+|some\s+|the\s+)?(?:image|picture|photo|pic|art|artwork|drawing|illustration|poster|logo|icon|wallpaper|something|it|that|this|one))?\s*$/i.test(clean);
}

function seekdeepPendingImageSubjectCleanPromptV2(prompt = '') {
  let clean = String(prompt || '');

  if (typeof seekdeepStripCommandAddressingForRouting === 'function') {
    clean = seekdeepStripCommandAddressingForRouting(clean);
  } else if (typeof seekdeepCleanMessageCommandPrompt === 'function') {
    clean = seekdeepCleanMessageCommandPrompt(clean);
  } else {
    clean = clean
      .replace(/<@!?\d+>/g, ' ')
      .replace(/<@&\d+>/g, ' ')
      .replace(/^\s*(?:@?seekdeep|@?seekotics)[,:]?\s+/i, ' ');
  }

  if (typeof seekdeepExtractImagePrompt === 'function') {
    const extracted = seekdeepExtractImagePrompt(clean);
    if (extracted) clean = extracted;
  }

  return normalizeUserText(clean).trim();
}

function seekdeepIsMissingImageSubjectPromptV2(prompt = '') {
  const stripped = typeof seekdeepStripCommandAddressingForRouting === 'function'
    ? seekdeepStripCommandAddressingForRouting(prompt)
    : String(prompt || '');

  if (seekdeepIsEmptyImageCommandPromptV2(stripped)) return true;

  const clean = seekdeepPendingImageSubjectCleanPromptV2(prompt).toLowerCase();
  if (!clean) return false;

  return seekdeepIsEmptyImageCommandPromptV2(clean);
}

function seekdeepRememberPendingImageSubjectRequestV2(message, options = {}) {
  const key = seekdeepPendingImageSubjectKeyFromMessageV2(message);
  const now = Date.now();
  const ttlMs = Math.max(30000, Number(process.env.SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS || 2 * 60 * 1000));

  const existing = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.get(key);
  const alreadyPending = Boolean(existing?.expiresAt && Number(existing.expiresAt) > now);

  const state = {
    ...(alreadyPending ? existing : {}),
    channelId: message?.channel?.id || '',
    userId: message?.author?.id || '',
    createdAt: alreadyPending ? existing.createdAt : now,
    updatedAt: now,
    expiresAt: now + ttlMs,
    width: Number(options.width || existing?.width || 1024),
    height: Number(options.height || existing?.height || 1024),
    seed: options.seed ?? existing?.seed ?? null,
    wantsOriginal: options.wantsOriginal !== false,
    wantsRefined: options.wantsRefined !== false,
    ground: options.ground !== false,
  };

  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.set(key, state);
  return { alreadyPending, state };
}

function seekdeepPeekPendingImageSubjectRequestV2(message) {
  const key = seekdeepPendingImageSubjectKeyFromMessageV2(message);
  const state = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.get(key);
  const now = Date.now();

  if (!state) return null;
  if (!state.expiresAt || Number(state.expiresAt) <= now) {
    SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.delete(key);
    return null;
  }

  return state;
}

function seekdeepConsumePendingImageSubjectRequestV2(message, prompt = '') {
  const state = seekdeepPeekPendingImageSubjectRequestV2(message);
  if (!state) return null;

  const raw = normalizeUserText(prompt).trim();
  if (!raw) return null;

  // Do not consume another incomplete image command as the subject. Refresh the pending state instead.
  if (seekdeepIsMissingImageSubjectPromptV2(raw)) return null;

  const lower = raw.toLowerCase();
  if (/^(?:help|commands|status|archive|setup|queue|cache|recent|purge|delete|remove|stop|cancel)\b/i.test(lower)) return null;
  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(raw)) return null;
  if (/^(?:what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/i.test(lower)) return null;
  if (typeof seekdeepIsFrustrationPrompt === 'function' && seekdeepIsFrustrationPrompt(raw)) return null;

  const subject = seekdeepPendingImageSubjectCleanPromptV2(raw);
  if (!subject) return null;
  if (seekdeepIsMissingImageSubjectPromptV2(subject)) return null;
  if (typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(subject)) return null;

  const key = seekdeepPendingImageSubjectKeyFromMessageV2(message);
  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.delete(key);
  return { ...state, prompt: subject };
}

async function seekdeepHandleMissingImageSubjectCommandV2(message, prompt = '', key = '') {
  if (!seekdeepIsMissingImageSubjectPromptV2(prompt)) return false;

  // Before asking the user "what should I generate?", check whether the most recent
  // assistant message in this channel/user memory is substantive enough to use as the
  // image subject. This lets flows like: "tell me a story" -> story -> "generate the
  // image" auto-resolve to image generation of the story without a second prompt.
  const recentAssistant = typeof seekdeepLastAssistantTextSafe === 'function'
    ? seekdeepLastAssistantTextSafe(key)
    : '';

  if (recentAssistant) {
    if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-missing-subject-context-fill', recentAssistant.slice(0, 80));
    if (typeof remember === 'function' && key) {
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', 'Using recent context as image subject.');
    }
    if (typeof seekdeepSetResponseModel === 'function' && typeof seekdeepNoModelLabel === 'function') {
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    }
    seekdeepStopTypingSafelyForMessage(message);
    if (typeof seekdeepSendImageWithButtonsMessage === 'function') {
      // Pass the recent context as the image subject. The image-prompt refinement
      // step (default_chat role, pinned earlier) will distill it into a visual prompt.
      await seekdeepSendImageWithButtonsMessage(message, recentAssistant, 1024, 1024, null, {
        refine: true,
        ground: true,
        cleanPrompt: recentAssistant,
        skipCooldown: true,
      });
      return true;
    }
  }

  seekdeepRememberPendingImageSubjectRequestV2(message, {
    width: 1024,
    height: 1024,
    seed: null,
    wantsOriginal: true,
    wantsRefined: true,
    ground: true,
  });

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-missing-subject', prompt);
  if (typeof remember === 'function' && key) {
    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', 'What should I generate an image of?');
  }
  if (typeof seekdeepSetResponseModel === 'function' && typeof seekdeepNoModelLabel === 'function') {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  }

  const footerOptions = {
    startedAt: typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now(),
    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
  };

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter('What should I generate an image of?', footerOptions)
    : 'What should I generate an image of?';

  seekdeepStopTypingSafelyForMessage(message);

  try {
    await message.reply({
      content,
      allowedMentions: { repliedUser: false },
    });
  } finally {
    seekdeepStopTypingSafelyForMessage(message);
  }
  return true;
}

async function seekdeepHandlePendingImageSubjectReplyV2(message, prompt = '', key = '') {
  const pending = seekdeepConsumePendingImageSubjectRequestV2(message, prompt);
  if (!pending?.prompt) return false;

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-pending-subject', pending.prompt);
  if (typeof remember === 'function' && key) {
    seekdeepRememberSafeV13(key, 'user', '[pending-image-subject] ' + pending.prompt);
    seekdeepRememberSafeV13(key, 'assistant', 'Queued pending image subject.');
  }
  if (typeof seekdeepSetResponseModel === 'function' && typeof seekdeepNoModelLabel === 'function') {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  }

  const footerOptions = {
    startedAt: typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now(),
    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
  };

  const ack = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter('Queued both:\n- Original\n- Refined', footerOptions)
    : 'Queued both:\n- Original\n- Refined';

  await message.reply({
    content: ack,
    allowedMentions: { repliedUser: false },
  });
  seekdeepStopTypingSafelyForMessage(message);

  if (typeof seekdeepSendImageWithButtonsMessage !== 'function') {
    throw new Error('seekdeepSendImageWithButtonsMessage is not available for pending image subject follow-up.');
  }

  try {
    await seekdeepSendImageWithButtonsMessage(message, pending.prompt, pending.width || 1024, pending.height || 1024, pending.seed ?? null, {
      refine: false,
      ground: pending.ground !== false,
      cleanPrompt: pending.prompt,
      skipCooldown: true,
      silentAck: true,
    });

    await seekdeepSendImageWithButtonsMessage(message, pending.prompt, pending.width || 1024, pending.height || 1024, pending.seed ?? null, {
      refine: true,
      ground: pending.ground !== false,
      cleanPrompt: pending.prompt,
      skipCooldown: true,
      silentAck: true,
    });
  } finally {
    seekdeepStopTypingSafelyForMessage(message);
  }

  return true;
}
// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V2_END

function seekdeepUtilityPromptKind(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return '';

  // Model identity/status is a hard local command. Keep it out of Qwen chat persona routing.
  if (typeof seekdeepIsModelStatusQuestion === 'function' && seekdeepIsModelStatusQuestion(p)) return 'model-status';

  // Local archive dump/import commands are intentionally not exposed.
  if (typeof isPostArchivePrompt === 'function' && isPostArchivePrompt(p)) return '';
  if (/^(post|dump|upload|send)\s+(the\s+)?archive\b/.test(p)) return '';

  // Queue status, including common typo observed during testing.
  if (/^(queue|que)\s+status\b/.test(p)) return 'image-queue';
  if (/^(image\s+queue|generation\s+queue|image\s+generation\s+queue)\b/.test(p)) return 'image-queue';

  // Help aliases. Keep archive/help variants local instead of sending them to chat.
  if (/^(help|commands|command list|what can you do|what are your commands)\b/.test(p)) return 'help';
  if (/^(archive|archives|image|images|vision|cache|queue|recent|status|model)\s+(help|commands)\b/.test(p)) return 'help';
  if (/^(help|commands)\s+(archive|archives|image|images|vision|cache|queue|recent|status|model)\b/.test(p)) return 'help';

  if (/^(cache status|image cache status|temp cache status|cache)\b/.test(p)) return 'cache';
  if (/^(archive status|saved generation status|saved generations status)\b/.test(p)) return 'archive';
  if (/^(recent images|recent image|image history|recent generations|generation history)\b/.test(p)) return 'recent-images';
  if (/^(recent prompts|recent prompt|prompt history|last prompts|last prompt)\b/.test(p)) return 'recent-prompts';
  if (typeof seekdeepIsTextRegenerateImagePrompt === 'function' && seekdeepIsTextRegenerateImagePrompt(p)) return 'regenerate-image';
  if (/^(admin status|am i admin)\b/.test(p)) return 'admin';

  return '';
}

function seekdeepUtilityText(kind, source, key) {
  switch (kind) {
    case 'help': return seekdeepHelpText(source);
    case 'cache': return seekdeepCacheStatusText();
    case 'archive': return seekdeepArchiveStatusText();
    case 'recent-images': return seekdeepRecentImagesText(10);
    case 'recent-prompts': return seekdeepRecentPromptsText(key, 12);
    case 'admin': return ['SeekDeep admin status', '', seekdeepAdminLine(source)].join('\n');
    case 'image-queue': return seekdeepImageQueueStatusText();
    default: return '';
  }
}
// SEEKDEEP_BATCH1_UTILITY_END

function seekdeepCleanRemovedArchiveCommandLine(value = '') {
  return normalizeUserText(String(value || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(/\b@?(?:seekdeep|seekotics)\b[,:-]?/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
  ).toLowerCase();
}

function seekdeepRemovedArchiveCommandLines(prompt = '') {
  const raw = String(prompt || '');
  const candidates = raw.split(/\r?\n+/).map(seekdeepCleanRemovedArchiveCommandLine).filter(Boolean);
  const whole = seekdeepCleanRemovedArchiveCommandLine(raw);
  if (whole && !candidates.includes(whole)) candidates.push(whole);

  const removed = [];
  for (const line of candidates) {
    if (
      /^(?:post|dump|upload|send)\s+(?:the\s+)?archive$/.test(line) ||
      /^(?:post|show)\s+saved\s+images$/.test(line) ||
      /^post\s+saved_generations$/.test(line) ||
      /^(?:migrate\s+archive|migratearchive|archive\s+migrate|archive\s+migration|migrate\s+archives|remigrate\s+archive|remigrate\s+archives|archive\s+remigrate)(?:\s+all)?$/.test(line)
    ) {
      if (!removed.includes(line)) removed.push(line);
    }
  }

  return removed;
}

function seekdeepRemovedArchiveCommandText(prompt = '') {
  const removed = seekdeepRemovedArchiveCommandLines(prompt);
  if (!removed.length) return '';

  const lineList = removed.map((line) => '- ' + line).join('\n');
  return [
    'That archive command has been removed.',
    '',
    lineList,
    '',
    'Archive storage now uses Discord threads only.',
    'Use the `Archive` or `Shared Archive` button on a generated image, or use `@SeekDeep archive status` to inspect thread storage.',
    '',
    'Send one command per Discord message when testing routes.',
  ].join('\n');
}

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask SeekDeep using the local model.')
    .addStringOption((o) => o.setName('prompt').setDescription('Question or prompt').setRequired(true))
    .addStringOption((o) =>
      o.setName('web')
        .setDescription('Web-search behavior')
        .setRequired(false)
        .addChoices(
          { name: 'auto', value: 'auto' },
          { name: 'off', value: 'off' },
          { name: 'always', value: 'always' },
        )
    ),
  new SlashCommandBuilder()
    .setName('refine')
    .setDescription('Rewrite/improve a prompt.')
    .addStringOption((o) => o.setName('prompt').setDescription('Prompt to improve').setRequired(true)),
  new SlashCommandBuilder()
    .setName('image')
    .setDescription('Generate an image locally.')
    .addStringOption((o) => o.setName('prompt').setDescription('Image prompt').setRequired(true))
    .addIntegerOption((o) => o.setName('width').setDescription('Width, default 1024').setRequired(false))
    .addIntegerOption((o) => o.setName('height').setDescription('Height, default 1024').setRequired(false))
    .addIntegerOption((o) => o.setName('seed').setDescription('Optional seed').setRequired(false)),
  new SlashCommandBuilder()
    .setName('vision')
    .setDescription('Analyze an attached image/video locally.')
    .addAttachmentOption((o) => o.setName('file').setDescription('Image or video').setRequired(true))
    .addStringOption((o) => o.setName('prompt').setDescription('Question about the media').setRequired(false)),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show SeekDeep command help.'),
  new SlashCommandBuilder()
    .setName('cachestatus')
    .setDescription('Show temp image cache status.'),
  new SlashCommandBuilder()
    .setName('archivestatus')
    .setDescription('Show permanent image archive status.'),
  new SlashCommandBuilder()
    .setName('recent')
    .setDescription('Show recent SeekDeep items.')
    .addStringOption((o) =>
      o.setName('kind')
        .setDescription('Recent item type')
        .setRequired(false)
        .addChoices(
          { name: 'images', value: 'images' },
          { name: 'prompts', value: 'prompts' },
        )
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show local backend status.'),

  // Right-click message context menu commands. Show up under Apps when the user
  // right-clicks any Discord message.
  new ContextMenuCommandBuilder()
    .setName('Generate Image from this')
    .setType(ApplicationCommandType.Message),
  new ContextMenuCommandBuilder()
    .setName('Refine as Image Prompt')
    .setType(ApplicationCommandType.Message),
  new ContextMenuCommandBuilder()
    .setName('Inspect (SeekDeep)')
    .setType(ApplicationCommandType.Message),
].map((c) => c.toJSON());

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Chat provider: Local NVIDIA model server');
  console.log(`Chat model: ${process.env.LOCAL_CHAT_MODEL_ID || 'Qwen/Qwen3-8B'}`);
  console.log('Image provider: Local NVIDIA model server');
  console.log('Vision provider: Local model server');
  console.log(`Web search provider: ${WEB_SEARCH_PROVIDER}`);
  console.log('Message content mode: ON');

  try {
    await client.application.commands.set(commands);
    console.log('Registered commands globally. They may take time to appear.');
  } catch (err) {
    console.error('Command registration failed:', err);
  }

  console.log('Ready. Use: /ask, /refine, /image, /vision, /status, /help');
});

process.on('unhandledRejection', (err) => {
  if (seekdeepIsDiscordAbortError(err)) {
    seekdeepLogDiscordAbort('Unhandled Discord REST abort', err);
    return;
  }

  console.error('Unhandled promise rejection:', err);
});

process.on('uncaughtException', (err) => {
  if (seekdeepIsDiscordAbortError(err)) {
    seekdeepLogDiscordAbort('Uncaught Discord REST abort', err);
    return;
  }

  console.error('Uncaught exception:', err);
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});


async function safeDefer(interaction) {
  try {
    if (!interaction) return false;

    if (typeof interaction.isRepliable === 'function' && !interaction.isRepliable()) {
      return false;
    }

    if (interaction.deferred || interaction.replied) {
      return true;
    }

    await interaction.deferReply();
    return true;
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      console.warn('Could not defer interaction; it is already closed or acknowledged.');
      return false;
    }
    console.error('Could not defer interaction. It may have expired before acknowledgement:', err);
    return false;
  }
}


function seekdeepIsDiscordExplicitContentBlock(err) {
  const code = Number(err?.code || err?.rawError?.code || 0);
  const message = String(err?.message || err?.rawError?.message || err || '').toLowerCase();
  return code === 20009 || message.includes('explicit content cannot be sent');
}

function seekdeepExplicitContentBlockedText() {
  return [
    'Discord blocked the generated image attachment for this recipient/channel.',
    'Generation completed locally, but I cannot send that image here because of Discord explicit-media filtering.',
  ].join('\n');
}


async function safeEditOrReply(interaction, payload) {
  try {
    if (!interaction) return null;

    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }

    return await interaction.reply(payload);
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      console.warn('Could not reply to interaction; it is already closed or acknowledged.');
      return null;
    }

    // SEEKDEEP_EXPLICIT_CONTENT_INTERACTION_FALLBACK_START
    if (seekdeepIsDiscordExplicitContentBlock(err)) {
      console.warn('Discord blocked generated image attachment for this interaction; sending text-only notice.');

      const fallbackPayload = {
        content: seekdeepExplicitContentBlockedText(),
        allowedMentions: { repliedUser: false },
        files: [],
        attachments: [],
        components: [],
      };

      try {
        if (interaction?.deferred || interaction?.replied) {
          return await interaction.editReply(fallbackPayload);
        }
        return await interaction.reply(fallbackPayload);
      } catch (fallbackErr) {
        console.error('Could not send explicit-content fallback interaction response:', fallbackErr);
        return null;
      }
    }
    // SEEKDEEP_EXPLICIT_CONTENT_INTERACTION_FALLBACK_END

    if (seekdeepIsDiscordAbortError(err)) {
      seekdeepLogDiscordAbort('Could not send interaction response', err);
    } else {
      console.error('Could not send interaction response:', err);
    }
    return null;
  }
}


// SEEKDEEP_LONG_REPLY_HELPERS_START

function asTextBlock(value, lang = 'text') {
  return `\`\`\`${lang}\n${String(value ?? '').trim()}\n\`\`\``;
}

function stopSeekDeepTypingLoopForMessage(message) {
  try {
    if (message && message.__seekdeepTypingLoop) {
      message.__seekdeepTypingLoop.stop();
      message.__seekdeepTypingLoop = null;
    }
  } catch (err) {
    console.error('Failed to stop typing loop:', err?.message || err);
  }
}


// SEEKDEEP_QWEN_THINK_STRIP_START
function stripQwenThinkingBlocks(value) {
  let text = String(value ?? '');

  // Remove complete Qwen3 thinking blocks.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // If the model was cut off while still thinking, discard that leaked section.
  text = text.replace(/<think>[\s\S]*$/i, '');

  // Remove loose closing tags.
  text = text.replace(/<\/think>/gi, '');

  return text.trim();
}
// SEEKDEEP_QWEN_THINK_STRIP_END

async function sendLongMessageReply(message, content, meta = {}) {
  seekdeepMarkRequestStart(message);
  stopSeekDeepTypingLoopForMessage(message);

  if (!seekdeepClaimFinalReply('message', message?.id)) {
    return null;
  }

  if (typeof cleanLoopingReply === 'function') {
    content = cleanLoopingReply(content);
  } else if (typeof stripQwenThinkingBlocks === 'function') {
    content = stripQwenThinkingBlocks(content);
  }

  if (!String(content || '').trim()) {
    content = '[SeekDeep generated an empty response after cleanup. This usually means the model only produced hidden <think> output or the output was stripped as invalid.]';
  }

  content = seekdeepAppendResponseFooter(content, {
    startedAt: meta.startedAt || message?.__seekdeepRequestStartedAt,
    modelUsed: meta.modelUsed || seekdeepModelUsedForMessage(message, content),
  });

  const chunks = splitDiscordText(content)
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean);

  if (!chunks.length) {
    chunks.push(seekdeepAppendResponseFooter('[SeekDeep generated no sendable text.]', {
      startedAt: meta.startedAt || message?.__seekdeepRequestStartedAt,
      modelUsed: meta.modelUsed || seekdeepModelUsedForMessage(message, content),
    }));
  }

  let previous = null;

  async function sendViaChannel(payload) {
    if (!message.channel || typeof message.channel.send !== 'function') {
      throw new Error('No channel.send available for fallback message delivery.');
    }

    return await message.channel.send({
      content: payload.content,
      allowedMentions: payload.allowedMentions || { repliedUser: false },
    });
  }

  async function sendFirstChunk(payload) {
    try {
      return await message.reply(payload);
    } catch (err) {
      const code = err?.code;
      const raw = String(err?.rawError?.message || '');
      const msg = String(err?.message || '');

      const referenceFailed =
        code === 10008 ||
        code === 50035 ||
        raw.includes('Invalid Form Body') ||
        raw.includes('Unknown message') ||
        msg.includes('Unknown message') ||
        msg.includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE');

      if (referenceFailed) {
        console.warn(`Source message reference failed; falling back to channel.send for message ${message?.id}`);
      } else {
        console.error('message.reply failed; falling back to channel.send:', err);
      }

      return await sendViaChannel(payload);
    }
  }

  async function sendFollowupChunk(parent, payload) {
    if (parent && typeof parent.reply === 'function') {
      try {
        return await parent.reply(payload);
      } catch (err) {
        console.warn('Follow-up reply failed; falling back to channel.send:', err?.message || err);
      }
    }

    return await sendViaChannel(payload);
  }

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (i === 0) {
      previous = await sendFirstChunk(payload);
    } else {
      previous = await sendFollowupChunk(previous, payload);
    }
  }

  return previous;
}

// SEEKDEEP_LONG_REPLY_HELPERS_END


// SEEKDEEP_TYPING_WORKING_HOTFIX_START
function seekdeepStartWorkingLoop(channel, label = 'working') {
  if (typeof startSeekDeepTypingLoop === 'function') {
    return startSeekDeepTypingLoop(channel, label);
  }

  let stopped = false;
  let interval = null;

  const tick = async () => {
    if (stopped) return;
    try {
      if (channel && typeof channel.sendTyping === 'function') {
        await channel.sendTyping();
      }
    } catch (err) {
      console.warn(`Working indicator failed for ${label}:`, err?.message || err);
    }
  };

  tick();
  interval = setInterval(tick, Number(process.env.SEEKDEEP_TYPING_INTERVAL_MS || 8000));

  return {
    stop() {
      stopped = true;
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}

function seekdeepStopWorkingLoop(loop) {
  try {
    if (loop && typeof loop.stop === 'function') loop.stop();
  } catch {}
}
// SEEKDEEP_TYPING_WORKING_HOTFIX_END

// SEEKDEEP_TYPING_DEDUPE_START
const SEEKDEEP_EVENT_TTL_MS = Number(process.env.SEEKDEEP_EVENT_TTL_MS || 120000);
const SEEKDEEP_PROMPT_TTL_MS = Number(process.env.SEEKDEEP_PROMPT_TTL_MS || 30000);
const SEEKDEEP_TYPING_INTERVAL_MS = Number(process.env.SEEKDEEP_TYPING_INTERVAL_MS || 8000);
const SEEKDEEP_TYPING_MAX_MS = Number(process.env.SEEKDEEP_TYPING_MAX_MS || 120000);

const seekdeepSeenEvents = new Map();
const seekdeepSeenPrompts = new Map();

function seekdeepNow() {
  return Date.now();
}

function seekdeepSweepMap(map, now = seekdeepNow()) {
  for (const [key, expires] of map.entries()) {
    if (expires <= now) map.delete(key);
  }
}

function seekdeepClaimOnce(map, key, ttlMs) {
  const now = seekdeepNow();
  seekdeepSweepMap(map, now);

  if (map.has(key) && map.get(key) > now) {
    return false;
  }

  map.set(key, now + ttlMs);
  return true;
}

function seekdeepClaimEventOnce(key, ttlMs = SEEKDEEP_EVENT_TTL_MS) {
  return seekdeepClaimOnce(seekdeepSeenEvents, key, ttlMs);
}

function seekdeepNormalizePromptForDedupe(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function seekdeepClaimPromptOnce(kind, userId, channelId, prompt, ttlMs = SEEKDEEP_PROMPT_TTL_MS) {
  const normalized = seekdeepNormalizePromptForDedupe(prompt);
  if (!normalized) return true;

  const key = `${kind}:${userId || 'unknown'}:${channelId || 'unknown'}:${normalized}`;
  return seekdeepClaimOnce(seekdeepSeenPrompts, key, ttlMs);
}

function startSeekDeepTypingLoop(channel, label = 'request') {
  let stopped = false;
  let interval = null;
  let hardStop = null;

  const tick = async () => {
    if (stopped) return;

    try {
      if (channel && typeof channel.sendTyping === 'function') {
        await channel.sendTyping();
      }
    } catch (err) {
      console.error(`Typing indicator failed for ${label}:`, err?.message || err);
    }
  };

  tick();

  interval = setInterval(tick, SEEKDEEP_TYPING_INTERVAL_MS);
  hardStop = setTimeout(() => {
    stop();
  }, SEEKDEEP_TYPING_MAX_MS);

  function stop() {
    if (stopped) return;
    stopped = true;

    if (interval) {
      clearInterval(interval);
      interval = null;
    }

    if (hardStop) {
      clearTimeout(hardStop);
      hardStop = null;
    }
  }

  return { stop };
}
// SEEKDEEP_TYPING_DEDUPE_END


// SEEKDEEP_NATURAL_ROUTING_START
function seekdeepAttachmentLooksVisual(attachment) {
  if (!attachment) return false;

  const contentType = String(attachment.contentType || '').toLowerCase();
  const name = String(attachment.name || '').toLowerCase();
  const url = String(attachment.url || '').toLowerCase();

  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    /\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|mkv)$/i.test(name) ||
    /\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|mkv)(\?|$)/i.test(url)
  );
}

function seekdeepFirstVisualAttachment(message) {
  if (!message?.attachments?.size) return null;

  for (const attachment of message.attachments.values()) {
    if (seekdeepAttachmentLooksVisual(attachment)) return attachment;
  }

  return null;
}

async function seekdeepGetReplyVisualAttachment(message) {
  try {
    const refId = message?.reference?.messageId;
    if (!refId || !message?.channel) return null;

    const replied = await message.channel.messages.fetch(refId);
    return seekdeepFirstVisualAttachment(replied);
  } catch (err) {
    console.error('Could not inspect replied-to message for visual media:', err?.message || err);
    return null;
  }
}

function seekdeepLooksLikeVisionPrompt(text = '') {
  const t = normalizeUserText(text).toLowerCase().trim();
  if (!t) return true;

  return (
    /\bwhat(?:'s| is)\s+(?:this|that)\b/.test(t) ||
    /\bwhat the fuck is this\b/.test(t) ||
    /\bwtf is this\b/.test(t) ||
    /\bdescribe\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\bidentify\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\bcaption\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\banaly[sz]e\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\bwhat do you see\b/.test(t) ||
    /\bwhat is in (?:this|that|the image|the picture|the photo)\b/.test(t) ||
    /\bvision\b/.test(t)
  );
}

// SEEKDEEP_ROUTING_TEXT_GUARD_HELPERS_START
function seekdeepHasExplicitImageRequest(p = '') {
  const text = seekdeepCleanMessageCommandPrompt(
    (typeof normalizeUserText === 'function' ? normalizeUserText(p) : String(p || ''))
  ).toLowerCase().trim();

  if (!text) return false;

  if (/^(?:show\s+me|show|draw\s+me|draw|generate(?:\s+me)?|create(?:\s+me)?|make(?:\s+me)?|render(?:\s+me)?|paint(?:\s+me)?|sketch(?:\s+me)?|illustrate(?:\s+me)?|design(?:\s+me)?)\s+\S+/i.test(text) &&
      !/\b(?:status|queue|help|commands|archive|cache|recent|prompt history|model status|list|ideas|suggestions|options|names|script|code|powershell|table|spreadsheet|summary|explanation)\b/i.test(text)) {
    return true;
  }

  if (/\b(generate|create|make|draw|render|paint|illustrate|design)\s+(?:me\s+)?(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\b/i.test(text)) {
    return true;
  }

  if (/\b(image|picture|photo|pic|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\b/i.test(text)) {
    return true;
  }

  if (typeof seekdeepHasVisualSubjectWords === 'function' && /\b(?:draw|sketch|paint|illustrate|show me|show)\b/i.test(text) && seekdeepHasVisualSubjectWords(text)) {
    return true;
  }

  // Third-person / mention-form image asks: "X wants an image", "user needs a picture",
  // "we need an image to accompany this", "an image please", "image to go with this story".
  if (/\b(?:wants?|wanted|wanting|needs?|needed|needing|would\s+like|d\s*like|prefer|like|love|please|pls)\s+(?:to\s+(?:see|have|get)\s+)?(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait|illustration|render|painting|sketch)\b/i.test(text)) {
    return true;
  }

  // "image/picture to accompany this" / "to go with this" / "for this story"
  if (/\b(?:image|picture|photo|pic|art|artwork|drawing|illustration|render|painting|sketch)\s+(?:to\s+(?:accompany|go\s+with|match|pair\s+with|illustrate)|for\s+(?:this|that|the))\b/i.test(text)) {
    return true;
  }

  // "make/create/render an image" without a direct subject — relies on context
  if (/\b(?:make|create|render|paint|draw|sketch|illustrate|design|produce|whip\s+up)\s+(?:me\s+|us\s+)?(?:an?\s+|the\s+)?(?:image|picture|photo|pic|art|artwork|drawing|illustration|painting|render|sketch)\b/i.test(text)) {
    return true;
  }

  return false;
}

function seekdeepHasTextListIntent(p = '') {
  return /\b(names?|nicknames?|name ideas?|list|ideas?|concepts?|directions?|variations?|options?|suggestions?|recommendations?|examples?|titles?|captions?|phrases?|slogans?|handles?|usernames?|commands?|features?|checklist|bullet points?)\b/i.test(p);
}

function seekdeepHasCountRequest(p = '') {
  return /\b(?:give me|make me|create|generate|list|suggest|name)\s+(?:a\s+)?(?:list\s+of\s+)?\d{1,3}\b/i.test(p) ||
    /^\s*\d{1,3}\s+\w+/i.test(p);
}

function seekdeepHasQuestionOrExplanationIntent(p = '') {
  return /\b(refine|rewrite|improve|explain|tell me about|story|checklist|what is|who is|why|how|status|help|advice|compare|summarize|describe in words)\b/i.test(p);
}

function seekdeepHasVisualStyleWords(p = '') {
  return /\b(hyper\s*realistic|photorealistic|realistic|cinematic|anime|manga|oil painting|watercolor|digital art|illustration|poster|portrait|wallpaper|logo|icon|sticker|3d render|render|concept art|fantasy|surreal|gothic|punk|emo|cottagecore|cyberpunk|vaporwave|liminal|hd|ultra hd|4k|8k)\b/i.test(p);
}

function seekdeepHasVisualSubjectWords(p = '') {
  return /\b(cat|dog|frog|pepe|girl|woman|man|person|character|creature|monster|animal|monkey|banana|plant|flower|tree|forest|castle|city|room|car|robot|machine|dragon|elf|wizard|demon|angel|portrait|scene|background|landscape|avatar|emote|cannabis|marijuana|goomba|mario|mushroom)\b/i.test(p);
}

function seekdeepHasLikelyVisualDescription(p = '') {
  const text = String(p || '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 20) return false;

  if (seekdeepHasVisualStyleWords(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  if (/^(i need|need|i want|want)\b/i.test(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  // Short, concrete image-intent like "i need a red glass apple" — does not require the
  // noun to be in the visual-subject whitelist. Catches everyday objects (apple, bottle,
  // lamp, sword, mountain, etc.) without maintaining a 500-noun list.
  if (words.length >= 3 && words.length <= 15) {
    const hasImageIntent = /^(?:i\s+need|i\s+want|i\s+would\s+like|i'd\s+like|need|want|give\s+me|make\s+me|gimme|i'm\s+thinking\s+of|thinking\s+of)\s+(?:a|an|the|some)\s+/i.test(text);
    const isQuestion = /\?$/.test(text) || /^(?:what|why|how|when|where|who|is|are|do|does|can|could|should|would|will|tell\s+me)\b/i.test(text);
    const nonVisualIntent = /\b(?:recipe|song|joke|story|name(?:s)?|nickname|plan|list|advice|reason|explanation|summary|definition|meaning|opinion|tip|tutorial|guide|answer|article|essay|poem|lyrics|price|review|description\s+in\s+words|description\s+only|to\s+know|to\s+understand|to\s+find\s+out|help\s+with|hand|favor|moment|minute|second|break|rest|nap|drink|coffee|tea|water|beer|hug|kiss)\b/i.test(text);
    if (hasImageIntent && !isQuestion && !nonVisualIntent) {
      return true;
    }
  }

  return false;
}

function seekdeepShouldStayChatInsteadOfImage(p = '') {
  if (!p) return true;

  if (seekdeepHasExplicitImageRequest(p)) {
    return false;
  }

  if (seekdeepHasTextListIntent(p)) {
    return true;
  }

  if (seekdeepHasCountRequest(p)) {
    return true;
  }

  if (seekdeepHasQuestionOrExplanationIntent(p)) {
    return true;
  }

  return false;
}
// SEEKDEEP_ROUTING_TEXT_GUARD_HELPERS_END

function seekdeepLooksLikeImagePrompt(text = '') {
  const p = seekdeepCleanMessageCommandPrompt(
    (typeof normalizeUserText === 'function' ? normalizeUserText(text) : String(text || ''))
  ).toLowerCase().trim();

  if (!p) return false;

  if (typeof seekdeepLooksLikeVisionPrompt === 'function' && seekdeepLooksLikeVisionPrompt(p)) {
    return false;
  }

  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) {
    return false;
  }

  if (typeof seekdeepShouldStayChatInsteadOfImage === 'function' && seekdeepShouldStayChatInsteadOfImage(p)) {
    return false;
  }

  if (seekdeepHasExplicitImageRequest(p)) {
    return true;
  }

  if (/\b(show\s+me|show|generate|create|make|draw|render|paint|illustrate|design)\b/i.test(p) &&
      (!(typeof seekdeepHasVisualSubjectWords === 'function') || seekdeepHasVisualSubjectWords(p))) {
    return true;
  }

  if (typeof seekdeepHasLikelyVisualDescription === 'function' && seekdeepHasLikelyVisualDescription(p)) {
    return true;
  }

  return false;
}


// SEEKDEEP_RAW_IMAGE_MODE_START
function seekdeepImageRawModeRequested(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return (
    /(^|\s)--?(raw|unrefined|no-refine|norefine)(\s|$)/i.test(p) ||
    /(^|\s)(raw|unrefined)\s+(generate|create|make|draw|paint|sketch|illustrate|render|show)\b/i.test(p) ||
    /(^|\s)(no\s+refine|without\s+refinement|skip\s+refinement)\b/i.test(p)
  );
}

function seekdeepImageGroundingDisabled(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return (
    /(^|\s)--?(ungrounded|no-grounding|nogrounding)(\s|$)/i.test(p) ||
    /(^|\s)(no\s+grounding|without\s+grounding|skip\s+grounding)\b/i.test(p)
  );
}

function seekdeepCleanImageModeTokens(prompt = '') {
  let out = normalizeUserText(prompt);

  out = out
    .replace(/(^|\s)--?(raw|unrefined|no-refine|norefine)(?=\s|$)/gi, ' ')
    .replace(/(^|\s)--?(ungrounded|no-grounding|nogrounding)(?=\s|$)/gi, ' ')
    .replace(/\b(no\s+refine|without\s+refinement|skip\s+refinement)\b/gi, ' ')
    .replace(/\b(no\s+grounding|without\s+grounding|skip\s+grounding)\b/gi, ' ')
    .replace(/^\s*(raw|unrefined)\s+(?=(generate|create|make|draw|paint|sketch|illustrate|render|show)\b)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}


function seekdeepNormalizeObjectAccuracyPrompt(prompt = '') {
  let out = normalizeUserText(prompt).trim();
  if (!out) return out;

  const lower = out.toLowerCase();
  const objectOrDevice = /\b(playstation|ps1|ps2|ps3|ps4|ps5|xbox|nintendo|gamecube|dreamcast|console|controller|laptop|computer|pc|phone|camera|car|truck|vehicle|tower|castle|cathedral|building|hardware|device|machine|robot|logo|emblem|bag|item|object|prop)\b/i.test(lower);
  const livingSubject = /\b(person|human|man|woman|girl|boy|body|face|portrait|hands|eyes|cat|dog|animal|creature|dragon|monster|toad|frog|pepe|ripto|spyro|sailor\s*moon|homer|simpson)\b/i.test(lower);

  if (objectOrDevice && !livingSubject) {
    out = out
      .replace(/\banatomically\s+correct\b/gi, 'physically accurate, correct proportions')
      .replace(/\banatomical\s+accuracy\b/gi, 'physical accuracy, correct proportions')
      .replace(/\banatomy\b/gi, 'physical structure')
      .replace(/\baccurate anatomy\b/gi, 'accurate physical structure');
  }

  return out.replace(/\s+/g, ' ').trim();
}

function seekdeepImageModeOptionsFromPrompt(prompt = '') {
  return {
    refine: !seekdeepImageRawModeRequested(prompt),
    ground: !seekdeepImageGroundingDisabled(prompt),
    rawRequested: seekdeepImageRawModeRequested(prompt),
    groundingDisabled: seekdeepImageGroundingDisabled(prompt),
    cleanPrompt: seekdeepNormalizeObjectAccuracyPrompt(seekdeepCleanImageModeTokens(prompt)),
  };
}

function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (seekdeepLooksLikeGenerateOnlyPrompt(p)) return true;
  return /^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\s+me)?(?:\s+(an?\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p);
}

function seekdeepRefinementStatusLine(enabled = true, dynamicRefinement = false, dynamicRefinementAttempted = false) {
  if (!enabled) return 'Refinement: off';
  if (dynamicRefinement) return 'Refinement: on (AI-refined)';
  if (dynamicRefinementAttempted) return 'Refinement: on (static rules)';
  return 'Refinement: on';
}

function seekdeepGroundingStatusLine(result = null, options = {}) {
  if (options?.ground === false) return 'Grounding: off';
  if (result?.grounded) return 'Grounding: on';
  return '';
}
// SEEKDEEP_RAW_IMAGE_MODE_END


function seekdeepExtractImagePrompt(text = '') {
  let t = String(text || '');

  if (typeof seekdeepCleanImageModeTokens === 'function') {
    t = seekdeepCleanImageModeTokens(t);
  }

  t = t.replace(/<@!?\d+>/g, ' ').replace(/<@&\d+>/g, ' ').trim();
  t = t.replace(/^(?:hey|yo|hi|hello)\s+/i, '');
  t = t.replace(/^@?(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, '');

  if (typeof seekdeepIsEmptyImageCommandPromptV2 === 'function' && seekdeepIsEmptyImageCommandPromptV2(t)) {
    return '';
  }

  t = t.replace(/^(?:please\s+)?(?:show\s+me|show|make\s+me|generate(?:\s+me)?|create(?:\s+me)?|draw(?:\s+me)?|sketch(?:\s+me)?|render(?:\s+me)?|paint(?:\s+me)?|illustrate(?:\s+me)?|design(?:\s+me)?)\s+/i, '');
  t = t.replace(/^(?:an?\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\s+/i, '');
  t = t.replace(/^(?:i need|need|i want|want)\s+(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)?\s*(?:of|for)?\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();

  if (typeof seekdeepNormalizeObjectAccuracyPrompt === 'function') {
    t = seekdeepNormalizeObjectAccuracyPrompt(t);
  }

  return t;
}

async function seekdeepInferNaturalRoute(message, prompt) {
  const cleanPrompt = normalizeUserText(prompt || '');
  const directVisual = seekdeepFirstVisualAttachment(message);
  const replyVisual = await seekdeepGetReplyVisualAttachment(message);
  const visualAttachment = directVisual || replyVisual || null;

  if (visualAttachment && seekdeepLooksLikeVisionPrompt(cleanPrompt)) {
    return {
      route: 'vision',
      prompt: cleanPrompt || 'Describe this media clearly.',
      attachment: visualAttachment,
    };
  }

  if (seekdeepLooksLikeImagePrompt(cleanPrompt)) {
    return {
      route: 'image',
      prompt: seekdeepExtractImagePrompt(cleanPrompt) || cleanPrompt,
      attachment: null,
    };
  }

  return {
    route: 'chat',
    prompt: cleanPrompt,
    attachment: null,
  };
}
// SEEKDEEP_NATURAL_ROUTING_END


// SEEKDEEP_NATURAL_MEDIA_ROUTING_START

const SEEKDEEP_IMAGE_TRIGGER_RE = /\b(generate|create|make|draw|draw me|sketch|sketch me|render|paint|paint me|illustrate|illustrate me|show me|show|image of|picture of|photo of|portrait of|poster of|wallpaper of|design)\b/i;
const SEEKDEEP_VISION_TRIGGER_RE = /\b(what(?:'s| is) this|what am i looking at|describe this|describe (?:the|this) (?:image|picture|photo|screenshot|video)|identify this|analyze this|caption this|explain this(?: image| picture| photo| screenshot| video)?|what(?:'s| is) in this|what does this show)\b/i;
const SEEKDEEP_TEXT_ONLY_RE = /\b(refine|rewrite|improve|explain|tell me about|list|story|checklist|nickname|nicknames|name ideas?|what is|who is|why|how)\b/i;

// SEEKDEEP_DIRECT_IMAGE_ALIAS_ROUTE_START
function seekdeepIsBareConfirmationPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(?:y|yes|yeah|yep|yup|ok|okay|sure|do it|correct|please do|go ahead)$/.test(p);
}

function seekdeepStripDirectImageVerb(prompt = '') {
  return seekdeepStripCommandAddressingForRouting(prompt)
    .replace(/^(?:show\s+me|show|draw\s+me|draw|sketch\s+me|sketch|paint\s+me|paint|render\s+me|render|illustrate\s+me|illustrate|design\s+me|design|generate\s+me|generate|create\s+me|create|make\s+me|make)\s+/i, '')
    .replace(/^me\s+/i, '')
    .trim();
}

function seekdeepLooksLikeConversationalImageEditFollowup(prompt = '') {
  const p = seekdeepStripCommandAddressingForRouting(prompt).toLowerCase().trim();
  if (!p) return false;

  return /^(?:make|change|adjust|revise|refine|rewrite|improve)\s+(?:(?:the|that|this)\s+)?(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous|prior)\s+(?:one|idea|image|version|option|prompt)?|(?:one|it|that|this))\b/i.test(p);
}

function seekdeepCleanConversationalImageEditInstruction(prompt = '') {
  let p = seekdeepStripCommandAddressingForRouting(prompt).trim();

  p = p
    .replace(/^(?:make|change|adjust|revise|refine|rewrite|improve)\s+/i, '')
    .replace(/^(?:(?:the|that|this)\s+)?(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous|prior)\s+(?:one|idea|image|version|option|prompt)?|(?:one|it|that|this))\b/i, '')
    .replace(/^(?:and|to|as)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return p;
}

function seekdeepExtractGeneratedImagePromptFromText(value = '') {
  const text = String(value || '').replace(/\r\n/g, '\n');
  const refinedMatch = text.match(/^Refined Prompt:\s*(.+)$/im);
  if (refinedMatch?.[1]) return normalizeUserText(refinedMatch[1]);

  const generatedMatch = text.match(/^Generated:\s*(.+)$/im);
  if (generatedMatch?.[1]) return normalizeUserText(generatedMatch[1]);

  return '';
}

async function seekdeepGetGeneratedImageReplyContext(message = null) {
  if (!message?.reference?.messageId) return null;

  const replied = typeof fetchRepliedMessage === 'function'
    ? await fetchRepliedMessage(message)
    : null;
  if (!replied) return null;

  const content = String(replied.content || '');
  const hasGeneratedMarker = /^(?:Generated:|Refined Prompt:|Refinement:|Job ID:\s*imgq_)/im.test(content);
  const hasImageAttachment = Array.from(replied.attachments?.values?.() || []).some((attachment) => seekdeepAttachmentLooksVisual(attachment));
  const hasSeekdeepImageButtons = Array.from(replied.components || []).some((row) =>
    Array.from(row?.components || []).some((component) => /^seekdeep:(?:regen|archive|sharedarchive|shared-archive|shared_archive):/i.test(String(component?.customId || '')))
  );

  if (!hasGeneratedMarker && !(hasImageAttachment && hasSeekdeepImageButtons)) return null;

  const prompt = seekdeepExtractGeneratedImagePromptFromText(content);
  return {
    message: replied,
    prompt,
    hasImageAttachment,
    hasSeekdeepImageButtons,
  };
}

function seekdeepBuildImagePromptFromReplyEdit(replyContext = null, editPrompt = '') {
  const base = normalizeUserText(replyContext?.prompt || '').trim();
  const edit = seekdeepCleanConversationalImageEditInstruction(editPrompt);
  if (base && edit) return `${base}, ${edit}`;
  if (base) return base;
  return edit || normalizeUserText(editPrompt).trim();
}

function seekdeepIsDirectImageAliasPrompt(prompt = '', options = {}) {
  const p = seekdeepStripCommandAddressingForRouting(prompt).trim();
  const lower = p.toLowerCase();
  if (!p) return false;
  if (typeof seekdeepIsMissingImageSubjectPromptV2 === 'function' && seekdeepIsMissingImageSubjectPromptV2(p)) return false;
  if (seekdeepIsBareConfirmationPrompt(p)) return false;
  if (/\b(help|commands|status|queue|archive|cache|recent images|recent prompts|purge|delete|remove)\b/i.test(p)) return false;
  if (/\b(list|ideas?|suggestions?|options?|names?|nicknames?|summary|summarize|explain|rewrite|translate|code|script|powershell|javascript|python|logs?|error|bug)\b/i.test(p)) return false;
  if (!options.allowConversationalEditImage && seekdeepLooksLikeConversationalImageEditFollowup(p)) return false;
  if (/^(?:show\s+me|show|draw\s+me|draw|sketch\s+me|sketch|paint\s+me|paint|render\s+me|render|illustrate\s+me|illustrate|design\s+me|design)\s+\S/i.test(lower)) return true;
  if (/^(?:generate|create|make)\s+(?!(?:a\s+)?(?:list|summary|song|lyrics|description|script|code|function|patch|plan|guide|readme|email|message|reply)\b)(?:me\s+)?(?:a\s+|an\s+|the\s+|some\s+)?\S/i.test(lower)) return true;
  if (/^(?:show me|give me)\s+(?:a\s+|an\s+|the\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|illustration|poster|logo|icon|wallpaper)\b/i.test(lower)) return true;
  if (/^(?:image|picture|photo|pic|art|artwork|drawing|illustration|poster|logo|icon|wallpaper)\s+(?:of\s+|for\s+)?\S/i.test(lower)) return true;
  return false;
}
// SEEKDEEP_DIRECT_IMAGE_ALIAS_ROUTE_END

function isNaturalStatusPrompt(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return (
    p === 'status' ||
    p === '/status' ||
    /^status\??$/.test(p) ||
    /\bwhat(?:'s| is) your status\b/.test(p) ||
    (/\bhow\b/.test(p) && /\bstatus\b/.test(p))
  );
}

// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_START
// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_V8_START
// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_V8_START
function seekdeepStripCommandAddressingForRouting(value = '') {
  return normalizeUserText(value)
    .replace(/^(?:\s*(?:<@!?\d+>|<@&\d+>|@seekdeep|@seekotics|seekdeep|seekotics)[,;:!?-]?\s*)+/i, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_V8_END
// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_V8_END
// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_END

function isNaturalPongPrompt(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return p === 'ping' || p === 'say pong' || /(?:^|\s)say pong$/.test(p);
}

function isNaturalVisionPrompt(prompt) {
  const p = normalizeUserText(prompt);
  return SEEKDEEP_VISION_TRIGGER_RE.test(p);
}


// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_START
function seekdeepLooksLikeTextQuestion(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return true;

  // Visual permission / desire phrasing must not be swallowed by chat-question guards.
  if (/^(can|could|would)\s+(i|you|we)\s+(see|get|have|make|create|generate|draw|paint|render|visualize|design)\b/.test(p)) return false;
  if (/^(i\s+want|i'd\s+like|id\s+like|give\s+me|show\s+me|make|create|generate|draw|paint|render|visualize|design)\b/.test(p)) return false;

  return (
    /^(what|who|why|how|when|where|is|are|do|does|did)\b/.test(p) ||
    /\b(explain|summarize|summary|describe in words|tell me about|what is|who is|why is|how do|how to|steps|instructions|guide|advice|compare|difference between|translate|rewrite|proofread|fix this text|code|script|powershell|javascript|python|error|bug|logs?|status|queue status|admin status|cache status|archive status|help|commands)\b/.test(p)
  );
}

function seekdeepLooksLikeVisualRequest(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return false;
  if (typeof seekdeepShouldKeepPromptAsChatBeforeImage === 'function' && seekdeepShouldKeepPromptAsChatBeforeImage(p)) return false;

  const visualNouns = /\b(image|picture|pic|photo|art|artwork|drawing|illustration|painting|poster|album cover|cover art|banner|wallpaper|logo|icon|emblem|badge|character design|scene|portrait|sticker|thumbnail|concept art|screenshot|visual)\b/i;
  const creationVerbs = /\b(make|create|generate|render|draw|paint|sketch|illustrate|visualize|depict|design|show|give me|turn this into|can i see|could i see|i want|i'd like|id like)\b/i;
  const scenePreps = /\b(of|with|wearing|holding|standing|sitting|smoking|on a|in a|inside|outside|under|over|during|at sunset|at sunrise|at night|in armor|in the style of|with a|over a|under a)\b/i;
  const subjectCues = /\b(pepe|frog|cat|kitten|siamese|dog|dragon|robot|monster|anime|sailor moon|wizard|castle|cathedral|forest|tower|gothic|metal|punk|emo|screamo|hardcore|neon|album|poster|burning|armor|balcony|sunset|dead forest)\b/i;

  // Explicit visual nouns/verbs override the generic text-question guard.
  if (visualNouns.test(p) && (creationVerbs.test(p) || scenePreps.test(p) || subjectCues.test(p))) return true;
  if (creationVerbs.test(p) && visualNouns.test(p)) return true;
  if (creationVerbs.test(p) && subjectCues.test(p) && (scenePreps.test(p) || visualNouns.test(p))) return true;

  // Natural visual scene phrasing without explicit "draw/generate":
  // "Pepe and Sailor Moon smoking on a balcony at sunset"
  // "a gothic tower over a dead forest"
  if (subjectCues.test(p) && scenePreps.test(p)) return true;

  // Album/poster phrasing commonly means generate a visual even when phrased like "make..."
  if (/\b(make|create|generate|design|give me)\b/.test(p) && /\b(album cover|cover art|poster|banner|wallpaper|logo|emblem|badge)\b/.test(p)) return true;

  // "Can I see..." should be image if it names a concrete visual subject.
  if (/^(can|could)\s+i\s+see\b/.test(p) && (subjectCues.test(p) || scenePreps.test(p))) return true;

  return false;
}
// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_END


// SEEKDEEP_GROUNDED_IMAGE_CONTEXT_START
const SEEKDEEP_RECENT_IMAGE_SUBJECTS = globalThis.__seekdeepRecentImageSubjects || new Map();
globalThis.__seekdeepRecentImageSubjects = SEEKDEEP_RECENT_IMAGE_SUBJECTS;

function seekdeepImageContextKeyFromMessage(message) {
  const channelId = message?.channel?.id || 'unknown-channel';
  const userId = message?.author?.id || 'unknown-user';
  return `${channelId}:${userId}`;
}


function seekdeepRememberImageSubjectPrompt(message, prompt = '') {
  const clean = normalizeUserText(prompt).trim();
  if (!clean || seekdeepIsGenericImageFollowupPrompt(clean)) return;
  if (clean.length < 3 || clean.length > 300) return;

  SEEKDEEP_RECENT_IMAGE_SUBJECTS.set(seekdeepImageContextKeyFromMessage(message), {
    prompt: clean,
    at: Date.now(),
  });
}

// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V1_START
const SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS = globalThis.__seekdeepPendingImageSubjectRequests || new Map();
globalThis.__seekdeepPendingImageSubjectRequests = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS;

function seekdeepPendingImageSubjectKeyFromMessage(message) {
  const channelId = message?.channel?.id || 'unknown-channel';
  const userId = message?.author?.id || 'unknown-user';
  return `${channelId}:${userId}`;
}

function seekdeepPendingImageSubjectCleanPrompt(prompt = '') {
  let clean = typeof seekdeepStripCommandAddressingForRouting === 'function'
    ? seekdeepStripCommandAddressingForRouting(prompt)
    : seekdeepCleanMessageCommandPrompt(prompt);

  if (typeof seekdeepExtractImagePrompt === 'function') {
    const extracted = seekdeepExtractImagePrompt(clean);
    if (extracted) clean = extracted;
  }

  return normalizeUserText(clean).trim();
}

function seekdeepRememberPendingImageSubjectRequest(message, options = {}) {
  const key = seekdeepPendingImageSubjectKeyFromMessage(message);
  const now = Date.now();
  const ttlMs = Math.max(30000, Number(process.env.SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS || 2 * 60 * 1000));
  const existing = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.get(key);
  const alreadyPending = Boolean(existing?.expiresAt && Number(existing.expiresAt) > now);

  const imageModeOptions = options.imageModeOptions || {};
  const state = alreadyPending ? { ...existing } : {
    channelId: message?.channel?.id || '',
    userId: message?.author?.id || '',
    createdAt: now,
    wantsOriginal: false,
    wantsRefined: false,
  };

  if (imageModeOptions.refine === false) state.wantsOriginal = true;
  if (imageModeOptions.refine !== false) state.wantsRefined = true;
  if (!state.wantsOriginal && !state.wantsRefined) state.wantsRefined = true;

  state.width = options.width || state.width || 1024;
  state.height = options.height || state.height || 1024;
  state.seed = options.seed ?? state.seed ?? null;
  state.ground = imageModeOptions.ground !== false;
  state.expiresAt = now + ttlMs;
  state.updatedAt = now;

  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.set(key, state);
  return { alreadyPending, state };
}

function seekdeepConsumePendingImageSubjectRequest(message, prompt = '') {
  const key = seekdeepPendingImageSubjectKeyFromMessage(message);
  const state = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.get(key);
  const now = Date.now();

  if (!state) return null;
  if (!state.expiresAt || Number(state.expiresAt) <= now) {
    SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.delete(key);
    return null;
  }

  const raw = normalizeUserText(prompt).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (/^(?:help|commands|status|archive|setup|queue|cache|recent|purge|delete|remove|stop|cancel)\b/i.test(lower)) return null;
  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(raw)) return null;
  if (/^(?:what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/i.test(lower)) return null;
  // Reject frustration / curse-only replies (e.g. "FUCK", "fuck you", "ugh") — those
  // are not the image subject the user wanted. The pending request stays alive for
  // the TTL so the user can recover and provide a real subject next.
  if (typeof seekdeepIsFrustrationPrompt === 'function' && seekdeepIsFrustrationPrompt(raw)) return null;

  const subject = seekdeepPendingImageSubjectCleanPrompt(raw);
  if (!subject) return null;
  if (typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(subject)) return null;

  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.delete(key);
  return { ...state, prompt: subject };
}

async function seekdeepHandlePendingImageSubjectReply(message, prompt = '', key = '') {
  const pending = seekdeepConsumePendingImageSubjectRequest(message, prompt);
  if (!pending?.prompt) return false;

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-pending-subject', pending.prompt);
  if (typeof remember === 'function' && key) seekdeepRememberSafeV13(key, 'user', `[pending-image-subject] ${pending.prompt}`);

  const wantsOriginal = Boolean(pending.wantsOriginal);
  const wantsRefined = Boolean(pending.wantsRefined);
  const width = pending.width || 1024;
  const height = pending.height || 1024;
  const seed = pending.seed ?? null;
  const ground = pending.ground !== false;

  if (wantsOriginal && wantsRefined) {
    await message.reply({
      content: seekdeepAppendResponseFooter('Queued both:\n- Original\n- Refined', {
        startedAt: seekdeepNowMs(),
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
    seekdeepStopTypingSafelyForMessage(message);

    try {
      await seekdeepSendImageWithButtonsMessage(message, pending.prompt, width, height, seed, {
        refine: false,
        ground,
        cleanPrompt: pending.prompt,
        skipCooldown: true,
        silentAck: true,
      });

      await seekdeepSendImageWithButtonsMessage(message, pending.prompt, width, height, seed, {
        refine: true,
        ground,
        cleanPrompt: pending.prompt,
        skipCooldown: true,
        silentAck: true,
      });
    } finally {
      seekdeepStopTypingSafelyForMessage(message);
    }

    return true;
  }

  await seekdeepSendImageWithButtonsMessage(message, pending.prompt, width, height, seed, {
    refine: !wantsOriginal,
    ground,
    cleanPrompt: pending.prompt,
  });

  return true;
}
// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V1_END

function seekdeepResolveImagePromptFromContext(message, prompt = '') {
  const clean = normalizeUserText(prompt).trim();
  if (!seekdeepIsGenericImageFollowupPrompt(clean)) {
    seekdeepRememberImageSubjectPrompt(message, clean);
    return { prompt: clean, resolvedFromContext: false, missingContext: false };
  }

  const item = SEEKDEEP_RECENT_IMAGE_SUBJECTS.get(seekdeepImageContextKeyFromMessage(message));
  const ttlMs = Number(process.env.SEEKDEEP_IMAGE_CONTEXT_TTL_MS || 10 * 60 * 1000);

  if (item?.prompt && (Date.now() - Number(item.at || 0)) <= ttlMs) {
    return { prompt: item.prompt, resolvedFromContext: true, missingContext: false };
  }

  return { prompt: clean, resolvedFromContext: false, missingContext: true };
}

function seekdeepLooksLikeTextQuestionForImageRoute(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(p) ||
    /\b(explain|tell me about|summarize|summary|define|definition|how to|guide|steps|instructions|difference between|compare|comparison|pros\/cons|pros and cons)\b/.test(p);
}

function seekdeepLooksLikeGroundableVisualSubject(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p || p.length > 220) return false;
  if (seekdeepLooksLikeTextQuestionForImageRoute(p)) return false;

  const specificCue = /\b(from|by|official|accurate|actual|game item|collectible|character|franchise)\b/.test(p);
  const namedCue = /\b(animal crossing|nintendo|pokemon|pok[eÃ©]mon|zelda|hyrule|toad|mario|sailor moon|sonic|playstation|ps2|xbox|minecraft|fortnite|roblox|disney|marvel|dc comics|star wars|final fantasy|pepe)\b/.test(p);
  const objectCue = /\b(bag|bells|coin|coins|sword|shield|logo|emblem|badge|item|object|prop|weapon|helmet|armor|poster|cover|album cover|sticker|toy|figure)\b/.test(p);

  if (/^(a|an|the)\s+/.test(p) && (specificCue || namedCue) && objectCue) return true;
  if ((specificCue && namedCue && objectCue) || (namedCue && /\b(item|object|prop|bag|bells|coin|coins)\b/.test(p))) return true;

  return false;
}

function seekdeepNeedsImageGrounding(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (!p || p.length > 280) return false;

  if (/\b(from|by|official|accurate|actual|game item|collectible|franchise)\b/.test(p) &&
      /\b(animal crossing|nintendo|pokemon|pok[eÃ©]mon|zelda|hyrule|toad|mario|sailor moon|sonic|playstation|ps2|xbox|minecraft|fortnite|roblox|disney|marvel|dc comics|star wars|final fantasy|pepe)\b/.test(p)) {
    return true;
  }

  if (/\b(bag of bells|bells bag|master sword|pok[eÃ©]ball|mario mushroom|triforce|animal crossing)\b/.test(p)) return true;

  return false;
}

function seekdeepBuildImageGroundingSearchQuery(prompt = '') {
  const p = normalizeUserText(prompt).trim();

  if (/\banimal crossing\b/i.test(p) && /\b(bag of bells|bells|money bag)\b/i.test(p)) {
    return 'Animal Crossing bag of bells item appearance money bag bells Nintendo wiki';
  }

  return `${p} visual appearance official wiki item reference`;
}

function seekdeepCleanGroundedImagePrompt(value = '') {
  let out = String(value || '').replace(/\r\n/g, '\n').trim();
  out = out.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, '').trim());
  out = out.replace(/^\s*(grounded\s*)?(image\s*)?(prompt|visual prompt)\s*:\s*/i, '');
  out = out.replace(/\n\s*Sources?:[\s\S]*$/i, '');
  out = out.replace(/\n{2,}/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean).join(', ');
  out = out.replace(/\s+/g, ' ').replace(/^["'`]+|["'`]+$/g, '').trim();

  if (out.length > 520) out = out.slice(0, 520).replace(/[,;:\s]+$/g, '').trim();
  return out;
}

async function seekdeepMaybeGroundImagePrompt(prompt = '') {
  const original = normalizeUserText(prompt).trim();
  if (!original || !seekdeepNeedsImageGrounding(original)) {
    return { prompt: original, grounded: false, searchQuery: '' };
  }

  if (/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_IMAGE_WEB_GROUNDING || 'true'))) {
    return { prompt: original, grounded: false, searchQuery: '' };
  }

  // SEEKDEEP_KNOWN_IMAGE_GROUNDING_OVERRIDE_START
  if (/\banimal crossing\b/i.test(original) && /\b(bag of bells|bells bag|bell bag|bells)\b/i.test(original)) {
    const grounded = 'Animal Crossing Bells money bag, small tan cloth drawstring pouch, rounded simple game item shape, tied top, dark star-shaped bell/currency symbol on the front, cute clean Nintendo-style object icon, centered prop, no face, no character, no loose coins, no text';
    console.log(`[SeekDeep] image prompt grounded:\n  original: ${original}\n  grounded: ${grounded}`);
    return { prompt: grounded, grounded: true, searchQuery: 'known-subject:animal-crossing-bells-bag' };
  }
  // SEEKDEEP_KNOWN_IMAGE_GROUNDING_OVERRIDE_END

  // SEEKDEEP_KNOWN_TOAD_MARIO_GROUNDING_START
  if (/\btoad\b/i.test(original) && /\bmario\b/i.test(original)) {
    const grounded = 'Toad from the Mario games, small mushroom-headed humanoid character, large white mushroom cap with colored spots, simple vest, tiny body, cheerful Nintendo-style cartoon proportions, centered character, no text';
    console.log(`[SeekDeep] image prompt grounded:\n  original: ${original}\n  grounded: ${grounded}`);
    return { prompt: grounded, grounded: true, searchQuery: 'known-subject:toad-from-mario' };
  }
  // SEEKDEEP_KNOWN_TOAD_MARIO_GROUNDING_END

  const searchQuery = seekdeepBuildImageGroundingSearchQuery(original);

  try {
    const answer = await askChat([
      'Create a concise grounded image-generation prompt for the user request.',
      `User request: ${original}`,
      '',
      'Use web/search context if available.',
      'Only include visual facts useful for image generation.',
      'Do not answer with trivia, explanation, trading/gameplay advice, or sources.',
      'Do not invent details if context is weak; make a best-effort visual prompt grounded in the known subject.',
      '',
      'Return one line only. No markdown. No citations. No heading.',
    ].join('\n'), {
      web: 'always',
      system: [
        'You convert known objects, game items, characters, products, or franchise subjects into accurate image-generation prompts.',
        'Be concise and visual. Preserve the requested subject.',
        'Do not produce factual articles or gameplay explanations.',
      ].join('\n'),
      maxNewTokens: Number(process.env.SEEKDEEP_IMAGE_GROUNDING_MAX_TOKENS || 320),
      temperature: 0.1,
      searchQueryOverride: searchQuery,
    });

    const grounded = seekdeepCleanGroundedImagePrompt(answer);

    if (grounded && grounded.length >= 12 && !/^i can|^i cannot|^sorry\b/i.test(grounded)) {
      console.log(`[SeekDeep] image prompt grounded:\n  original: ${original}\n  grounded: ${grounded}`);
      return { prompt: grounded, grounded: true, searchQuery };
    }
  } catch (err) {
    console.warn('Image prompt grounding failed; using original prompt:', err?.message || err);
  }

  return { prompt: original, grounded: false, searchQuery };
}
// SEEKDEEP_GROUNDED_IMAGE_CONTEXT_END



// SEEKDEEP_SHORT_NAMED_VISUAL_SUBJECT_ROUTE_START
function seekdeepLooksLikeShortNamedVisualSubject(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;
  if (p.length > 120) return false;

  // Do not hijack normal questions, support requests, research, code, tables, or status commands.
  if (/^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(p)) return false;
  if (/\b(explain|tell me|summarize|summary|define|definition|compare|comparison|difference|pros|cons|table|spreadsheet|code|script|powershell|status|queue|archive|cache|help|commands|audit|search|look up|internet|web)\b/.test(p)) return false;

  const words = p.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 10) return false;

  const namedVisualCue = /\b(toad|spyro|ripto|predator|xenomorph|alien|matrix|homer|simpson|sailor\s*moon|pepe|sonic|toad|mario|zelda|link|kirby|pokemon|pok[eÃ©]mon|pikachu|animal\s*crossing|nintendo|batman|joker|spawn|doomguy|master\s*chief|crash\s*bandicoot)\b/.test(p);
  const visualModifierCue = /\b(predator|alien|matrix|cyberpunk|gothic|metal|emo|screamo|hardcore|neon|robot|mutant|monster|dragon|demon|vampire|zombie|armor|armored|samurai|wizard|pirate|ninja|forest|jungle|space|castle|cathedral|balcony|sunset|poster|album|cover)\b/.test(p);

  // Short subject phrase with a known visual entity and some modifier/second subject.
  if (namedVisualCue && visualModifierCue) return true;

  // Two known entities mashed together, e.g. "Pepe Sailor Moon".
  const knownMatches = p.match(/\b(toad|spyro|ripto|predator|matrix|homer|simpson|sailor\s*moon|pepe|sonic|toad|mario|zelda|link|kirby|pikachu|batman|joker)\b/g) || [];
  if (knownMatches.length >= 2) return true;

  return false;
}
// SEEKDEEP_SHORT_NAMED_VISUAL_SUBJECT_ROUTE_END


// SEEKDEEP_IMAGE_ROUTE_CHAT_GUARD_START
function seekdeepShouldKeepPromptAsChatBeforeImage(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  if (typeof seekdeepHasTextListIntent === 'function' && seekdeepHasTextListIntent(p)) return true;
  if (/\b(?:image|picture|photo|art|visual|scene|prompt)\s+(?:ideas?|concepts?|directions?|options?|suggestions?|variations?|prompts?)\b/i.test(p)) return true;
  if (/\b(?:next|another|more|additional|same direction|same vibe|same style)\b.*\b(?:ideas?|concepts?|directions?|options?|suggestions?|variations?)\b/i.test(p)) return true;
  if (typeof seekdeepHasCountRequest === 'function' && seekdeepHasCountRequest(p) && /\b(?:ideas?|concepts?|directions?|options?|suggestions?|variations?|examples?)\b/i.test(p)) return true;
  if (typeof seekdeepLooksLikeConversationalImageEditFollowup === 'function' && seekdeepLooksLikeConversationalImageEditFollowup(p)) return true;

  // Direct visual commands should still be image even if they contain "can/could" later.
  if (/^(show|draw|paint|sketch|illustrate|render|generate|create|make|design)\b/.test(p)) return false;

  // Question-form image requests like "can you please generate an image of him"
  // or "could you make a picture of that?" should still route to image, not chat.
  // We check for an explicit image request anywhere in the prompt.
  if (typeof seekdeepHasExplicitImageRequest === 'function' && seekdeepHasExplicitImageRequest(p)) return false;

  // Clear question/explanation/research shapes should not become image prompts
  // just because they mention a visual franchise/entity.
  if (/^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(p)) return true;
  if (/\b(explain|tell me about|summarize|summary|define|definition|what happens|how does|how do|why does|why do|difference between|compare|comparison|pros\/cons|pros and cons|look up|search|internet|web)\b/.test(p)) return true;

  return false;
}
// SEEKDEEP_IMAGE_ROUTE_CHAT_GUARD_END

function isNaturalImagePrompt(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  if (typeof seekdeepShouldKeepPromptAsChatBeforeImage === 'function' && seekdeepShouldKeepPromptAsChatBeforeImage(p)) {
    return false;
  }

  // SEEKDEEP_IMAGE_INTENT_V3_EARLY_OVERRIDE_START
  if (seekdeepLooksLikeVisualRequest(p)) return true;
  // SEEKDEEP_IMAGE_INTENT_V3_EARLY_OVERRIDE_END

  // SEEKDEEP_GROUNDED_IMAGE_SUBJECT_ROUTE_START
  if (seekdeepLooksLikeGroundableVisualSubject(p)) return true;
  // SEEKDEEP_GROUNDED_IMAGE_SUBJECT_ROUTE_END


  if (typeof isNaturalVisionPrompt === 'function' && isNaturalVisionPrompt(p)) {
    return false;
  }

  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) {
    return false;
  }

  if (seekdeepShouldStayChatInsteadOfImage(p)) {
    return false;
  }

  if (seekdeepHasExplicitImageRequest(p)) {
    return true;
  }

  if (/\b(generate|create|make|draw|render|paint|illustrate|design|show me|show)\b/i.test(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  if (seekdeepHasLikelyVisualDescription(p)) {
    return true;
  }

  return false;

  if (seekdeepLooksLikeVisualRequest(prompt)) return true;
}

async function fetchRepliedMessage(message) {
  try {
    if (!message?.reference || typeof message.fetchReference !== 'function') return null;
    return await message.fetchReference();
  } catch {
    return null;
  }
}

function seekdeepLooksLikeVisualAttachment(attachment) {
  if (!attachment) return false;
  const type = String(attachment.contentType || '').toLowerCase();
  if (type.startsWith('image/') || type.startsWith('video/')) return true;
  // Some forwarded / proxied attachments arrive without a contentType. Fall back
  // to extension sniffing on the URL or filename.
  const name = String(attachment.name || attachment.filename || '').toLowerCase();
  const url = String(attachment.url || attachment.proxyURL || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|tiff|avif|mp4|mov|webm|mkv|m4v)(\?|$)/i.test(name)
      || /\.(png|jpe?g|gif|webp|bmp|tiff|avif|mp4|mov|webm|mkv|m4v)(\?|$)/i.test(url);
}

function firstVisualAttachmentFrom(sourceMessage) {
  try {
    if (!sourceMessage) return null;

    // Direct attachments on the message.
    if (sourceMessage.attachments?.size) {
      for (const attachment of sourceMessage.attachments.values()) {
        if (seekdeepLooksLikeVisualAttachment(attachment)) return attachment;
      }
    }

    // Forwarded message snapshots — Discord's Forward feature places the
    // forwarded message's attachments inside messageSnapshots rather than on the
    // outer message. Walk every snapshot looking for an image/video.
    const snapshots = sourceMessage.messageSnapshots;
    if (snapshots) {
      const iter = typeof snapshots.values === 'function' ? snapshots.values() : snapshots;
      for (const snapshot of iter) {
        const snapAttachments = snapshot?.attachments;
        if (!snapAttachments) continue;
        const snapIter = typeof snapAttachments.values === 'function'
          ? snapAttachments.values()
          : (Array.isArray(snapAttachments) ? snapAttachments : Object.values(snapAttachments));
        for (const attachment of snapIter) {
          if (seekdeepLooksLikeVisualAttachment(attachment)) return attachment;
        }
        // Embeds inside the snapshot can also carry an image URL even when
        // attachments are empty (e.g. linked images).
        const snapEmbeds = snapshot?.embeds;
        if (Array.isArray(snapEmbeds)) {
          for (const embed of snapEmbeds) {
            const url = String(embed?.image?.url || embed?.thumbnail?.url || '').trim();
            if (url && /\.(png|jpe?g|gif|webp|bmp|tiff|avif|mp4|mov|webm|mkv|m4v)(\?|$)/i.test(url)) {
              return { url, proxyURL: url, contentType: '', name: 'forwarded-embed-image' };
            }
          }
        }
      }
    }

    // Embeds on the outer message (link previews) as a final fallback.
    const outerEmbeds = sourceMessage.embeds;
    if (Array.isArray(outerEmbeds)) {
      for (const embed of outerEmbeds) {
        const url = String(embed?.image?.url || embed?.thumbnail?.url || '').trim();
        if (url && /\.(png|jpe?g|gif|webp|bmp|tiff|avif|mp4|mov|webm|mkv|m4v)(\?|$)/i.test(url)) {
          return { url, proxyURL: url, contentType: '', name: 'embed-image' };
        }
      }
    }
  } catch {}

  return null;
}

async function resolveVisionAttachment(message) {
  const direct = firstVisualAttachmentFrom(message);
  if (direct) {
    return { attachment: direct, origin: 'direct' };
  }

  const replied = await fetchRepliedMessage(message);
  const repliedAttachment = firstVisualAttachmentFrom(replied);
  if (repliedAttachment) {
    return { attachment: repliedAttachment, origin: 'reply' };
  }

  return { attachment: null, origin: null };
}

// SEEKDEEP_NATURAL_MEDIA_ROUTING_END


// SEEKDEEP_POST_ARCHIVE_START
const SEEKDEEP_ARCHIVE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
]);

function seekdeepArchiveDir(target = null) 
{
  const scopeDir = seekdeepSanitizeArchiveScopeKey(seekdeepGuildArchiveScopeFromTarget(target));
  const base = seekdeepArchiveDirForTarget(seekdeepArchiveTargetFallback(typeof archiveTarget !== 'undefined' ? archiveTarget : null));
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function isPostArchivePrompt(prompt = '') {
  return false;
}

function seekdeepListArchiveImageFiles() {
  const dir = seekdeepArchiveDirForTarget(seekdeepArchiveTargetFallback(typeof archiveTarget !== 'undefined' ? archiveTarget : null));

  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, stat };
    })
    .filter((entry) => entry.stat.isFile())
    .filter((entry) => SEEKDEEP_ARCHIVE_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function seekdeepArchiveBatches(files, size = 10) {
  const batches = [];

  for (let i = 0; i < files.length; i += size) {
    batches.push(files.slice(i, i + size));
  }

  return batches;
}

async function seekdeepPostArchiveToChannel(channel) {
  const startedAt = seekdeepNowMs();
  const modelUsed = seekdeepNoModelLabel();
  return {
    summary: 'This archive posting command has been removed. Use the `Archive` or `Shared Archive` button so images are stored in Discord archive threads.',
    startedAt,
    modelUsed,
    posted: 0,
    failed: 0,
    disabled: true,
  };
}

async function seekdeepPostArchiveFromMessage(message) {
  seekdeepMarkRequestStart(message);
  seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  stopSeekDeepTypingLoopForMessage(message);

  const result = await seekdeepPostArchiveToChannel(message.channel);

  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || message?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await message.reply({
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}

async function seekdeepPostArchiveFromInteraction(interaction) {
  seekdeepMarkRequestStart(interaction);
  seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());

  const result = await seekdeepPostArchiveToChannel(interaction.channel);

  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || interaction?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await safeEditOrReply(interaction, {
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}

// SEEKDEEP_POST_ARCHIVE_END



// SEEKDEEP_ARCHIVE_GUILD_SCOPE_MIGRATION_NOTE
// Archive state is now guild-scoped for new writes.
// Old global archive entries are intentionally left untouched so nothing is destroyed.
// If you need migration, copy old records into the relevant guild:<guildId> scope manually.
// SEEKDEEP_ARCHIVE_GUILD_SCOPE_MIGRATION_NOTE_END

function seekdeepArchiveScopeLabel(target = null) {
  const scope = seekdeepGuildArchiveScopeFromTarget(target);
  if (scope.startsWith('guild:')) return 'this server';
  if (scope.startsWith('dm:')) return 'this DM';
  return 'current archive scope';
}

function seekdeepArchiveDirForTarget(target = null) {
  const scopeDir = seekdeepSanitizeArchiveScopeKey(seekdeepGuildArchiveScopeFromTarget(target));
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const out = path.join(baseDir, 'saved_generations', 'archives', scopeDir);
  try {
    fs.mkdirSync(out, { recursive: true });
  } catch {}
  return out;
}

function seekdeepRedactArchivePathForDiscord(value = '') {
  return String(value || '')
    .replace(/[A-Z]:\\[^\n\r`]+/gi, '[local archive path hidden]')
    .replace(/\/(?:home|Users|mnt|var|tmp)\/[^\n\r`]+/gi, '[local archive path hidden]');
}


function seekdeepIsPrivilegedArchiveCommand(commandName = '') {
  return /^(?:purgearchive|setarchive|archiveconfig|archiveadmin|cleararchive)$/i.test(String(commandName || ''));
}

function seekdeepUserCanRunPrivilegedSeekDeepCommand(interactionOrMessage = {}) {
  const memberPermissions = interactionOrMessage?.memberPermissions || interactionOrMessage?.member?.permissions || null;
  if (!memberPermissions || typeof memberPermissions.has !== 'function') return false;
  try {
    return Boolean(
      memberPermissions.has(PermissionFlagsBits.Administrator) ||
      memberPermissions.has(PermissionFlagsBits.ManageGuild) ||
      memberPermissions.has(PermissionFlagsBits.ManageChannels)
    );
  } catch {
    return false;
  }
}

function seekdeepNormalUsersMayUseCommand(commandName = '') {
  return !seekdeepIsPrivilegedArchiveCommand(commandName);
}

function seekdeepGroundBotanicalSlangPrompt(prompt = '') {
  const raw = String(prompt || '').trim();
  const lower = raw.toLowerCase();

  const hasBud =
    /\b(bud|buds|flower|nug|nugs|nugget|weed|cannabis|marijuana|ganja|kush|herb|tree|trees)\b/i.test(lower);

  const hasSugaryVisual =
    /\b(sugary|sugar|frosty|frosted|crystal|crystals|crystalline|sticky|resin|resiny|trichome|trichomes|loud|dank|sparkly|snowy)\b/i.test(lower);

  if (!(hasBud && hasSugaryVisual)) {
    return raw;
  }

  const cleaned = raw
    .replace(/\blookin['â€™]?/gi, 'looking')
    .replace(/\bshow me\b/gi, '')
    .replace(/\bgenerate\b/gi, '')
    .replace(/\bpicture of\b/gi, '')
    .replace(/\bimage of\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return [
    'frosty cannabis flower close-up',
    'dense white trichomes like sugar crystals',
    'sticky resin',
    'green and purple bud structure',
    'realistic botanical texture',
    'macro product-photo composition',
    'sharp leaf and flower structure',
    'natural plant detail',
    cleaned ? `user wording: ${cleaned}` : '',
    'no eyes',
    'no face',
    'no candy',
    'no gum',
    'no cartoon mascot',
    'no humanoid features',
    'no extra characters',
    'no monster anatomy',
    'no surreal eyeballs',
  ].filter(Boolean).join(', ');
}

// SEEKDEEP_PENDING_RESEARCH_TASKS_PATCH_START
// In-memory follow-up context for research/table conversations.
// This intentionally stays local and bounded: it prevents the research handler from
// crashing on archive/status commands while still allowing short follow-up prompts
// like "make a table" or "pros and cons" to reference the prior research answer.
const seekdeepPendingResearchTasks = new Map();
const SEEKDEEP_PENDING_RESEARCH_TASK_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.SEEKDEEP_PENDING_RESEARCH_TASK_TTL_MS || 45 * 60 * 1000)
);

function seekdeepPendingResearchTaskKey(key = '') {
  const clean = String(key || '').trim();
  return clean || 'global';
}

function seekdeepPrunePendingResearchTasks(now = Date.now()) {
  for (const [taskKey, task] of seekdeepPendingResearchTasks.entries()) {
    const expiresAt = Number(task?.expiresAt || 0);
    if (expiresAt > 0 && expiresAt <= now) {
      seekdeepPendingResearchTasks.delete(taskKey);
    }
  }
}

function seekdeepGetPendingResearchTask(key = '') {
  seekdeepPrunePendingResearchTasks();
  const taskKey = seekdeepPendingResearchTaskKey(key);
  const task = seekdeepPendingResearchTasks.get(taskKey) || null;
  if (!task) return null;

  const expiresAt = Number(task.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    seekdeepPendingResearchTasks.delete(taskKey);
    return null;
  }

  return task;
}

function seekdeepSetPendingResearchTask(key = '', task = null) {
  seekdeepPrunePendingResearchTasks();
  const taskKey = seekdeepPendingResearchTaskKey(key);

  if (!task || typeof task !== 'object') {
    seekdeepPendingResearchTasks.delete(taskKey);
    return null;
  }

  const now = Date.now();
  const stored = {
    ...task,
    updatedAt: now,
    expiresAt: now + SEEKDEEP_PENDING_RESEARCH_TASK_TTL_MS,
  };

  seekdeepPendingResearchTasks.set(taskKey, stored);
  return stored;
}
// SEEKDEEP_PENDING_RESEARCH_TASKS_PATCH_END
function seekdeepResearchPrompt(topic = '', mode = 'research', prior = null) {
  const cleanTopic = seekdeepCleanResearchTopic(topic);
  if (mode === 'table') {
    return [
      'Create a comparison table for this request.',
      prior?.topic ? `Prior topic: ${prior.topic}` : '',
      `Current requested scope/items: ${cleanTopic}`,
      '',
      'If the current requested scope is a follow-up fragment, combine it with the prior topic.',
      'Answer in Markdown. Start with the table. Keep it useful for a buyer deciding what to choose.',
    ].filter(Boolean).join('\n');
  }

  return [
    'Research and answer this request using available web/search context.',
    `Request: ${cleanTopic}`,
    '',
    'If this is a product comparison, identify the concrete models/generations involved and avoid hallucinating unavailable variants.',
  ].join('\n');
}


function seekdeepIsResearchFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (!p) return false;

  return (
    /\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p) ||
    /\b(of each|each one|each model|each laptop|for each|both of them|those|these|that comparison|the comparison)\b/.test(p) ||
    /\b(can you|could you|would you|please)?\s*(give|make|create|show|list|break down)\s+(me\s+)?(a\s+)?(pros?\s*\/\s*cons?|pros and cons|summary|recommendation|winner|ranking|table|chart)\b/.test(p) ||
    /^(audit|fact\s*check|fact-check|check that|check the answer|verify that|verify the answer|review that|review the answer|was that right|is that right|source audit|sources audit)\b/.test(p)
  );
}

function seekdeepResearchFollowupMode(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (/^(audit|fact\s*check|fact-check|check that|check the answer|verify that|verify the answer|review that|review the answer|was that right|is that right|source audit|sources audit)\b/.test(p)) return 'audit';
  if (/\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p)) return 'proscons';
  if (/\b(table|chart|matrix|spreadsheet|tablesheet)\b/.test(p)) return 'table';
  if (/\b(winner|which one|which should|recommend|recommendation|ranking|rank)\b/.test(p)) return 'recommendation';
  return 'followup';
}

function seekdeepResearchFollowupPrompt(prompt = '', pending = null) {
  const clean = normalizeUserText(prompt);
  const topic = normalizeUserText(pending?.topic || '');
  const lastAnswer = normalizeUserText(pending?.lastAnswer || '').slice(0, 3500);
  const mode = seekdeepResearchFollowupMode(clean);

  const scopeRules = [
    'Scope discipline:',
    '- Preserve the exact prior comparison topic/items.',
    '- Do not introduce unrelated models or generations.',
    '- If the prior topic says X1 Carbon and T14, do not switch to X230, T13, T14s, Framework, or unrelated models unless explicitly asked.',
    '- If the prior topic is broad, say that exact specs vary by generation/configuration.',
    '- If sources are weak/unrelated, say that plainly.',
  ].join('\n');

  if (mode === 'audit') {
    return [
      'Audit the previous research/comparison answer.',
      topic ? `Previous topic/items: ${topic}` : '',
      lastAnswer ? `Previous answer to audit:\n${lastAnswer}` : '',
      '',
      scopeRules,
      '',
      'Output:',
      '1. List any likely wrong, unsupported, or overconfident claims.',
      '2. List source-quality problems.',
      '3. Give a corrected concise answer if possible.',
      '4. If more exact model generations are needed, ask for them.',
    ].filter(Boolean).join('\n');
  }

  if (mode === 'proscons') {
    return [
      'Continue the previous research/comparison task.',
      topic ? `Previous topic/items: ${topic}` : '',
      `User follow-up: ${clean}`,
      '',
      scopeRules,
      '',
      'Provide a pros/cons list for each item/model in the previous comparison.',
      'Use concise bullets. If exact specs vary by configuration, say so.',
      'Do not invent details that are not supported by the search/context.',
    ].filter(Boolean).join('\n');
  }

  if (mode === 'recommendation') {
    return [
      'Continue the previous research/comparison task.',
      topic ? `Previous topic/items: ${topic}` : '',
      `User follow-up: ${clean}`,
      '',
      scopeRules,
      '',
      'Give a practical recommendation with clear criteria and caveats.',
      'Do not invent details that are not supported by the search/context.',
    ].filter(Boolean).join('\n');
  }

  return [
    'Continue the previous research/comparison task.',
    topic ? `Previous topic/items: ${topic}` : '',
    `User follow-up: ${clean}`,
    '',
    scopeRules,
    '',
    'Resolve the follow-up using the previous topic and available web/search context.',
    'Do not answer as a generic list detached from the prior comparison.',
  ].filter(Boolean).join('\n');
}

// SEEKDEEP_RESEARCH_HELPER_SHIMS_ARCHIVE_ALIAS_V1_START
// Compatibility helpers for the research/table message route. These are intentionally
// small and bounded so archive/status commands cannot crash by falling through this path.
function seekdeepCompatResearchText(value = '') {
  try {
    if (typeof normalizeUserText === 'function') {
      return normalizeUserText(value);
    }
  } catch {}

  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepCompatResearchLower(value = '') {
  return seekdeepCompatResearchText(value).toLowerCase();
}

function seekdeepCleanResearchTopic(topic = '') {
  const original = seekdeepCompatResearchText(topic);
  const cleaned = original
    .replace(/<@!?\d+>/g, ' ')
    .replace(/\b@?(?:seekdeep|seekotics)\b/gi, ' ')
    .replace(/^(?:can\s+you|could\s+you|please|pls)\s+/i, '')
    .replace(/^(?:search|look\s+up|lookup|research|compare|comparison|make|create|show|give\s+me|build)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?/i, '')
    .replace(/^(?:table|chart|matrix|spreadsheet)\s+(?:of|for|about)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || original;
}

function seekdeepResearchSystem(mode = 'research') {
  const selected = String(mode || 'research').toLowerCase();
  const base = [
    'You are SeekDeep, a direct research assistant inside Discord.',
    'Ground every concrete claim in the provided web/search context. If a fact is not in the context, say "not in sources" instead of inventing it.',
    'Never fabricate product names, model numbers, version numbers, release dates, or prices. If the sources do not name a specific model or version, refer to it generically (for example: "the latest iPhone" rather than "iPhone 15") and note that the exact version was not in your sources.',
    'Treat your own training knowledge as potentially out of date. When training knowledge and sources conflict, trust the sources.',
    'If sources are weak, stale, or contradict each other, say so plainly and answer at a less specific level rather than guessing.',
    'When you cite a fact, use the bracketed source numbers from the context (for example [1], [3]).',
    'Keep the answer practical and easy to compare. No filler.',
  ];

  if (selected === 'table') {
    base.push('For table requests, start with a Markdown table, then add only the necessary caveats.');
  } else {
    base.push('For comparisons, preserve the exact items the user asked about and do not switch to unrelated models or generations.');
  }

  return base.join(' ');
}

function seekdeepBuildFocusedResearchSearchQuery(topic = '', mode = 'research') {
  const clean = seekdeepCleanResearchTopic(topic);
  const selected = String(mode || 'research').toLowerCase();
  if (!clean) return '';

  if (selected === 'table') return clean + ' comparison specs table review';
  if (selected === 'proscons') return clean + ' pros cons comparison review';
  if (selected === 'recommendation') return clean + ' comparison recommendation review';
  if (selected === 'audit') return clean;
  return clean + ' comparison specs review';
}

function seekdeepIsFrustrationPrompt(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;

  return (
    /^(?:no|nah|wrong|incorrect|false|bad|terrible|useless|garbage|bullshit|bs|wtf|what\s+the\s+fuck)\b/.test(p) ||
    /^(?:fuck|fucking|shit|damn|goddamn|ugh|argh|jesus|christ|fml|smh|wtf)\b\s*[!.?]*$/.test(p) ||
    /^(?:fuck|screw|damn|f\*+)\s+(?:you|this|that|off|me|it|all\s+of\s+(?:you|this))\b/.test(p) ||
    /^(?:i\s+(?:mean|just|literally))\s+fuck\b/.test(p) ||
    /\b(?:not\s+helpful|did(?:n['â€™]?t| not)\s+help|does(?:n['â€™]?t| not)\s+help|wrong\s+answer|bad\s+answer|made\s+that\s+up|hallucinat(?:ed|ing)|you\s+missed|you\s+ignored|not\s+what\s+i\s+asked|that\s+is(?:n['â€™]?t| not)\s+right|try\s+again|redo\s+that|fix\s+that)\b/.test(p)
  );
}

function seekdeepIsVagueWebRequest(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\b(?:archive|status|help|queue|image|vision|download|regenerate|refined?|original)\b/.test(p)) return false;

  return (
    /^(?:search|look\s+up|lookup|research|google|web\s+search|find\s+sources?)\s*(?:it|that|this)?\s*$/.test(p) ||
    /^(?:(?:can|could)\s+you\s+)?(?:search|look\s+up|lookup|research|google)\s*(?:it|that|this)?\s*$/.test(p) ||
    (/\b(?:search\s+the\s+web|look\s+it\s+up|look\s+that\s+up|google\s+it|find\s+sources?)\b/.test(p) && p.split(/\s+/).length <= 10)
  );
}

function seekdeepIsTableRequestPrompt(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\b(?:archive|status|help|queue|image|vision|download|regenerate)\b/.test(p)) return false;

  return (
    /^(?:(?:can|could)\s+you\s+|please\s+)?(?:make|create|build|show|give\s+me|generate)?\s*(?:a\s+)?(?:comparison\s+)?(?:table|chart|matrix|spreadsheet)\b/.test(p) ||
    /\b(?:in|as)\s+(?:a\s+)?(?:table|chart|matrix|spreadsheet)\b/.test(p)
  );
}

function seekdeepLooksLikeComparisonItemsFollowup(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\b(?:archive|status|help|queue|image|vision|download|regenerate)\b/.test(p)) return false;

  if (/\b(?:vs\.?|versus|compared\s+to)\b/.test(p)) return true;
  if (/[,|/]/.test(p) && p.split(/[,|/]/).map((x) => x.trim()).filter(Boolean).length >= 2) return true;
  if (/\b(?:and|or)\b/.test(p) && /\b(?:compare|comparison|table|chart|specs?|price|review|model|generation|laptop|phone|gpu|cpu)\b/.test(p)) return true;
  if (/^[-*]\s+.+(?:\n|$)/m.test(String(prompt || ''))) return true;

  return false;
}

function seekdeepIsComparisonResearchPrompt(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\b(?:archive|archivestatus|status|help|commands|queue|image|vision|download|regenerate|cache)\b/.test(p)) return false;

  return (
    /^(?:compare|comparison|versus|vs\.?|pros\s*\/?\s*cons|pros\s+and\s+cons)\b/.test(p) ||
    /\b(?:compare|comparison|vs\.?|versus|which\s+(?:one|is|should)|better|best|recommend|recommendation|ranking|rank|pros\s*\/?\s*cons|pros\s+and\s+cons|specs?|benchmarks?|prices?)\b/.test(p)
  );
}

function seekdeepMultipleCommandText() {
  return [
    'I saw more than one SeekDeep mention in that message, so I stopped instead of guessing which command to run.',
    'Use one bot mention, then the command. Example: @SeekDeep archive @user'
  ].join('\n');
}
// SEEKDEEP_RESEARCH_HELPER_SHIMS_ARCHIVE_ALIAS_V1_END
async function seekdeepHandleResearchTableMessage(message, prompt, key) {
  const p = normalizeUserText(prompt);
  const lower = p.toLowerCase();
  const pending = seekdeepGetPendingResearchTask(key);

  if (!pending?.topic && seekdeepIsResearchFollowupPrompt(p) && !seekdeepLooksLikeComparisonItemsFollowup(p)) {
    seekdeepLogRoute('research-followup-missing-context', prompt);
    const answer = 'Pros/cons of what exactly? Send the models/items again, and I will compare them instead of guessing.';
    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, answer);
    return true;
  }

  if (pending?.topic && seekdeepIsResearchFollowupPrompt(p)) {
    seekdeepLogRoute('research-followup', prompt);
    const answer = await askChat(seekdeepResearchFollowupPrompt(p, pending), {
      web: 'always',
      memoryKey: key,
      system: seekdeepResearchSystem(seekdeepResearchFollowupMode(p) === 'table' ? 'table' : 'research'),
      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_FOLLOWUP_MAX_TOKENS || 2400),
      temperature: 0.2,
      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, seekdeepResearchFollowupMode(p)),
    });

    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
    seekdeepSetPendingResearchTask(key, { ...pending, kind: pending.kind || 'comparison', lastAnswer: answer });
    return true;
  }

  if (seekdeepIsFrustrationPrompt(p)) {
    seekdeepLogRoute('frustration-recovery', prompt);
    const recovery = 'Fair. I gave a bad answer. Send the exact thing you want compared or searched and Iâ€™ll correct it with sources.';
    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', recovery);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, recovery);
    return true;
  }

  if (seekdeepIsVagueWebRequest(p)) {
    seekdeepLogRoute('research-topic-needed', prompt);
    const answer = "Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.";
    seekdeepSetPendingResearchTask(key, { kind: 'research-topic-needed', topic: '', sourcePrompt: p });
    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, answer);
    return true;
  }

  if (seekdeepIsTableRequestPrompt(p) && !seekdeepLooksLikeComparisonItemsFollowup(p)) {
    seekdeepLogRoute('research-table-request', prompt);
    if (pending?.topic) {
      const tablePrompt = seekdeepResearchPrompt(pending.topic, 'table', pending);
      const answer = await askChat(tablePrompt, {
        web: 'always',
        memoryKey: key,
        system: seekdeepResearchSystem('table'),
        maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_TABLE_MAX_TOKENS || 2400),
        temperature: 0.2,
        searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, 'table'),
      });

      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
      await sendLongMessageReply(message, answer);
      seekdeepSetPendingResearchTask(key, { kind: 'table', topic: pending.topic, lastAnswer: answer });
      return true;
    }

    const answer = 'Yes. Send the exact items/models you want compared, and Iâ€™ll make a table with sourced specs instead of guessing.';
    seekdeepSetPendingResearchTask(key, { kind: 'table-awaiting-items', topic: '', sourcePrompt: p });
    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, answer);
    return true;
  }

  if (pending && (pending.kind === 'table-awaiting-items' || pending.kind === 'research-topic-needed' || pending.kind === 'table') && seekdeepLooksLikeComparisonItemsFollowup(p)) {
    seekdeepLogRoute('research-table-followup', prompt);
    const mergedTopic = [pending.topic, p].filter(Boolean).join(' ').trim() || p;
    const tablePrompt = seekdeepResearchPrompt(mergedTopic, 'table', pending);

    const answer = await askChat(tablePrompt, {
      web: 'always',
      memoryKey: key,
      system: seekdeepResearchSystem('table'),
      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_TABLE_MAX_TOKENS || 2400),
      temperature: 0.2,
      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(mergedTopic, 'table'),
    });

    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
    seekdeepSetPendingResearchTask(key, { kind: 'table', topic: mergedTopic, lastAnswer: answer });
    return true;
  }

  if (seekdeepIsComparisonResearchPrompt(p)) {
    seekdeepLogRoute('research-comparison', prompt);
    const topic = seekdeepCleanResearchTopic(p);
    const answer = await askChat(seekdeepResearchPrompt(topic, 'research', pending), {
      web: 'always',
      memoryKey: key,
      system: seekdeepResearchSystem('research'),
      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_MAX_TOKENS || 2400),
      temperature: 0.22,
      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(topic, 'research'),
    });

    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
    seekdeepSetPendingResearchTask(key, { kind: 'comparison', topic, lastAnswer: answer });
    return true;
  }

  return false;
}
// SEEKDEEP_RESEARCH_TABLE_CONTEXT_END

// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_START
function seekdeepIsPromptDedupeExempt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return false;

  // SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_START
  // Image requests already have per-user cooldown handling. Do not let the older
  // prompt-level dedupe silently eat valid image-intent messages.
  if (typeof seekdeepLooksLikeVisualRequest === 'function' && seekdeepLooksLikeVisualRequest(p)) return true;
  if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;
  // SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_END

  if (typeof isNaturalPongPrompt === 'function' && isNaturalPongPrompt(p)) return true;
  if (typeof isExactPongTest === 'function' && isExactPongTest(p)) return true;
  if (typeof isNaturalStatusPrompt === 'function' && isNaturalStatusPrompt(p)) return true;
  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(p)) return true;
  if (typeof seekdeepIsModelStatusQuestion === 'function' && seekdeepIsModelStatusQuestion(p)) return true;

  return /^(?:queue|que)\s+status\b/.test(p) ||
    /^post\s+archive\b/.test(p) ||
    /^archive\s+status\b/.test(p) ||
    /^cache\s+status\b/.test(p) ||
    /^recent\s+(?:images|image|prompts|prompt)\b/.test(p) ||
    /^(?:regenerate|regen|reroll|redo)(?:\s+(?:the\s+)?(?:last\s+)?(?:image|picture|pic|generation|one|that|this))?\b/.test(p) ||
    /^admin\s+status\b/.test(p) ||
    /^(?:help|commands)\b/.test(p);
}
// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END


// SEEKDEEP_REPLY_CONTEXT_IMAGE_PROMPT_START
function seekdeepLooksLikeGenerateOnlyPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return true;

  // Bare imperatives: "generate", "draw", "image", "make it", "show me this", etc.
  if (/^(?:<@!?\d+>\s*)?(?:please\s+)?(?:generate|gen|image|draw|paint|render|create|make|show\s+me)(?:\s+(?:it|that|this|one|something))?\s*[.!?]*$/i.test(p)) {
    return true;
  }

  // Article-based followups: "an image", "a picture", "an image generated",
  // "image please", "generate an image", "make an image of it", etc.
  if (/^(?:<@!?\d+>\s*)?(?:please\s+)?(?:(?:generate|gen|draw|paint|render|create|make|show\s+me)\s+)?(?:an?|the)?\s*(?:image|picture|pic|photo|drawing|render|painting|illustration|artwork)(?:\s+(?:please|generated|of\s+(?:it|that|this)|it|that|this|me))*\s*[.!?]*$/i.test(p)) {
    return true;
  }

  return false;
}

function seekdeepCleanReplyContextPrompt(prompt = '') {
  let p = normalizeUserText(prompt);
  if (!p) return '';
  p = p.replace(/^\s*<@!?\d+>\s*/g, '');
  p = p.replace(/^\s*(?:@seekotics|@seekdeep)\s*/ig, '');
  p = p.replace(/^\s*(?:please\s+)?(?:generate|gen|image|draw|paint|render|create|make|show\s+me)\b\s*/ig, '');
  p = p.replace(/^\s*(?:for\s+me|of|an\s+image\s+of|a\s+picture\s+of)\b\s*/ig, '');
  p = p.replace(/^\s*[:,-]+\s*/g, '');
  return p.trim();
}

async function seekdeepResolveReplyContextText(message) {
  try {
    const ref = message?.reference;
    if (!ref?.messageId) return '';

    let replied = null;

    if (message?.channel?.messages?.fetch) {
      try {
        replied = await message.channel.messages.fetch(ref.messageId);
      } catch (_) {}
    }

    if (!replied && message?.fetchReference) {
      try {
        replied = await message.fetchReference();
      } catch (_) {}
    }

    if (!replied) return '';

    let replyText = normalizeUserText(replied.content || '');
    if (!replyText && Array.isArray(replied.embeds) && replied.embeds.length) {
      const embedParts = [];
      for (const embed of replied.embeds) {
        if (embed?.title) embedParts.push(embed.title);
        if (embed?.description) embedParts.push(embed.description);
      }
      replyText = normalizeUserText(embedParts.join(' '));
    }

    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    if (/^(?:gif|image|photo|picture|pic|emoji|emojis|sticker|video|attachment|file)$/i.test(replyText)) return '';
    return replyText;
  } catch (_) {
    return '';
  }
}

function seekdeepLooksLikeReplyVisualPrompt(replyText = '') {
  const p = normalizeUserText(replyText).trim();
  if (!p) return false;

  // Do not treat obvious text/research/translation content as an image prompt.
  if (typeof seekdeepShouldKeepPromptAsChatBeforeImage === 'function' && seekdeepShouldKeepPromptAsChatBeforeImage(p)) return false;
  if (/\b(translate|translation|what does this mean|explain|why|how|when|where|who|what|search|internet|web|table|code|script|powershell)\b/i.test(p)) return false;

  // Use current image route detectors when available.
  if (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(p)) return true;
  if (typeof seekdeepLooksLikeGroundableVisualSubject === 'function' && seekdeepLooksLikeGroundableVisualSubject(p)) return true;
  if (typeof seekdeepLooksLikeVisualRequest === 'function' && seekdeepLooksLikeVisualRequest(p)) return true;
  if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;

  return false;
}

function seekdeepIsReplyTranslationRequest(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(translate|translation)\b/.test(p) || /\btranslate\s+(this|that|it|message|reply)\s+(to|into)\s+english\b/.test(p) || /^what\s+does\s+this\s+say\s+in\s+english\b/.test(p);
}


function seekdeepReplyTranslateRequested(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(?:translate|trans)\s+(?:this|that|it|the\s+reply|the\s+message)?\s*(?:to|into)?\s*(?:english|en)?\s*[.!?]*$/i.test(p) ||
    /^(?:what\s+does|what\s+did)\s+(?:this|that|it|the\s+reply|the\s+message)\s+(?:mean|say)(?:\s+in\s+english)?\s*[.!?]*$/i.test(p);
}

function seekdeepReplyContextLooksVisualPrompt(value = '') {
  let p = normalizeUserText(value)
    .replace(/<a?:[^>]+:\d+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!p) return false;
  if (p.length > 220) return false;

  const lower = p.toLowerCase();

  // SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_START
  if (/\b(ripto|spyro|matrix|predator|toad|mario|pepe|sailor\s*moon|homer|simpson|animal\s*crossing|nintendo)\b/i.test(p) &&
      /\b(matrix|green|greenish|predator|style|version|make|more|less|looks|image|picture|art|render|generate)\b/i.test(p)) {
    return true;
  }
  // SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_END


  if (/^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(lower)) return false;
  if (/\b(translate|explain|tell me|summarize|summary|define|definition|search|look up|internet|web|code|script|powershell|table|spreadsheet|audit)\b/.test(lower)) return false;

  // Avoid turning pure profanity/reaction chatter into image prompts.
  const visualCue = /\b(spyro|ripto|predator|toad|mario|sonic|pepe|sailor\s*moon|homer|simpson|animal\s*crossing|nintendo|pokemon|zelda|batman|joker|cat|dog|dragon|monster|castle|tower|forest|album|poster|cover|logo|bag|bells|sword|armor|robot|alien|matrix|cyberpunk|gothic|character|creature|creatures?)\b/i.test(p);
  if (!visualCue) return false;

  try {
    if (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(p)) return true;
  } catch {}

  try {
    if (typeof seekdeepLooksLikeGroundableVisualSubject === 'function' && seekdeepLooksLikeGroundableVisualSubject(p)) return true;
  } catch {}

  try {
    if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;
  } catch {}

  return visualCue && p.split(/\s+/).length <= 14;
}


async function seekdeepApplyReplyContextToPrompt(message, prompt = '') {
  const original = normalizeUserText(prompt || '');
  const replyText = await seekdeepResolveReplyContextText(message);

  if (!replyText) {
    return {
      prompt: original,
      usedReplyContext: false,
      replyContext: '',
      replyTranslateRequested: false,
    };
  }

  if (seekdeepReplyTranslateRequested(original)) {
    return {
      prompt: original,
      usedReplyContext: false,
      replyContext: replyText,
      replyTranslateRequested: true,
    };
  }

  const cleaned = seekdeepCleanReplyContextPrompt(original);
  const isGenerateOnly = seekdeepLooksLikeGenerateOnlyPrompt(original);
  const replyLooksVisual = seekdeepReplyContextLooksVisualPrompt(replyText);

  // Only consume replied text for image generation when the replied text itself looks visual.
  // This prevents "generate" replies to normal chat/profanity from becoming weird chat prompts.
  if ((isGenerateOnly || !cleaned) && replyLooksVisual) {
    return {
      prompt: replyText,
      usedReplyContext: true,
      replyContext: replyText,
      replyTranslateRequested: false,
    };
  }

  return {
    prompt: original,
    usedReplyContext: false,
    replyContext: replyText,
    replyTranslateRequested: false,
  };
}

// SEEKDEEP_REPLY_CONTEXT_IMAGE_PROMPT_END

function seekdeepArchiveStatusCleanPrompt(value = '') {
  return String(value || '')
    .replace(/^(?:\s*(?:<@(?:!|&)?\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepIsArchiveStatusPrompt(value = '') {
  const prompt = seekdeepArchiveStatusCleanPrompt(value).toLowerCase();
  return /^(?:archive\s*status|archivestatus|status\s+archive|archive\s+stats|archivestats)(?:\b|$)/.test(prompt);
}

// SEEKDEEP_ARCHIVE_STATUS_TARGET_ROUTE_V2_START
function seekdeepArchiveStatusMentionedUser(message) {
  const selfId = message?.client?.user?.id || '';
  return Array.from(message?.mentions?.users?.values?.() || []).find((user) => user?.id && user.id !== selfId) || null;
}

async function seekdeepArchiveStatusTargetFromMessage(message, prompt = '') {
  const clean = seekdeepArchiveStatusCleanPrompt(prompt || message?.content || '').toLowerCase();
  const mentionedUser = seekdeepArchiveStatusMentionedUser(message);
  const scope = /^(?:archive\s*status|archivestatus|status\s+archive|archive\s+stats|archivestats)\s+shared\b/i.test(clean) ? 'shared' : 'user';
  const targetUser = scope === 'shared' ? null : (mentionedUser || message?.author || null);
  let targetMember = scope === 'shared' ? null : (mentionedUser ? null : message?.member || null);
  if (mentionedUser && message?.guild?.members?.fetch) {
    targetMember = await message.guild.members.fetch(mentionedUser.id).catch(() => null);
  }
  return {
    message,
    guild: message?.guild || null,
    guildId: message?.guild?.id || '',
    channel: message?.channel || null,
    author: targetUser || message?.author || null,
    user: targetUser,
    member: targetMember,
    archiveStatusScope: scope,
    archiveStatusRequestedBy: message?.author || null,
  };
}

async function seekdeepArchiveFetchThreadById(channel, threadId = '') {
  const id = String(threadId || '').trim();
  if (!channel || !id) return null;
  let thread = channel.threads?.cache?.get?.(id) || null;
  if (!thread && typeof channel.threads?.fetch === 'function') thread = await channel.threads.fetch(id).catch(() => null);
  if (thread?.archived) { try { await thread.setArchived(false, 'SeekDeep archive status lookup'); } catch {} }
  return thread || null;
}

async function seekdeepArchiveListThreads(channel) {
  const threads = [];
  if (!channel?.threads) return threads;
  const seen = new Set();
  const add = (thread) => {
    if (thread?.id && !seen.has(thread.id)) { seen.add(thread.id); threads.push(thread); }
  };
  const active = await channel.threads.fetchActive().catch(() => null);
  active?.threads?.forEach?.(add);
  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  archivedPublic?.threads?.forEach?.(add);
  return threads;
}

async function seekdeepFindSharedArchiveThreadFlexible(channel) {
  const threads = await seekdeepArchiveListThreads(channel);
  return threads.find((thread) => /^(?:shared|.*shared\s+archive.*)$/i.test(String(thread?.name || '').trim())) || null;
}

async function seekdeepFindUserArchiveThreadFlexible(channel, subject, user, profile = {}) {
  if (!channel) return null;
  const byId = await seekdeepArchiveFetchThreadById(channel, profile?.threadId || '');
  if (byId) return byId;
  const display = typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject || user).toLowerCase() : '';
  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;
  const expected = typeof seekdeepArchiveThreadBuildName === 'function' ? seekdeepArchiveThreadBuildName(subject || user, trusted) : '';
  if (expected && typeof seekdeepFindArchiveThreadByName === 'function') {
    const exact = await seekdeepFindArchiveThreadByName(channel, expected).catch(() => null);
    if (exact) return exact;
  }
  if (typeof seekdeepLegacyArchiveUserThreadName === 'function') {
    const legacy = seekdeepLegacyArchiveUserThreadName(user || subject || {});
    const legacyThread = await seekdeepFindArchiveThreadByName(channel, legacy).catch(() => null);
    if (legacyThread) return legacyThread;
  }
  const threads = await seekdeepArchiveListThreads(channel);
  const userIdSuffix = user?.id ? String(user.id).slice(-6) : '';
  return threads.find((thread) => {
    const name = String(thread?.name || '').toLowerCase();
    if (!/archive/.test(name)) return false;
    if (display && name.includes(display)) return true;
    if (userIdSuffix && name.includes(userIdSuffix)) return true;
    return false;
  }) || null;
}

async function seekdeepCountArchiveEntryMessages(thread) {
  if (!thread?.messages?.fetch) return 0;
  let count = 0;
  let before = null;
  for (let page = 0; page < 10; page += 1) {
    const options = { limit: 100 };
    if (before) options.before = before;
    const messages = await thread.messages.fetch(options).catch(() => null);
    if (!messages || messages.size === 0) break;
    for (const msg of messages.values()) {
      const text = String(msg?.content || '');
      if (/SeekDeep\s+(?:Image\s+)?Archive\s+Entry/i.test(text) || /SeekDeep\s+Shared\s+Archive\s+Entry/i.test(text)) count += 1;
    }
    before = messages.last()?.id || null;
    if (!before || messages.size < 100) break;
  }
  return count;
}

async function seekdeepArchiveTrustedOrBackfilledCount(thread, profile = {}) {
  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;
  const scanned = await seekdeepCountArchiveEntryMessages(thread);
  return Math.max(trusted, scanned);
}
// SEEKDEEP_ARCHIVE_STATUS_TARGET_ROUTE_V2_END

function seekdeepArchiveStatusTargetFallback(target = null) {
  if (target) return target;
  if (typeof interaction !== 'undefined' && interaction) return interaction;
  if (typeof message !== 'undefined' && message) return message;
  return {};
}

function seekdeepArchiveScopeLabelForTarget(target = null) {
  const safeTarget = seekdeepArchiveStatusTargetFallback(target);
  if (safeTarget?.guild?.id || safeTarget?.guildId || safeTarget?.message?.guild?.id || safeTarget?.message?.guildId) {
    return 'this server';
  }
  return 'this DM';
}

function seekdeepArchiveDirForStatusTarget(target = null) {
  const safeTarget = seekdeepArchiveStatusTargetFallback(target);

  if (typeof seekdeepArchiveDirForTarget === 'function') {
    return seekdeepArchiveDirForTarget(safeTarget);
  }

  const guildId = safeTarget?.guild?.id || safeTarget?.guildId || safeTarget?.message?.guild?.id || safeTarget?.message?.guildId || '';
  const userId = safeTarget?.author?.id || safeTarget?.user?.id || safeTarget?.member?.user?.id || 'unknown';
  const scope = guildId ? `guild-${guildId}` : `dm-${userId}`;
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const dir = path.join(baseDir, 'saved_generations', 'archives', scope);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function seekdeepFormatBytesCompact(bytes = 0) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function seekdeepLocalArchiveStatsForTarget(target = null) {
  const safeTarget = target || {};
  const guildId = safeTarget?.guild?.id || safeTarget?.guildId || safeTarget?.message?.guild?.id || safeTarget?.message?.guildId || '';
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const dirs = [];

  if (guildId) {
    dirs.push(path.join(baseDir, 'saved_generations', 'archives', `guild-${guildId}`));
  }

  dirs.push(path.join(baseDir, 'saved_generations', 'archives'));
  dirs.push(path.join(baseDir, 'saved_generations'));

  const seen = new Set();
  const stats = {
    files: 0,
    images: 0,
    metadata: 0,
    migratedMarkers: 0,
    bytes: 0,
    newest: null,
  };

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, name);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);

        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch {}

        if (!stat || !stat.isFile()) continue;

        stats.files += 1;
        stats.bytes += Number(stat.size || 0);

        if (/\.(?:png|jpe?g|webp|gif)$/i.test(name)) stats.images += 1;
        if (/\.json$/i.test(name)) stats.metadata += 1;
        if (/\.discord-thread-migrated$/i.test(name)) stats.migratedMarkers += 1;

        if (!stats.newest || Number(stat.mtimeMs || 0) > Number(stats.newest.mtimeMs || 0)) {
          stats.newest = { name, mtimeMs: stat.mtimeMs };
        }
      }
    } catch (err) {
      console.warn('SeekDeep local archive stats scan failed:', err?.message || err);
    }
  }

  return stats;
}

async function seekdeepFindArchiveThreadByName(channel, threadName) {
  if (!channel?.threads) return null;

  const active = await channel.threads.fetchActive().catch(() => null);
  const activeThread = active?.threads?.find((thread) => thread?.name === threadName);
  if (activeThread) return activeThread;

  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  const archivedThread = archivedPublic?.threads?.find((thread) => thread?.name === threadName);
  if (archivedThread) return archivedThread;

  return null;
}

async function seekdeepArchiveThreadHealthForTarget(target = null) {
  const safeTarget = target || {};
  const guild = safeTarget?.guild || safeTarget?.message?.guild || safeTarget?.channel?.guild || null;
  const statusScope = safeTarget?.archiveStatusScope || 'user';

  if (!guild) {
    return {
      scope: 'this DM',
      statusScope,
      hasGuild: false,
      channel: null,
      sharedThread: null,
      userThread: null,
      userThreadName: '',
      userCount: 0,
      subjectName: '',
      error: 'Discord archive threads require a server.',
    };
  }

  let channel = null;
  let error = '';

  try {
    channel = await seekdeepGetOrCreateGuildArchiveChannel(safeTarget);
  } catch (err) {
    error = err?.message || String(err);
  }

  const sharedThread = channel ? await seekdeepFindSharedArchiveThreadFlexible(channel) : null;
  const user = safeTarget?.user || safeTarget?.author || safeTarget?.member?.user || safeTarget?.message?.author || null;
  const member = user && typeof seekdeepArchiveThreadResolveMember === 'function' ? await seekdeepArchiveThreadResolveMember(safeTarget, user) : null;
  const subject = member || safeTarget?.member || user;
  const subjectName = subject && typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject) : '';
  const profile = guild?.id && user?.id && typeof seekdeepArchiveThreadGetUserProfile === 'function' ? seekdeepArchiveThreadGetUserProfile(guild.id, user.id) : {};
  const userThread = channel && statusScope !== 'shared' && user ? await seekdeepFindUserArchiveThreadFlexible(channel, subject, user, profile) : null;
  const userCount = userThread ? await seekdeepArchiveTrustedOrBackfilledCount(userThread, profile) : (typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0);
  const userThreadName = user ? (typeof seekdeepArchiveThreadBuildName === 'function' ? seekdeepArchiveThreadBuildName(subject, userCount) : seekdeepArchiveUserThreadName(subject, userCount)) : '';

  return {
    scope: 'this server',
    statusScope,
    hasGuild: true,
    channel,
    sharedThread,
    userThread,
    userThreadName,
    userCount,
    subjectName,
    user,
    error,
  };
}

async function seekdeepBuildArchiveStatusReportV2(target = null) {
  const health = await seekdeepArchiveThreadHealthForTarget(target);
  const subjectLine = health.statusScope === 'shared'
    ? 'Target: shared archive'
    : ('Target user: ' + (health.subjectName || health.user?.username || 'current user'));

  const lines = [
    'Image archive status',
    `Scope: ${health.scope}`,
    subjectLine,
    `Archive channel: ${health.channel ? `<#${health.channel.id}>` : 'missing'}`,
    `Shared thread: ${health.sharedThread ? `<#${health.sharedThread.id}>` : 'missing'}`,
  ];

  if (health.statusScope !== 'shared') {
    lines.push(`User thread: ${health.userThread ? `<#${health.userThread.id}>` : `missing${health.userThreadName ? ` (${health.userThreadName})` : ''}`}`);
    lines.push(`Tracked archived image posts: ${health.userThread ? String(health.userCount || 0) : '0'}`);
  }

  if (health.error) {
    lines.push('', `Archive thread warning: ${health.error}`);
  }

  return lines.join('\n');
}

// SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V2_START
function seekdeepNormalizeArchiveOpenPrompt(value = '') {
  const raw = String(value || '').trim();

  return raw
    // Discord can resolve @SeekDeep as a role mention (<@&id>) instead of the bot user mention.
    // Treat only leading user/role mentions as command-addressing noise. Later user mentions are
    // preserved so "archive @user" still targets the requested user.
    .replace(/^\s*(?:<@(?:!|&)?\d+>\s*)+/g, ' ')
    .replace(/\bseekotics\b/gi, ' ')
    .replace(/\bseekdeep\b/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function seekdeepIsArchiveOpenPrompt(value = '') {
  const raw = String(value || '').trim();
  const stripLeadingArchiveAddress = (input = '') => String(input || '')
    .replace(/^(?:\s*(?:<@!?\d+>|<@&\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, ' ')
    .replace(/^[/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const withoutLeadingAddress = stripLeadingArchiveAddress(raw);
  const withoutLeadingAddressLower = withoutLeadingAddress.toLowerCase();
  const cleanedBase = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? seekdeepCleanMessageCommandPrompt(raw)
    : withoutLeadingAddress;
  const cleaned = stripLeadingArchiveAddress(cleanedBase).toLowerCase();

    if (typeof seekdeepArchiveIsCountPrompt === 'function' && seekdeepArchiveIsCountPrompt(raw)) return true;

  return Boolean(
    /^(?:archive|open\s+archive)(?:\s+for)?\s+(?:shared|me)$/i.test(cleaned) ||
    /^(?:archive|open\s+archive)(?:\s+for)?\s+<@!?\d+>$/i.test(withoutLeadingAddress) ||
    /^(?:archive|open\s+archive)(?:\s+for)?\s+@/i.test(withoutLeadingAddressLower)
  );
}
// SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V2_END

async function seekdeepHandleArchiveOpenMessage(message, prompt = '') {
  if (typeof seekdeepHandleArchiveCountMessage === 'function' && await seekdeepHandleArchiveCountMessage(message, prompt || message?.content || '')) return true;

  if (!message || !seekdeepIsArchiveOpenPrompt(prompt || message.content || '')) return false;

  if (!message.guild) {
    await message.reply({
      content: 'Archive threads only work inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const raw = String(prompt || message.content || '');
  const cleanBase = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? seekdeepCleanMessageCommandPrompt(raw)
    : raw;
  const clean = String(cleanBase || '')
    .replace(/^(?:\s*(?:<@!?\d+>|<@&\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-open-message', raw);
  }

  if (/\bshared\b/i.test(clean)) {
    const { thread } = await seekdeepGetOrCreateSharedArchiveThread(message);
    await message.reply({
      content: `Shared archive: <#${thread.id}>`,
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  let targetUser = message.author;
  const selfUserId = message.client?.user?.id || null;
  const mentionedUsers = Array.from(message.mentions?.users?.values?.() || []);
  const mentioned = mentionedUsers.find((user) => user && user.id !== selfUserId) || null;

  if (mentioned) {
    targetUser = mentioned;
  } else if (!/\bme\b/i.test(clean)) {
    await message.reply({
      content: 'Use `archive me`, `archive shared`, `archive @user`, or `archive for @user`.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);

  await message.reply({
    content: [
      mentioned ? `Archive for <@${targetUser.id}>: <#${thread.id}>` : `Your archive: <#${thread.id}>`,
      `Thread: ${threadName}`,
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });

  return true;
}

function seekdeepBuildArchiveStatusReport(target = null) {
  return [
    'Image archive status',
    'Archive storage uses Discord threads only.',
    'Use `@SeekDeep archive status` or `/archivestatus` for live thread status.',
  ].join('\n');
}

// SEEKDEEP_NATURAL_ARCHIVE_FOLLOWUP_START
// Match natural-language archive-image followups like:
//   "archive this", "archive it", "archive too", "archive that", "archive the image"
//   "save this", "save it", "save the image"
//   "add this to my archive", "put it in my archive"
//   "make it archive too", "make this archive"
//   "shared archive this", "send to shared archive", "share this", "save to shared"
function seekdeepIsNaturalArchiveImageFollowup(value = '') {
  const p = String(value || '').toLowerCase().trim();
  if (!p) return false;
  const stripped = p
    .replace(/^(?:\s*(?:<@!?\d+>|<@&\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, '')
    .replace(/^[/\s]+/g, '')
    .trim();
  if (!stripped) return false;
  return (
    /^(?:make\s+(?:it|this|that)\s+archive(?:\s+too|\s+shared)?|archive\s+(?:this|that|it|too|the\s+image|this\s+(?:one|image|picture|pic))|save\s+(?:this|that|it|the\s+image|this\s+(?:image|picture|pic)|to\s+(?:my\s+|the\s+)?(?:shared\s+)?archive)|add\s+(?:this|it|that)\s+to\s+(?:my\s+|the\s+)?(?:shared\s+)?archive|put\s+(?:this|it|that)\s+in\s+(?:my\s+|the\s+)?(?:shared\s+)?archive|share\s+(?:this|that|it|the\s+image)|shared\s+archive\s+(?:this|that|it|the\s+image)|send\s+(?:this|that|it)\s+to\s+(?:the\s+)?shared\s+archive)\s*[.!?]*$/i.test(stripped)
  );
}

function seekdeepWantsSharedArchive(value = '') {
  const p = String(value || '').toLowerCase();
  return /\b(?:shared(?:\s+archive)?|share\s+(?:this|that|it|the\s+image))\b/.test(p);
}

async function seekdeepFindRecentSeekDeepImageActionId(message) {
  const channel = message?.channel;
  const botId = message?.client?.user?.id || (typeof client !== 'undefined' && client?.user?.id) || '';
  if (!channel?.messages?.fetch || !botId) return null;

  const fetched = await channel.messages.fetch({ limit: 30, before: message.id }).catch(() => null);
  if (!fetched) return null;

  const sorted = Array.from(fetched.values()).sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
  for (const msg of sorted) {
    if (!msg || msg.author?.id !== botId) continue;
    const components = msg.components || [];
    for (const row of components) {
      const buttons = row?.components || [];
      for (const button of buttons) {
        const customId = String(button?.customId || '');
        const match = customId.match(/^seekdeep:(?:archive|sharedarchive|shared-archive|shared_archive):(.+)$/i);
        if (match && match[1]) {
          return { actionId: String(match[1]).trim(), sourceMessage: msg };
        }
      }
    }
  }
  return null;
}

async function seekdeepHandleNaturalArchiveImageFollowup(message, prompt = '') {
  const raw = String(prompt || message?.content || '');
  if (!seekdeepIsNaturalArchiveImageFollowup(raw)) return false;

  if (!message?.guild) {
    await message.reply({
      content: 'Archive threads only work inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const wantsShared = seekdeepWantsSharedArchive(raw);

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute(wantsShared ? 'natural-archive-followup-shared' : 'natural-archive-followup-user', raw);
  }

  const found = await seekdeepFindRecentSeekDeepImageActionId(message);
  if (!found) {
    await message.reply({
      content: [
        "I couldn't find a recent SeekDeep image in this channel to archive.",
        'Generate an image first, then click the Archive button under it,',
        'or use `@SeekDeep archive me` to open your archive thread.',
      ].join('\n'),
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  let state = null;
  try {
    state = seekdeepTempImageStateIndex?.get?.(found.actionId) || null;
  } catch {}
  if (!state && typeof seekdeepLoadTempImageState === 'function') {
    try { state = seekdeepLoadTempImageState(found.actionId); } catch {}
  }

  if (!state) {
    await message.reply({
      content: [
        "I found a recent image but its temporary cache expired, so I can't archive it from chat.",
        'Click the Archive button on the image while it still has buttons,',
        'or regenerate it and try again.',
      ].join('\n'),
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  try {
    if (wantsShared) {
      const result = typeof seekdeepArchiveImageStateToSharedDiscordThread === 'function'
        ? await seekdeepArchiveImageStateToSharedDiscordThread(state, message)
        : null;
      const lines = ['Archived to shared archive.'];
      if (result?.threadId) lines.push('Thread: <#' + result.threadId + '>');
      if (result?.archiveCount !== undefined) lines.push('Shared archive count: ' + result.archiveCount);
      await message.reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } });
    } else {
      const result = typeof seekdeepArchiveImageStateToDiscordThread === 'function'
        ? await seekdeepArchiveImageStateToDiscordThread(state, message)
        : null;
      const lines = ['Archived to your archive.'];
      if (result?.threadName) lines.push('Thread: ' + result.threadName);
      await message.reply({ content: lines.join('\n'), allowedMentions: { repliedUser: false } });
    }
  } catch (err) {
    if (err?.code === 'SEEKDEEP_ARCHIVE_NOT_CONFIGURED' || err?.code === 'SEEKDEEP_ARCHIVE_PERMISSIONS_MISSING') {
      await message.reply({
        content: String(err?.message || 'Archive channel is not ready for this server.').slice(0, 1800),
        allowedMentions: { repliedUser: false },
      });
      return true;
    }
    console.warn('Natural archive followup failed:', err?.message || err);
    await message.reply({
      content: 'Archive failed: ' + String(err?.message || err || 'unknown error').slice(0, 500),
      allowedMentions: { repliedUser: false },
    });
  }
  return true;
}
// SEEKDEEP_NATURAL_ARCHIVE_FOLLOWUP_END

function seekdeepCleanMessageCommandPrompt(value) {
  return normalizeUserText(String(value || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(/\b@?(?:seekdeep|seekotics)\b[,:-]?/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
  );
}

// SEEKDEEP_SHARED_ARCHIVE_BUTTON_V1_START
const SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE = 'seekdeep-shared-archive-posts-v1';

function seekdeepSharedArchiveThreadBuildName(count = 0) {
  const bullet = typeof seekdeepArchiveThreadBullet === 'function' ? seekdeepArchiveThreadBullet() : '\u2022';
  const coin = typeof seekdeepArchiveThreadCoinEmoji === 'function' ? seekdeepArchiveThreadCoinEmoji() : '\u{1FA99}';
  const safeCount = Math.max(0, Number(count || 0) || 0);
  const name = [coin, 'Shared Archive', String(safeCount)].join(' ' + bullet + ' ');
  return typeof seekdeepArchiveThreadClampName === 'function' ? seekdeepArchiveThreadClampName(name) : name.slice(0, 96);
}

function seekdeepSharedArchiveGetProfile(guildId = '') {
  const gid = String(guildId || '').trim();
  if (!gid) return {};
  const config = typeof seekdeepArchiveThreadReadConfig === 'function' ? seekdeepArchiveThreadReadConfig() : {};
  const guildConfig = typeof seekdeepArchiveThreadEnsureGuildConfig === 'function' ? seekdeepArchiveThreadEnsureGuildConfig(config, gid) : ((config.guilds ||= {})[gid] ||= {});
  return Object.assign({}, guildConfig.sharedArchive || {});
}

function seekdeepSharedArchiveSaveProfile(guildId = '', profile = {}) {
  const gid = String(guildId || '').trim();
  if (!gid) return false;
  const config = typeof seekdeepArchiveThreadReadConfig === 'function' ? seekdeepArchiveThreadReadConfig() : {};
  const guildConfig = typeof seekdeepArchiveThreadEnsureGuildConfig === 'function' ? seekdeepArchiveThreadEnsureGuildConfig(config, gid) : ((config.guilds ||= {})[gid] ||= {});
  guildConfig.sharedArchive = Object.assign({}, guildConfig.sharedArchive || {}, profile || {}, { updatedAt: new Date().toISOString() });
  return typeof seekdeepArchiveThreadWriteConfig === 'function' ? seekdeepArchiveThreadWriteConfig(config) : false;
}

function seekdeepSharedArchiveTrustedCount(profile = {}) {
  if (!profile || profile.countSource !== SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE) return 0;
  return Math.max(0, Number(profile.count || 0) || 0);
}

async function seekdeepScanThreadArchiveEntryStats(thread, marker = 'SeekDeep Shared Archive Entry') {
  const stats = {
    ok: false,
    count: 0,
    scannedMessages: 0,
    marker,
  };

  if (!thread?.messages?.fetch) return stats;

  let before = undefined;
  for (let page = 0; page < 10; page += 1) {
    const messages = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch((err) => {
      stats.error = err?.message || String(err);
      return null;
    });

    if (!messages) return stats;
    stats.ok = true;

    if (!messages.size) break;
    const sorted = Array.from(messages.values()).sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
    for (const message of sorted) {
      stats.scannedMessages += 1;
      if (String(message?.content || '').includes(marker)) stats.count += 1;
    }
    before = sorted[sorted.length - 1]?.id;
    if (!before || messages.size < 100 || stats.scannedMessages >= 1000) break;
  }

  return stats;
}

async function seekdeepScanThreadArchiveEntryCount(thread, marker = 'SeekDeep Shared Archive Entry') {
  const stats = await seekdeepScanThreadArchiveEntryStats(thread, marker);
  return stats.ok ? stats.count : 0;
}

async function seekdeepFindSharedArchiveThreadForStatus(channel, guild = null) {
  if (!channel) return null;
  const guildId = String(guild?.id || channel?.guild?.id || '').trim();
  const profile = guildId ? seekdeepSharedArchiveGetProfile(guildId) : {};
  const desiredPrefix = seekdeepSharedArchiveThreadBuildName(0).replace(/\s+0$/, '');
  const findCandidate = (threads) => threads?.find?.((thread) => {
    const name = String(thread?.name || '');
    return (profile.threadId && thread?.id === profile.threadId) || name === 'Shared' || name.startsWith(desiredPrefix);
  }) || null;

  const active = await channel.threads.fetchActive().catch(() => null);
  let thread = findCandidate(active?.threads);
  if (thread) return thread;

  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  thread = findCandidate(archivedPublic?.threads);
  if (thread?.archived) await thread.setArchived(false, 'SeekDeep shared archive lookup').catch(() => null);
  return thread || null;
}

async function seekdeepRecordSharedArchivePost(archiveInfo, target) {
  const thread = archiveInfo?.thread || null;
  const guildId = String(thread?.guild?.id || thread?.parent?.guild?.id || archiveInfo?.channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '').trim();
  if (!guildId || !thread) return { threadName: archiveInfo?.threadName || thread?.name || '', count: Math.max(0, Number(archiveInfo?.count || 0) || 0) };

  const profile = seekdeepSharedArchiveGetProfile(guildId);
  const fallbackCount = seekdeepSharedArchiveTrustedCount(profile) + 1;
  let count = fallbackCount;
  let scanStats = null;

  if (typeof seekdeepScanThreadArchiveEntryStats === 'function') {
    scanStats = await seekdeepScanThreadArchiveEntryStats(thread, 'SeekDeep Shared Archive Entry');
    if (scanStats.ok && Number(scanStats.count || 0) > 0) {
      count = Math.max(0, Number(scanStats.count || 0));
    } else if (!scanStats.ok) {
      console.warn('[SeekDeep] shared archive count scan failed; keeping fallback count:', scanStats.error || 'unknown scan failure');
    }
  }

  const nextName = seekdeepSharedArchiveThreadBuildName(count);
  seekdeepSharedArchiveSaveProfile(guildId, {
    threadId: thread.id,
    threadName: nextName,
    count,
    countSource: SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE,
    lastArchivedAt: new Date().toISOString(),
    lastCountScanAt: new Date().toISOString(),
    lastCountScanMessages: Number(scanStats?.scannedMessages || 0) || 0,
    lastCountScanEntries: Number(scanStats?.count || 0) || 0,
  });
  if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, nextName);
  else if (thread.name !== nextName) await thread.setName(nextName, 'SeekDeep shared archive count update').catch(() => null);
  return { threadName: nextName, count, scanStats };
}

function seekdeepSharedArchiveMetadataLines(state, target) {
  state = state || {};
  const requester = target?.user || target?.author || target?.member?.user || target?.message?.author || null;
  const requesterLine = requester?.id ? '<@' + requester.id + '>' : (requester?.username || 'unknown');
  const prompt = String(state.prompt || state.originalPrompt || state.refinedPrompt || state.generationPrompt || 'image').replace(/\s+/g, ' ').trim();
  const width = Number(state.width || state.w || 1024) || 1024;
  const height = Number(state.height || state.h || 1024) || 1024;
  return [
    '**SeekDeep Shared Archive Entry**',
    'Requester: ' + requesterLine,
    'Prompt: ' + prompt,
    'Size: ' + width + 'x' + height,
    'Archived: ' + new Date().toISOString(),
  ];
}
// SEEKDEEP_SHARED_ARCHIVE_BUTTON_V1_END

// SEEKDEEP_SHARED_ARCHIVE_SETUP_BOOTSTRAP_V2_START
async function seekdeepEnsureSharedArchiveThreadForChannel(channel, target = null, options = {}) {
  if (!channel || !channel.threads) {
    throw new Error('Shared Archive requires a configured text channel with thread support.');
  }

  const guild = channel.guild || target?.guild || target?.message?.guild || target?.channel?.guild || null;
  const guildId = String(guild?.id || channel?.guild?.id || '').trim();
  const profile = guildId && typeof seekdeepSharedArchiveGetProfile === 'function'
    ? seekdeepSharedArchiveGetProfile(guildId)
    : {};

  let currentCount = typeof seekdeepSharedArchiveTrustedCount === 'function'
    ? seekdeepSharedArchiveTrustedCount(profile)
    : Math.max(0, Number(profile?.count || 0) || 0);

  let thread = null;

  if (profile?.threadId && channel?.threads?.fetch) {
    thread = await channel.threads.fetch(profile.threadId).catch(() => null);
  }

  const baseName = typeof seekdeepSharedArchiveThreadBuildName === 'function'
    ? seekdeepSharedArchiveThreadBuildName(0)
    : '\u{1FA99} \u2022 Shared Archive \u2022 0';
  const sharedPrefix = String(baseName).replace(/\s+0$/, '').trim();
  const matchesSharedThread = (candidate) => {
    if (!candidate) return false;
    const name = String(candidate.name || '').trim();
    if (!name) return false;
    if (profile?.threadId && candidate.id === profile.threadId) return true;
    if (profile?.threadName && name === profile.threadName) return true;
    if (name === 'Shared') return true;
    if (sharedPrefix && name.startsWith(sharedPrefix)) return true;
    return /Shared\s+Archive/i.test(name);
  };

  if (!thread) {
    const active = await channel.threads.fetchActive().catch(() => null);
    thread = active?.threads?.find?.(matchesSharedThread) || null;
  }

  if (!thread) {
    const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
    thread = archivedPublic?.threads?.find?.(matchesSharedThread) || null;
  }

  if (thread?.archived) {
    await thread.setArchived(false, 'SeekDeep shared archive bootstrap').catch(() => null);
  }

  let countScanStats = null;
  if (thread && typeof seekdeepScanThreadArchiveEntryStats === 'function') {
    countScanStats = await seekdeepScanThreadArchiveEntryStats(thread, 'SeekDeep Shared Archive Entry');
    if (countScanStats.ok) {
      currentCount = Math.max(0, Number(countScanStats.count || 0) || 0);
    } else if (profile?.countSource !== SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE) {
      currentCount = 0;
    }
  }

  const threadName = typeof seekdeepSharedArchiveThreadBuildName === 'function'
    ? seekdeepSharedArchiveThreadBuildName(currentCount)
    : ('\u{1FA99} \u2022 Shared Archive \u2022 ' + String(Math.max(0, Number(currentCount || 0) || 0))).slice(0, 96);

  if (!thread) {
    thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: options?.reason || 'SeekDeep shared image archive thread bootstrap',
    });
    await thread.send('\u{1FA99} SeekDeep shared archive.\nSaved generations from this server will appear here.').catch(() => null);
  } else if (thread.name !== threadName) {
    if (typeof seekdeepMaybeRenameArchiveThread === 'function') {
      await seekdeepMaybeRenameArchiveThread(thread, threadName);
    } else {
      await thread.setName(threadName, 'SeekDeep shared archive bootstrap name update').catch(() => null);
    }
  }

  if (guildId && typeof seekdeepSharedArchiveSaveProfile === 'function') {
    seekdeepSharedArchiveSaveProfile(guildId, {
      threadId: thread.id,
      threadName,
      count: currentCount,
      countSource: SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE,
      lastCountScanAt: countScanStats?.ok ? new Date().toISOString() : profile?.lastCountScanAt,
      lastCountScanMessages: countScanStats?.ok ? (Number(countScanStats.scannedMessages || 0) || 0) : profile?.lastCountScanMessages,
      lastCountScanEntries: countScanStats?.ok ? (Number(countScanStats.count || 0) || 0) : profile?.lastCountScanEntries,
      bootstrapSource: options?.source || 'shared-archive-setup-bootstrap-v2',
      bootstrapAt: new Date().toISOString(),
    });
  }

  return { channel, thread, threadName, count: currentCount, shared: true };
}
// SEEKDEEP_SHARED_ARCHIVE_SETUP_BOOTSTRAP_V2_END

async function seekdeepGetOrCreateSharedArchiveThread(target) {
  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);
  if (typeof seekdeepEnsureSharedArchiveThreadForChannel === 'function') {
    return await seekdeepEnsureSharedArchiveThreadForChannel(channel, target, {
      source: 'shared-archive-get-or-create',
      reason: 'SeekDeep shared image archive thread',
    });
  }

  throw new Error('Shared Archive bootstrap helper is not available. Re-run the Shared Archive setup patch.');
}

async function seekdeepHandleArchiveStatusMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveStatusPrompt(prompt || message.content || '')) {
    return false;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-status-message', prompt || message.content || '');
  }

  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();
  const statusTarget = await seekdeepArchiveStatusTargetFromMessage(message, prompt || message.content || '');
  const report = await seekdeepBuildArchiveStatusReportV2(statusTarget);

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(report, {
        startedAt,
        modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
      })
    : report;

  await message.reply({
    content,
    allowedMentions: { repliedUser: false },
  });

  return true;
}

function seekdeepBotUserId() {
  return String(client?.user?.id || process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '').trim();
}

function seekdeepCountBotMentionTags(value = '') {
  const text = String(value || '');
  const botId = seekdeepBotUserId();

  if (!botId) {
    return 0;
  }

  const normalMention = new RegExp(`<@${botId}>`, 'g');
  const nicknameMention = new RegExp(`<@!${botId}>`, 'g');

  return (text.match(normalMention) || []).length + (text.match(nicknameMention) || []).length;
}

// Strip Discord quoted blocks (lines starting with "> "), inline code spans
// (`...`), and fenced code blocks (```...```) so mention counting only sees
// the user's own non-quoted text. Without this, pasting the help text (which
// contains many "@SeekDeep" occurrences) trips the multiple-mention guard.
function seekdeepStripQuotedAndCodeBlocks(value = '') {
  let text = String(value || '');
  // Triple-backtick fenced blocks.
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // Single-backtick inline code.
  text = text.replace(/`[^`\n]+`/g, ' ');
  // Discord block-quote lines: lines beginning with "> " (or ">>> " for multi-line quotes).
  // For ">>> ", everything until end-of-message is quoted — but since we're working on a
  // single message string, we just drop any line that starts with ">".
  text = text
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  return text;
}

function seekdeepCountBotAddressingOccurrences(value = '') {
  const text = seekdeepStripQuotedAndCodeBlocks(String(value || ''));
  const botId = seekdeepBotUserId();
  let count = 0;

  if (botId) {
    const directMention = new RegExp('<@!?' + botId + '>', 'g');
    count += (text.match(directMention) || []).length;
  }

  const explicitNameAddress = /@(?:seekdeep|seekotics)\b/gi;
  count += (text.match(explicitNameAddress) || []).length;

  const lineAddress = /(?:^|\n)\s*(?:<@&\d+>|seekdeep\b|seekotics\b)/gi;
  count += (text.match(lineAddress) || []).length;

  return count;
}

function seekdeepStripBotMentions(value = '') {
  return stripBotMentions(value);
}

function seekdeepMessageMentionsBot(message = null) {
  if (!message) return false;

  const botId = seekdeepBotUserId();
  const content = String(message.content || '');

  if (botId && seekdeepCountBotMentionTags(content) > 0) {
    return true;
  }

  if (botId && message.mentions?.users?.has?.(botId)) {
    return true;
  }

  if (/^\s*(?:<@&\d+>\s*)+/.test(content)) {
    const cleaned = stripBotMentions(content);
    if (cleaned) {
      return true;
    }
  }

  return /\b@?SEEKOTICS\b/i.test(content) || /\b@?SeekDeep\b/i.test(content);
}

function seekdeepRemovedArchiveCommandIsAddressed(message = null, raw = '') {
  if (!message) return false;

  const content = String(raw || message.content || '');
  const botId = seekdeepBotUserId();

  if (botId && seekdeepCountBotMentionTags(content) > 0) return true;
  if (botId && message.mentions?.users?.has?.(botId)) return true;
  if (/^\s*@?(?:seekdeep|seekotics)\b/i.test(content)) return true;
  if (/^\s*(?:<@&\d+>\s*)+/.test(content)) return true;

  return false;
}

async function seekdeepHandleRemovedArchiveCommandMessage(message = null, raw = '') {
  const content = String(raw || message?.content || '');
  if (!content || !seekdeepRemovedArchiveCommandIsAddressed(message, content)) return false;

  const removedArchiveCommandText = typeof seekdeepRemovedArchiveCommandText === 'function'
    ? seekdeepRemovedArchiveCommandText(content)
    : '';
  if (!removedArchiveCommandText) return false;

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('removed-archive-command', seekdeepCleanRemovedArchiveCommandLine(content));
  }
  seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  await sendLongMessageReply(message, removedArchiveCommandText, {
    modelUsed: seekdeepNoModelLabel(),
  });
  return true;
}


function seekdeepLogRoute(route, prompt = '') {
  const safeRoute = String(route || 'unknown').trim() || 'unknown';
  const safePrompt = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  try {
    console.log(`[SeekDeep] route=${safeRoute} prompt=${safePrompt}`);
  } catch {}
}


// SEEKDEEP_CANONICAL_MEMORY_HELPERS_START
const SEEKDEEP_MEMORY_COMPAT_STORE_V13 = globalThis.__seekdeepMemoryCompatStoreV13 || new Map();
globalThis.__seekdeepMemoryCompatStoreV13 = SEEKDEEP_MEMORY_COMPAT_STORE_V13;

function seekdeepNormalizeUserTextSafeV12(value = '') {
  return normalizeUserText(value);
}

function seekdeepMemoryNormalizeSafeV13(value = '') {
  return normalizeUserText(value);
}

function seekdeepMemoryNumberFromEnv(names, fallback, min, max = Number.POSITIVE_INFINITY) {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) {
      return Math.max(min, Math.min(max, value));
    }
  }
  return Math.max(min, Math.min(max, fallback));
}

function seekdeepMemoryMode() {
  const mode = String(process.env.SEEKDEEP_MEMORY_MODE || 'rolling').trim().toLowerCase();
  if (['off', 'none', 'false', 'disabled'].includes(mode)) return 'off';
  if (['followup', 'follow-up', 'conservative'].includes(mode)) return 'followup';
  return 'rolling';
}

function seekdeepPromptShouldSkipRollingMemory(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return true;
  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(p)) return true;
  if (typeof isBotIdentityQuestion === 'function' && isBotIdentityQuestion(p)) return true;
  if (/^(?:help|commands|status|archive|cache|queue|recent|ping|pong|what\s+model|model\s+status)\b/i.test(p)) return true;
  if (typeof seekdeepHasExplicitImageRequest === 'function' && seekdeepHasExplicitImageRequest(p)) return true;
  if (typeof seekdeepLooksLikeImagePrompt === 'function' && seekdeepLooksLikeImagePrompt(p)) return true;
  return false;
}

function memoryKeyFrom(source) {
  if (!source) return 'global';
  const channelId =
    source.channelId ||
    source.channel?.id ||
    source.message?.channelId ||
    source.message?.channel?.id ||
    source.channel_id ||
    source.channelID ||
    '';
  return channelId ? 'channel:' + channelId : 'global';
}

function remember(key, role, value) {
  const clean = normalizeUserText(value || '');
  if (!key || !clean) return;

  const maxEntries = seekdeepMemoryNumberFromEnv(['MAX_CONTEXT_MESSAGES', 'SEEKDEEP_MEMORY_MAX_ENTRIES'], 28, 8, 80);
  const maxChars = seekdeepMemoryNumberFromEnv(['MAX_CONTEXT_CHARS', 'SEEKDEEP_MEMORY_MAX_CHARS'], 14000, 3000, 60000);
  const entryChars = seekdeepMemoryNumberFromEnv('SEEKDEEP_MEMORY_ENTRY_MAX_CHARS', 1800, 600, 5000);
  const existing = SEEKDEEP_MEMORY_COMPAT_STORE_V13.get(key) || [];

  existing.push({
    role: role === 'assistant' ? 'assistant' : 'user',
    text: clean.slice(0, entryChars),
    at: Date.now(),
  });

  let trimmed = existing.slice(-maxEntries);
  while (trimmed.map((entry) => entry.text).join('\n').length > maxChars && trimmed.length > 4) {
    trimmed = trimmed.slice(1);
  }

  SEEKDEEP_MEMORY_COMPAT_STORE_V13.set(key, trimmed);
}

function getRecentContext(key) {
  const maxEntries = seekdeepMemoryNumberFromEnv(['SEEKDEEP_MEMORY_RECENT_ENTRIES', 'MAX_CONTEXT_MESSAGES'], 18, 4, 40);
  const maxChars = seekdeepMemoryNumberFromEnv(['SEEKDEEP_MEMORY_CONTEXT_CHARS', 'MAX_CONTEXT_CHARS'], 12000, 2000, 40000);
  const entryChars = seekdeepMemoryNumberFromEnv('SEEKDEEP_MEMORY_RENDER_ENTRY_MAX_CHARS', 1400, 500, 3000);
  let entries = (SEEKDEEP_MEMORY_COMPAT_STORE_V13.get(key) || []).slice(-maxEntries);
  if (!entries.length) return '';

  const render = (items) => items
    .map((entry) => {
      const clean = String(entry.text || '')
        .replace(/\nSources:\n[\s\S]*$/i, '')
        .slice(0, entryChars);
      return (entry.role === 'assistant' ? 'Assistant' : 'User') + ': ' + clean;
    })
    .join('\n');

  let context = render(entries);
  while (context.length > maxChars && entries.length > 4) {
    entries = entries.slice(1);
    context = render(entries);
  }
  return context;
}

function getLastSubstantiveUserTopic(key) {
  const entries = (SEEKDEEP_MEMORY_COMPAT_STORE_V13.get(key) || []);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.role !== 'user') continue;

    const clean = normalizeUserText(String(entry.text || '')
      .replace(/^\[[^\]]+\]\s*/g, '')
      .replace(/^\/(?:ask|image|vision|refine)\s+/i, ''));
    if (clean.length < 3) continue;
    if (/^(?:help|commands|status|archive|cache|queue|recent|ping|pong)\b/i.test(clean)) continue;
    if (/^(?:post archive|regenerate|draw|draw me|show me|generate|generate me|create|make|render|paint|sketch|illustrate|design)\b/i.test(clean)) continue;
    return clean.slice(0, 240);
  }
  return '';
}

function isLikelyFollowup(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;
  if (/^(?:help|commands|status|archive|cache|queue|recent|ping|pong)\b/i.test(p)) return false;
  if (typeof seekdeepHasExplicitImageRequest === 'function' && seekdeepHasExplicitImageRequest(p)) return false;
  if (/^(?:what would be a .*nickname\b|what is a .*nickname\b|give me .*nickname\b|what should i call you\b|who are you\b|what can you do\b)/i.test(p)) return false;

  const words = p.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return true;
  return /\b(?:it|that|this|those|these|again|same|previous|earlier|continue|redo|more|less|make it|change it|fix it|refine it|look it up|search it|google it|verify it|fact check it)\b/i.test(p);
}

function shouldUseMemory(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (seekdeepPromptShouldSkipRollingMemory(p)) return false;

  const mode = seekdeepMemoryMode();
  if (mode === 'off') return false;
  if (mode === 'followup') return isLikelyFollowup(p);

  return true;
}

function buildPromptWithMemory(prompt, key) {
  const cleanPrompt = normalizeUserText(prompt || '');
  const recent = key ? getRecentContext(key) : '';
  if (!recent || !shouldUseMemory(cleanPrompt)) return cleanPrompt;

  return [
    'Recent Discord context is available as rolling conversation memory.',
    'Use it to maintain continuity, earlier constraints, names, goals, and decisions when relevant.',
    'If the current user message has clearly changed topic, ignore old context.',
    'Do not prefix your answer with "SeekDeep:" or "Assistant:".',
    '',
    recent,
    '',
    'Current user message: ' + cleanPrompt,
  ].join('\n');
}

function buildSearchQuery(prompt, key) {
  const cleanPrompt = normalizeUserText(prompt || '');
  const p = cleanPrompt.toLowerCase().trim();
  const priorTopic = key ? getLastSubstantiveUserTopic(key) : '';
  const followupNeedsPrior =
    priorTopic &&
    (
      isLikelyFollowup(cleanPrompt) ||
      /\b(look it up|search it|google it|use the internet|use web|web search|check online|actually up to date|up to date|current|latest|source|sources|verify|fact check|fact-check|should have looked)\b/i.test(p)
    );

  if (!followupNeedsPrior) return cleanPrompt;

  return (priorTopic + ' ' + cleanPrompt)
    .replace(/\b(you should have|should have|please|can you|could you|would you|use the internet to|use the internet|use web|web search|look it up|search it|google it|infer|the correct answer|if you don't know)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || priorTopic;
}

function seekdeepBuildSearchQuerySafeV15(prompt, key) {
  return buildSearchQuery(prompt, key);
}

function seekdeepBuildPromptWithMemorySafeV14(prompt, key) {
  return buildPromptWithMemory(prompt, key);
}

function seekdeepMemoryKeyFromSafeV13(source) {
  return memoryKeyFrom(source);
}

function seekdeepRememberSafeV13(key, role, value) {
  return remember(key, role, value);
}

function seekdeepGetRecentContextSafeV13(key) {
  return getRecentContext(key);
}

function seekdeepShouldUseMemorySafeV13(prompt = '') {
  return shouldUseMemory(prompt);
}

// Return the most recent 'assistant' memory entry text for this channel/user key.
// Skips entries that are obviously status / archive / queue notices so we don't reuse
// noise as an image subject. Returns '' when nothing usable is in memory.
function seekdeepLastAssistantTextSafe(key, maxAgeMs = 5 * 60 * 1000) {
  if (!key) return '';
  const entries = SEEKDEEP_MEMORY_COMPAT_STORE_V13.get(key) || [];
  const now = Date.now();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.role !== 'assistant') continue;
    if (maxAgeMs > 0 && Number(entry.at || 0) && now - Number(entry.at) > maxAgeMs) continue;
    const text = String(entry.text || '').trim();
    if (text.length < 20) continue;
    if (/^queued (both|original|refined|to|image|the)/i.test(text)) continue;
    if (/^archived to/i.test(text)) continue;
    if (/^archive\b/i.test(text)) continue;
    if (/^posting\s+archive/i.test(text)) continue;
    if (/^local ai server/i.test(text)) continue;
    if (/^image generation queue/i.test(text)) continue;
    if (/^what should i generate/i.test(text)) continue;
    if (/^pros?\/cons? of what/i.test(text)) continue;
    if (/^did you mean\b/i.test(text)) continue;
    return text;
  }
  return '';
}
// SEEKDEEP_CANONICAL_MEMORY_HELPERS_END

client.on('messageCreate', async (message) => {
  seekdeepMarkRequestStart(message);

  if (message?.id && !seekdeepClaimEventOnce(`message:${message.id}`)) {
    console.warn(`Duplicate Discord message event suppressed: ${message.id}`);
    return;
  }

  if (message.author?.bot || !client.user) return;

  try {
    const removedArchiveRawContent = String(message?.content || '');
    if (await seekdeepHandleRemovedArchiveCommandMessage(message, removedArchiveRawContent)) {
      return;
    }
  } catch (err) {
    console.error('Removed archive command handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: 'That archive command has been removed, but the notice failed to send. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }
  
  try {
    const seekdeepArchiveConfigRawContent = String(message?.content || '');
    if (await seekdeepHandleArchiveConfigMessage(message, seekdeepArchiveConfigRawContent)) {
      return;
    }
  } catch (err) {
    console.error('Archive config message handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: 'Archive channel setup failed. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }

  // SEEKDEEP_ARCHIVE_STATUS_BEFORE_OPEN_V2_START
  try {
    const seekdeepArchiveStatusRawContentEarly = String(message?.content || '');
    if (await seekdeepHandleArchiveStatusMessage(message, seekdeepArchiveStatusRawContentEarly)) {
      return;
    }
  } catch (err) {
    console.error('Archive status message handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: 'Archive status failed. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }
  // SEEKDEEP_ARCHIVE_STATUS_BEFORE_OPEN_V2_END


  try {
    const seekdeepArchiveOpenRawContent = String(message?.content || '');
    // SEEKDEEP_ARCHIVE_STRIPPED_RETRY_V1_START
    const seekdeepArchiveOpenStrippedContent = typeof seekdeepStripBotMentions === 'function'
      ? seekdeepStripBotMentions(seekdeepArchiveOpenRawContent)
      : seekdeepArchiveOpenRawContent;

    if (await seekdeepHandleArchiveOpenMessage(message, seekdeepArchiveOpenRawContent)) {
      return;
    }

    if (
      seekdeepArchiveOpenStrippedContent &&
      seekdeepArchiveOpenStrippedContent !== seekdeepArchiveOpenRawContent &&
      await seekdeepHandleArchiveOpenMessage(message, seekdeepArchiveOpenStrippedContent)
    ) {
      return;
    }
    // SEEKDEEP_ARCHIVE_STRIPPED_RETRY_V1_END

    // Natural-language archive followups ("archive this", "save it", "make it archive too",
    // "shared archive this", etc.). Looks up the most recent SeekDeep image in this channel
    // and archives it via the same flow the Archive button uses.
    if (
      typeof seekdeepHandleNaturalArchiveImageFollowup === 'function' &&
      await seekdeepHandleNaturalArchiveImageFollowup(message, seekdeepArchiveOpenRawContent)
    ) {
      return;
    }
    if (
      typeof seekdeepHandleNaturalArchiveImageFollowup === 'function' &&
      seekdeepArchiveOpenStrippedContent &&
      seekdeepArchiveOpenStrippedContent !== seekdeepArchiveOpenRawContent &&
      await seekdeepHandleNaturalArchiveImageFollowup(message, seekdeepArchiveOpenStrippedContent)
    ) {
      return;
    }
  } catch (err) {
    console.error('Archive open message handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: typeof seekdeepBuildArchiveFailureText === 'function'
          ? seekdeepBuildArchiveFailureText(err, '')
          : 'Archive lookup failed. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }

  try {
    const seekdeepArchiveStatusRawContent = String(message?.content || '');
    if (await seekdeepHandleArchiveStatusMessage(message, seekdeepArchiveStatusRawContent)) {
      return;
    }
  } catch (err) {
    console.error('Archive status message handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: 'Archive status failed. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }

  const seekdeepMessageAddressesBot = typeof seekdeepMessageMentionsBot === 'function'
    ? seekdeepMessageMentionsBot(message)
    : Boolean(message.mentions?.has(client.user));

  if (!seekdeepMessageAddressesBot) {
    if (typeof seekdeepPeekPendingImageSubjectRequestV2 === 'function' && seekdeepPeekPendingImageSubjectRequestV2(message)) {
      const pendingPrompt = normalizeUserText(String(message.content || ''));
      const pendingKey = seekdeepMemoryKeyFromSafeV13(message);
      if (typeof seekdeepHandlePendingImageSubjectReplyV2 === 'function' && await seekdeepHandlePendingImageSubjectReplyV2(message, pendingPrompt, pendingKey)) {
        return;
      }
    }
    return;
  }

  const mentionCount = typeof seekdeepCountBotAddressingOccurrences === 'function'
    ? seekdeepCountBotAddressingOccurrences(message.content)
    : seekdeepCountBotMentionTags(message.content);
  let prompt = seekdeepNormalizeUserTextSafeV12(stripBotMentions(message.content));
  const seekdeepPromptBeforeReplyContext = prompt;

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
  // SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_START
  const seekdeepForceImageFromReplyContext = Boolean(
    seekdeepReplyPromptInfo?.usedReplyContext &&
    typeof seekdeepLooksLikeGenerateOnlyPrompt === 'function' &&
    seekdeepLooksLikeGenerateOnlyPrompt(seekdeepPromptBeforeReplyContext)
  );
  // SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_END

  if (seekdeepReplyPromptInfo.usedReplyContext) {

    console.log(`[SeekDeep] reply-context prompt used (${seekdeepReplyPromptInfo.replyContextMode || 'context'}):\n  reply: ${seekdeepReplyPromptInfo.replyContext}\n  final: ${prompt}`);

  }

  if (!prompt) {
    await message.reply({
      content: seekdeepAppendResponseFooter('No command text found after the bot mention. Try `@SeekDeep help`.', {
        startedAt: message?.__seekdeepRequestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (mentionCount > 1) {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await message.reply({
      content: seekdeepAppendResponseFooter(seekdeepMultipleCommandText(), {
        startedAt: message?.__seekdeepRequestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (!seekdeepClaimFinalReply('message-start', message?.id)) {
    console.warn(`Duplicate message handler path suppressed before generation: ${message?.id}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }

  if (!seekdeepIsPromptDedupeExempt(prompt) && !seekdeepClaimPromptOnce('message', message.author?.id || 'unknown', message.channel?.id || 'unknown', prompt || '(no-text)')) {
    console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }

  const typingLoop = startSeekDeepTypingLoop(message.channel, `message:${message.id}`);
  try {
    message.__seekdeepTypingLoop = typingLoop;
  } catch {}

  try {
    const key = seekdeepMemoryKeyFromSafeV13(message);

	    // SEEKDEEP_REPLY_TRANSLATE_ROUTE_START
	    if (seekdeepReplyPromptInfo?.replyTranslateRequested && seekdeepReplyPromptInfo.replyContext) {
      seekdeepLogRoute('reply-translate', prompt);
      const translatePrompt = [
        'Translate the following message to English.',
        'Return only the translation. Preserve slang/profanity plainly. Do not add commentary.',
        '',
        seekdeepReplyPromptInfo.replyContext,
      ].join('\n');

      const answer = await askChat(translatePrompt, {
        web: 'off',
        memoryKey: key,
        system: 'You are a direct translation engine. Translate to English only. No extra commentary.',
        maxNewTokens: 400,
        temperature: 0.1,
      });

      seekdeepRememberSafeV13(key, 'user', `[reply-translate] ${prompt}`);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
      await sendLongMessageReply(message, answer);
	      return;
	    }
	    // SEEKDEEP_REPLY_TRANSLATE_ROUTE_END

	    // SEEKDEEP_EXPLICIT_ASK_MESSAGE_ROUTE_START
	    const seekdeepAskMatch = String(prompt || '').match(/^ask\s+(.+)$/i);
	    if (seekdeepAskMatch && normalizeUserText(seekdeepAskMatch[1])) {
	      const askPrompt = normalizeUserText(seekdeepAskMatch[1]);
	      seekdeepLogRoute('chat-ask', askPrompt);
	      const answer = await askChat(askPrompt, { web: 'auto', memoryKey: key });
	      seekdeepRememberSafeV13(key, 'user', prompt);
	      seekdeepRememberSafeV13(key, 'assistant', answer);
	      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
	      await sendLongMessageReply(message, answer);
	      return;
	    }
	    // SEEKDEEP_EXPLICIT_ASK_MESSAGE_ROUTE_END

	    // SEEKDEEP_DIRECT_IMAGE_ALIAS_MESSAGE_ROUTE_START
    if (typeof seekdeepIsBareConfirmationPrompt === 'function' && seekdeepIsBareConfirmationPrompt(prompt)) {
      seekdeepLogRoute('bare-confirmation-local', prompt);
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', 'No pending confirmation command is active.');
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, ['No pending confirmation command is active.', '', 'Use a full command instead:', '@SeekDeep draw me <image idea>', '@SeekDeep generate <image idea>'].join('\n'));
      return;
    }

    const removedArchiveCommandText = typeof seekdeepRemovedArchiveCommandText === 'function'
      ? seekdeepRemovedArchiveCommandText(prompt)
      : '';
    if (removedArchiveCommandText) {
      seekdeepLogRoute('removed-archive-command', prompt);
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', removedArchiveCommandText);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, removedArchiveCommandText);
      return;
    }

    const seekdeepConversationalEditReplyImageContext =
      typeof seekdeepLooksLikeConversationalImageEditFollowup === 'function' &&
      seekdeepLooksLikeConversationalImageEditFollowup(prompt) &&
      typeof seekdeepGetGeneratedImageReplyContext === 'function'
        ? await seekdeepGetGeneratedImageReplyContext(message)
        : null;
    const seekdeepDirectImageAliasOptions = {
      allowConversationalEditImage: Boolean(seekdeepConversationalEditReplyImageContext),
    };

    if (typeof seekdeepIsDirectImageAliasPrompt === 'function' && seekdeepIsDirectImageAliasPrompt(prompt, seekdeepDirectImageAliasOptions)) {
      const seekdeepRouteCooldownRemaining = seekdeepImageCooldownRemaining(message.author?.id || message.author?.username || 'unknown');
      if (seekdeepRouteCooldownRemaining > 0) {
        seekdeepLogRoute('image-cooldown', prompt);
        await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);
        seekdeepStopTypingSafelyForMessage(message);
        return;
      }

      const seekdeepMessageImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      let imagePrompt = seekdeepConversationalEditReplyImageContext
        ? seekdeepBuildImagePromptFromReplyEdit(seekdeepConversationalEditReplyImageContext, prompt)
        : ((typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt);
      if (!seekdeepConversationalEditReplyImageContext && typeof seekdeepStripDirectImageVerb === 'function') imagePrompt = seekdeepStripDirectImageVerb(imagePrompt) || seekdeepStripDirectImageVerb(prompt) || imagePrompt;
      seekdeepLogRoute('image-direct-alias', imagePrompt);
      seekdeepRememberSafeV13(key, 'user', '[direct-image] ' + prompt);
      if (seekdeepShouldUsePromptChoicePreview(seekdeepMessageImageModeOptions)) {
        seekdeepRememberSafeV13(key, 'assistant', 'Prepared image prompt choices for: ' + imagePrompt);
        await seekdeepSendImagePromptChoiceMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
      } else {
        seekdeepRememberSafeV13(key, 'assistant', 'Queued image locally for: ' + imagePrompt);
        await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
      }
      return;
    }
    // SEEKDEEP_DIRECT_IMAGE_ALIAS_MESSAGE_ROUTE_END

    const utilityKind = seekdeepUtilityPromptKind(prompt);

    // SEEKDEEP_PENDING_IMAGE_SUBJECT_ROUTE_V2_START
    if (typeof seekdeepHandlePendingImageSubjectReplyV2 === 'function' && await seekdeepHandlePendingImageSubjectReplyV2(message, prompt, key)) {
      return;
    }

    if (typeof seekdeepHandleMissingImageSubjectCommandV2 === 'function' && await seekdeepHandleMissingImageSubjectCommandV2(message, prompt, key)) {
      return;
    }
    // SEEKDEEP_PENDING_IMAGE_SUBJECT_ROUTE_V2_END

    // Hard local commands always win before AI chat/image routing.
    if (isNaturalPongPrompt(prompt) || isExactPongTest(prompt)) {
      seekdeepLogRoute('pong', prompt);
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', 'pong');
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, 'pong');
      return;
    }

    if (utilityKind === 'post-archive') {
      seekdeepLogRoute('post-archive', prompt);
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', 'Posting archive.');
      await seekdeepPostArchiveFromMessage(message);
      return;
    }

    if (utilityKind === 'regenerate-image') {
      seekdeepLogRoute('regenerate-image', prompt);
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', 'Regenerating latest cached image.');
      await seekdeepRegenerateLatestImageFromMessage(message);
      return;
    }

    if (utilityKind === 'model-status') {
      seekdeepLogRoute('model-status', prompt);
      const status = await statusText();
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', status);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, asTextBlock(status));
      return;
    }

    if (utilityKind) {
      seekdeepLogRoute(utilityKind, prompt);
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());

      if (utilityKind === 'recent-images') {
        seekdeepRememberSafeV13(key, 'assistant', 'Posted recent images.');
        await seekdeepPostRecentImagesFromMessage(message, seekdeepRecentImagesRequestedLimit(prompt, 5, 10));
        return;
      }

      const content = seekdeepUtilityText(utilityKind, message, key);
      seekdeepRememberSafeV13(key, 'assistant', content);
      if (utilityKind === 'help') {
        await sendLongMessageReply(message, content);
      } else {
        await sendLongMessageReply(message, asTextBlock(content));
      }
      return;
    }

    // SEEKDEEP_COMMAND_SUGGESTION_ROUTE_V1_START
    const seekdeepSuggestedCommandText = typeof seekdeepCommandSuggestionText === 'function' ? seekdeepCommandSuggestionText(prompt) : '';
    if (seekdeepSuggestedCommandText) {
      seekdeepLogRoute('command-suggestion', prompt);
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', seekdeepSuggestedCommandText);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, asTextBlock(seekdeepSuggestedCommandText));
      return;
    }
    // SEEKDEEP_COMMAND_SUGGESTION_ROUTE_V1_END

    if (isNaturalStatusPrompt(prompt) || isExplicitStatusRequest(prompt)) {
      seekdeepLogRoute('status', prompt);
      const status = await statusText();
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', status);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, asTextBlock(status));
      return;
    }

    if (isBotIdentityQuestion(prompt)) {
      seekdeepLogRoute('identity', prompt);
      const answer = botIdentityAnswer(message.client?.user?.username || client.user?.username || 'SeekDeep');
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }

    const visionTarget = await resolveVisionAttachment(message);
    const shouldUseVision =
      !!visionTarget.attachment &&
      (
        visionTarget.origin === 'direct' ||
        !prompt ||
        isNaturalVisionPrompt(prompt)
      );

    if (shouldUseVision) {
      seekdeepLogRoute('vision', prompt);
      const rawPrompt = prompt || 'Describe this media clearly.';
      const answer = await askVision(visionTarget.attachment, seekdeepBuildPromptWithMemorySafeV14(rawPrompt, key));
      seekdeepRememberSafeV13(key, 'user', rawPrompt);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepVisionModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }

    // SEEKDEEP_REPLY_TRANSLATION_ROUTE_START
    if (seekdeepReplyPromptInfo?.replyContext && seekdeepIsReplyTranslationRequest(prompt)) {
      seekdeepLogRoute('reply-translate', prompt);
      const translationPrompt = [
        'Translate the following message to English.',
        'Return only the translation unless a note is necessary for slang or profanity.',
        '',
        seekdeepReplyPromptInfo.replyContext,
      ].join('\n');
      const answer = await askChat(translationPrompt, {
        web: 'off',
        memoryKey: key,
        temperature: 0.1,
        maxNewTokens: 500,
      });
      seekdeepRememberSafeV13(key, 'user', `[reply-translate] ${prompt}\n${seekdeepReplyPromptInfo.replyContext}`);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }
    // SEEKDEEP_REPLY_TRANSLATION_ROUTE_END

    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START
    const seekdeepRawImageRoutePrompt = typeof seekdeepStripCommandAddressingForRouting === 'function'
      ? seekdeepStripCommandAddressingForRouting(prompt)
      : seekdeepCleanMessageCommandPrompt(prompt);
    if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(seekdeepRawImageRoutePrompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(seekdeepRawImageRoutePrompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(seekdeepRawImageRoutePrompt)) || isNaturalImagePrompt(seekdeepRawImageRoutePrompt)))) {
    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_END
      if (seekdeepLooksLikeVisualRequest(seekdeepRawImageRoutePrompt)) seekdeepLogRoute('image-intent-rule', seekdeepRawImageRoutePrompt);
      const seekdeepRouteCooldownRemaining = seekdeepImageCooldownRemaining(message.author?.id || message.author?.username || 'unknown');
      if (seekdeepRouteCooldownRemaining > 0) {
        seekdeepLogRoute('image-cooldown', prompt);
        await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);
        seekdeepStopTypingSafelyForMessage(message);
        return;
      }

      const seekdeepMessageImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(seekdeepRawImageRoutePrompt)
        : { refine: true, ground: true, cleanPrompt: seekdeepRawImageRoutePrompt };
      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(seekdeepRawImageRoutePrompt) : seekdeepRawImageRoutePrompt) || seekdeepMessageImageModeOptions.cleanPrompt || seekdeepRawImageRoutePrompt;
      seekdeepLogRoute('image', imagePrompt);
      seekdeepRememberSafeV13(key, 'user', `[natural-image] ${seekdeepRawImageRoutePrompt}`);
      if (seekdeepShouldUsePromptChoicePreview(seekdeepMessageImageModeOptions)) {
        seekdeepRememberSafeV13(key, 'assistant', `Prepared image prompt choices for: ${imagePrompt}`);
        await seekdeepSendImagePromptChoiceMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
      } else {
        seekdeepRememberSafeV13(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
        await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
      }
      return;
    }

    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START
    if (await seekdeepHandleResearchTableMessage(message, prompt, key)) {
      return;
    }
    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_END

    // SEEKDEEP_PENDING_IMAGE_SUBJECT_REPLY_ROUTE_V1_START
    if (typeof seekdeepHandlePendingImageSubjectReply === 'function' && await seekdeepHandlePendingImageSubjectReply(message, prompt, key)) {
      return;
    }
    // SEEKDEEP_PENDING_IMAGE_SUBJECT_REPLY_ROUTE_V1_END

    seekdeepLogRoute('chat', prompt);
    const answer = await askChat(prompt, { web: 'auto', memoryKey: key });
    seekdeepRememberSafeV13(key, 'user', prompt);
    seekdeepRememberSafeV13(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
  } catch (err) {
    console.error(err);
    stopSeekDeepTypingLoopForMessage(message);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, `SeekDeep request failed.\n\nError:\n${err.message}`);
  }
});

// SEEKDEEP_SLASH_ROUTER_RESTORE_V1_START

// SEEKDEEP_SHARED_ARCHIVE_BUTTON_ACK_V4_START
// SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V6_START
const SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V6 = globalThis.__seekdeepSharedArchiveInteractionGuardV6 || new Map();
globalThis.__seekdeepSharedArchiveInteractionGuardV6 = SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V6;

function seekdeepSharedArchiveInteractionKeyV6(interaction) {
  return String(interaction?.id || interaction?.customId || '') + ':' + String(interaction?.user?.id || interaction?.member?.user?.id || 'unknown');
}

function seekdeepReserveSharedArchiveInteractionV6(interaction) {
  const key = seekdeepSharedArchiveInteractionKeyV6(interaction);
  if (!key || key === ':unknown') return true;
  const now = Date.now();
  const existing = SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V6.get(key);
  if (existing && Number(existing.expiresAt || 0) > now) return false;
  SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V6.set(key, { createdAt: now, expiresAt: now + 5 * 60 * 1000 });
  return true;
}

function seekdeepWasSharedArchiveInteractionReservedV6(interaction) {
  const key = seekdeepSharedArchiveInteractionKeyV6(interaction);
  const entry = key ? SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V6.get(key) : null;
  return Boolean(entry && Number(entry.expiresAt || 0) > Date.now());
}

function seekdeepSharedArchiveCountFromThreadNameV6(name = '') {
  const match = String(name || '').match(/(\d+)\s*$/u);
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
}

function seekdeepSharedArchiveFastNextCountV6(sharedArchive, thread, guildId = '') {
  const profile = guildId && typeof seekdeepSharedArchiveGetProfile === 'function'
    ? seekdeepSharedArchiveGetProfile(guildId)
    : {};
  const trusted = typeof seekdeepSharedArchiveTrustedCount === 'function'
    ? seekdeepSharedArchiveTrustedCount(profile)
    : Math.max(0, Number(profile?.count || 0) || 0);
  const archiveInfoCount = Math.max(0, Number(sharedArchive?.count || 0) || 0);
  const profileRaw = Math.max(0, Number(profile?.count || 0) || 0);
  const nameCount = seekdeepSharedArchiveCountFromThreadNameV6(thread?.name || sharedArchive?.threadName || profile?.threadName || '');
  return Math.max(trusted, archiveInfoCount, profileRaw, nameCount) + 1;
}

async function seekdeepSharedArchiveMaybeFastRenameV6(thread, count) {
  if (!thread) return '';
  const threadName = typeof seekdeepSharedArchiveThreadBuildName === 'function'
    ? seekdeepSharedArchiveThreadBuildName(count)
    : ('\u{1FA99} \u2022 Shared Archive \u2022 ' + String(count)).slice(0, 96);
  if (thread.name !== threadName) {
    if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, threadName);
    else if (typeof thread.setName === 'function') await thread.setName(threadName, 'SeekDeep shared archive count update').catch(() => null);
  }
  return threadName;
}
// SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V6_END

function seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(customId) {
  const id = String(customId || '').toLowerCase();
  if (!id) return false;
  if (id.includes('shared_archive')) return true;
  if (id.includes('archive_shared')) return true;
  if (id.includes('shared-archive')) return true;
  if (id.includes('archive-shared')) return true;
  if (id.includes('shared') && id.includes('archive')) return true;
  return false;
}

function seekdeepSharedArchiveActionIdFromCustomIdV7(customId = '') {
  const match = String(customId || '').trim().match(
    /^seekdeep:(?:image:)?(?:sharedarchive|shared-archive|shared_archive):(.+)$/i
  );
  return String(match?.[1] || '').trim();
}

function seekdeepSharedArchiveLoadImageStateFromInteractionV7(interaction) {
  const actionId = seekdeepSharedArchiveActionIdFromCustomIdV7(interaction?.customId || '');
  if (!actionId) return null;

  let state = null;
  try {
    state = seekdeepTempImageStateIndex?.get?.(actionId) || null;
  } catch {}

  if (!state && typeof seekdeepLoadTempImageState === 'function') {
    try {
      state = seekdeepLoadTempImageState(actionId);
    } catch (err) {
      console.warn('[SeekDeep] shared archive image state load failed:', err?.message || err);
    }
  }

  return state || null;
}

async function seekdeepSharedArchiveButtonAckV4(interaction) {
  if (!interaction || !interaction.isButton || !interaction.isButton()) return false;
  if (!seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(interaction.customId)) return false;

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
  } catch (ackErr) {
    if (seekdeepIsDiscordInteractionTerminalError(ackErr)) {
      console.warn('[SeekDeep] shared archive button defer skipped: interaction already closed.');
      return false;
    }
    console.error('[SeekDeep] shared archive button defer failed:', ackErr);
  }

  return true;
}

async function seekdeepSharedArchiveButtonRespondV4(interaction, content) {
  const payload = { content: String(content || '').slice(0, 1900), allowedMentions: { parse: [] } };
  try {
    if (interaction?.deferred) return await interaction.editReply(payload);
    if (interaction?.replied) return await interaction.followUp({ ...payload, ephemeral: true });
    return await interaction.reply({ ...payload, ephemeral: true });
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      console.warn('[SeekDeep] shared archive button response skipped: interaction already closed.');
      return null;
    }
    console.error('[SeekDeep] shared archive button response failed:', err);
    try { return await interaction.followUp({ ...payload, ephemeral: true }); } catch (followErr) {
      if (seekdeepIsDiscordInteractionTerminalError(followErr)) {
        console.warn('[SeekDeep] shared archive button followUp skipped: interaction already closed.');
        return null;
      }
    }
  }

  return null;
}

function seekdeepSharedArchiveExtractPromptFromMessageV4(message) {
  const content = String(message?.content || '').trim();
  if (!content) return 'unknown prompt';

  const generated = content.match(/Generated:\s*([^\n]+)/i);
  if (generated && generated[1]) return generated[1].trim();

  const original = content.match(/Original Prompt:\s*([^\n]+)/i);
  if (original && original[1]) return original[1].trim();

  const prompt = content.match(/Prompt:\s*([^\n]+)/i);
  if (prompt && prompt[1]) return prompt[1].trim();

  return content.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' / ').slice(0, 280) || 'unknown prompt';
}

function seekdeepSharedArchiveCollectImageFilesV4(message) {
  const files = [];
  const seen = new Set();

  for (const attachment of message?.attachments?.values?.() || []) {
    const url = String(attachment?.url || attachment?.proxyURL || '').trim();
    const name = String(attachment?.name || attachment?.filename || '').toLowerCase();
    const contentType = String(attachment?.contentType || '').toLowerCase();
    const looksImage = contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
    if (url && looksImage && !seen.has(url)) {
      seen.add(url);
      files.push({ attachment: url, name: attachment?.name || attachment?.filename || 'seekdeep-image.png' });
    }
  }

  for (const embed of message?.embeds || []) {
    const url = String(embed?.image?.url || embed?.thumbnail?.url || '').trim();
    if (url && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) && !seen.has(url)) {
      seen.add(url);
      files.push({ attachment: url, name: 'seekdeep-embed-image.png' });
    }
  }

  return files;
}

async function seekdeepSharedArchiveButtonManualArchiveV4(interaction) {
  const message = interaction?.message || null;
  const guild = interaction?.guild || message?.guild || interaction?.channel?.guild || null;
  if (!guild) {
    await seekdeepSharedArchiveButtonRespondV4(interaction, 'Shared Archive only works inside a server.');
    return true;
  }

  const cachedState = seekdeepSharedArchiveLoadImageStateFromInteractionV7(interaction);
  if (cachedState && typeof seekdeepArchiveImageStateToSharedDiscordThread === 'function') {
    const archiveResult = await seekdeepArchiveImageStateToSharedDiscordThread(cachedState, interaction);
    await seekdeepSharedArchiveButtonRespondV4(
      interaction,
      [
        'Archived to shared archive.',
        archiveResult?.threadId ? 'Thread: <#' + archiveResult.threadId + '>' : (archiveResult?.threadName ? 'Thread: ' + archiveResult.threadName : ''),
        archiveResult?.archiveCount !== undefined ? 'Shared archive count: ' + archiveResult.archiveCount : '',
        archiveResult?.postedImage ? 'Images: 1' : 'Image attachment unavailable; saved metadata only.',
      ].filter(Boolean).join('\n')
    );
    return true;
  }

  let sharedArchive;
  if (typeof seekdeepGetOrCreateSharedArchiveThread === 'function') {
    sharedArchive = await seekdeepGetOrCreateSharedArchiveThread(interaction);
  } else if (typeof seekdeepEnsureSharedArchiveThreadForChannel === 'function' && typeof seekdeepGetOrCreateGuildArchiveChannel === 'function') {
    const archiveChannel = await seekdeepGetOrCreateGuildArchiveChannel(interaction);
    sharedArchive = await seekdeepEnsureSharedArchiveThreadForChannel(archiveChannel, interaction, {
      source: 'shared-archive-button-count-finalize-v6',
      reason: 'SeekDeep shared archive button recovery',
    });
  } else {
    throw new Error('Shared Archive helper functions are missing. Re-run the Shared Archive setup/bootstrap patch.');
  }

  const thread = sharedArchive?.thread || sharedArchive;
  if (!thread || typeof thread.send !== 'function') {
    throw new Error('Shared Archive thread could not be resolved. Run @SeekDeep archive setup here and retry.');
  }

  if (thread.archived && typeof thread.setArchived === 'function') {
    await thread.setArchived(false, 'SeekDeep shared archive button recovery').catch(() => null);
  }

  const files = seekdeepSharedArchiveCollectImageFilesV4(message);
  if (!files.length) {
    await seekdeepSharedArchiveButtonRespondV4(interaction, 'Shared Archive could not find an image attachment on this Discord message. Nothing was archived.');
    return true;
  }

  const prompt = seekdeepSharedArchiveExtractPromptFromMessageV4(message);
  const requester = interaction?.user ? '<@' + interaction.user.id + '>' : 'unknown';
  const archivedAt = new Date().toISOString();
  const guildId = String(guild?.id || thread?.guild?.id || thread?.parent?.guild?.id || '').trim();
  const nextCount = seekdeepSharedArchiveFastNextCountV6(sharedArchive, thread, guildId);

  const entryContent = [
    'SeekDeep Shared Archive Entry',
    'Saved by: ' + requester,
    'Prompt: ' + prompt,
    'Images: ' + files.length,
    'Archived: ' + archivedAt,
  ].join('\n').slice(0, 1900);

  const sentManualArchiveMsg = await thread.send({
    content: entryContent,
    files,
    allowedMentions: { parse: [] },
  });
  await seekdeepAddArchiveEntryButtons(sentManualArchiveMsg);

  let finalCount = nextCount;
  let scanStats = null;
  try {
    if (typeof seekdeepScanThreadArchiveEntryStats === 'function') {
      scanStats = await seekdeepScanThreadArchiveEntryStats(thread, 'SeekDeep Shared Archive Entry');
      if (scanStats.ok && Number(scanStats.count || 0) > 0) {
        finalCount = Math.max(0, Number(scanStats.count || 0));
      } else if (!scanStats.ok) {
        console.warn('[SeekDeep] shared archive count recount failed:', scanStats.error || 'unknown scan failure');
      }
    }
  } catch (scanErr) {
    console.error('[SeekDeep] shared archive count recount failed:', scanErr);
  }

  let threadName = '';
  try {
    threadName = await seekdeepSharedArchiveMaybeFastRenameV6(thread, finalCount);
    if (guildId && typeof seekdeepSharedArchiveSaveProfile === 'function') {
      seekdeepSharedArchiveSaveProfile(guildId, {
        threadId: thread.id,
        threadName,
        count: finalCount,
        countSource: typeof SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE !== 'undefined' ? SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE : 'shared-archive-button-count-finalize-v6',
        lastArchivedAt: archivedAt,
        lastArchivedBy: interaction?.user?.id || '',
        lastArchiveSource: 'shared-archive-button-count-finalize-v6',
        lastCountScanAt: scanStats?.ok ? new Date().toISOString() : undefined,
        lastCountScanMessages: scanStats?.ok ? (Number(scanStats.scannedMessages || 0) || 0) : undefined,
        lastCountScanEntries: scanStats?.ok ? (Number(scanStats.count || 0) || 0) : undefined,
      });
    }
  } catch (countErr) {
    console.error('[SeekDeep] shared archive count/name update failed:', countErr);
  }

  await seekdeepSharedArchiveButtonRespondV4(
    interaction,
    'Archived to shared archive.\nThread: <#' + thread.id + '>\nShared archive count: ' + finalCount + '\nImages: ' + files.length
  );

  return true;
}

async function seekdeepHandleSharedArchiveButtonInteractionV4(interaction) {
  if (!interaction || !interaction.isButton || !interaction.isButton()) return false;
  if (!seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(interaction.customId)) return false;

  if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce('interaction:' + interaction.id)) {
    return true;
  }

  if (!seekdeepReserveSharedArchiveInteractionV6(interaction)) {
    console.log('[SeekDeep] shared-archive-button-v6 duplicate ignored customId=' + String(interaction.customId || ''));
    return true;
  }

  const start = Date.now();
  console.log('[SeekDeep] route=shared-archive-button-v6 customId=' + String(interaction.customId || ''));

  if (!(await seekdeepSharedArchiveButtonAckV4(interaction))) {
    return true;
  }

  await seekdeepSharedArchiveButtonRespondV4(
    interaction,
    'Shared Archive queued.\nQueue position: 1 of 1\nStatus: copying image into the shared archive thread...'
  );

  try {
    await seekdeepSharedArchiveButtonManualArchiveV4(interaction);
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      console.warn('[SeekDeep] shared archive button ended after interaction closed.');
      return true;
    }
    console.error('[SeekDeep] shared archive button failed:', err);
    const reason = String(err?.message || err || 'unknown error').slice(0, 1000);
    await seekdeepSharedArchiveButtonRespondV4(
      interaction,
      'Shared Archive failed after the button was acknowledged.\nReason: ' + reason + '\nRun @SeekDeep archive setup here, then retry. Check the console for [SeekDeep] shared archive button failed.'
    );
  } finally {
    console.log('[SeekDeep] shared-archive-button-v6 done in ' + (Date.now() - start) + 'ms');
  }

  return true;
}
// SEEKDEEP_SHARED_ARCHIVE_BUTTON_ACK_V4_END

async function seekdeepHandleArchiveDeleteButton(interaction) {
  if (!interaction?.isButton?.()) return false;
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:archivedelete:(\d+)$/);
  if (!match) return false;

  const targetMessageId = match[1];
  const thread = interaction.channel;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  if (!thread?.isThread?.()) {
    await interaction.editReply({ content: 'Delete from archive only works inside archive threads.' });
    return true;
  }

  try {
    const targetMessage = await thread.messages.fetch(targetMessageId);
    await targetMessage.delete();
  } catch (err) {
    await interaction.editReply({ content: 'Could not delete that archive entry: ' + (err?.message || 'unknown error') });
    return true;
  }

  const guildId = String(thread.guild?.id || '');
  const threadName = String(thread.name || '');
  const isShared = /Shared\s+Archive/i.test(threadName);

  if (isShared) {
    const scanStats = await seekdeepScanThreadArchiveEntryStats(thread, 'SeekDeep Shared Archive Entry');
    const newCount = scanStats.ok ? scanStats.count : 0;
    await seekdeepSharedArchiveMaybeFastRenameV6(thread, newCount);
    if (guildId && typeof seekdeepSharedArchiveSaveProfile === 'function') {
      seekdeepSharedArchiveSaveProfile(guildId, {
        threadId: thread.id,
        threadName: thread.name,
        count: newCount,
        countSource: typeof SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE !== 'undefined' ? SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE : 'seekdeep-shared-archive-posts-v1',
        lastCountScanAt: new Date().toISOString(),
        lastCountScanMessages: scanStats.scannedMessages || 0,
        lastCountScanEntries: newCount,
      });
    }
    await interaction.editReply({ content: 'Entry removed from shared archive. Count: ' + newCount });
  } else {
    const scan = await seekdeepArchiveThreadCountExistingEntries(thread);
    const newCount = scan.ok ? scan.count : 0;

    const config = seekdeepArchiveThreadReadConfig();
    const guildConfig = config?.guilds?.[guildId] || {};
    const userArchives = guildConfig?.userArchives || {};
    let matchedUserId = '';
    let matchedProfile = {};
    for (const [uid, profile] of Object.entries(userArchives)) {
      if (profile.threadId === thread.id) { matchedUserId = uid; matchedProfile = profile; break; }
    }
    if (matchedUserId) {
      seekdeepArchiveThreadSaveUserProfile(guildId, matchedUserId, {
        count: newCount,
        countSource: typeof SEEKDEEP_ARCHIVE_COUNT_SOURCE !== 'undefined' ? SEEKDEEP_ARCHIVE_COUNT_SOURCE : 'seekdeep-archive-posts-v3',
      });
      const subject = { displayName: matchedProfile.lastNickname || 'unknown' };
      const newName = seekdeepArchiveThreadBuildName(subject, newCount);
      await seekdeepMaybeRenameArchiveThread(thread, newName);
    }
    await interaction.editReply({ content: 'Entry removed from archive. Count: ' + newCount });
  }

  return true;
}

// SEEKDEEP_CONTEXT_MENU_HANDLERS_START
function seekdeepStripBotMentionsFromContextMessage(text = '') {
  return String(text || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/<@&\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepExtractContextMenuPromptText(targetMessage) {
  const content = String(targetMessage?.content || '').trim();
  const cleaned = seekdeepStripBotMentionsFromContextMessage(content);
  return cleaned;
}

async function seekdeepHandleMessageContextMenu(interaction) {
  const name = String(interaction.commandName || '').trim();
  const targetMessage = interaction.targetMessage || (interaction.targetId
    ? await interaction.channel?.messages?.fetch(interaction.targetId).catch(() => null)
    : null);

  if (!targetMessage) {
    await interaction.reply({
      content: 'Could not load the target message. Try again or use the slash command directly.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (name === 'Inspect (SeekDeep)') {
    return seekdeepHandleContextMenuInspect(interaction, targetMessage);
  }
  if (name === 'Generate Image from this') {
    return seekdeepHandleContextMenuGenerateImage(interaction, targetMessage);
  }
  if (name === 'Refine as Image Prompt') {
    return seekdeepHandleContextMenuRefine(interaction, targetMessage);
  }

  await interaction.reply({
    content: 'Unknown context menu command.',
    flags: MessageFlags.Ephemeral,
  });
}

async function seekdeepHandleContextMenuInspect(interaction, targetMessage) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const author = targetMessage.author;
  const ts = targetMessage.createdAt ? targetMessage.createdAt.toISOString() : 'unknown';
  const content = String(targetMessage.content || '');
  const cleanedContent = seekdeepStripBotMentionsFromContextMessage(content);

  const attachmentLines = [];
  for (const att of targetMessage.attachments?.values?.() || []) {
    const sizeKb = att?.size ? (Number(att.size) / 1024).toFixed(1) : '?';
    attachmentLines.push(`  - ${att?.name || '(unnamed)'} (${att?.contentType || 'unknown'}, ${sizeKb} KiB) ${att?.url || ''}`);
  }

  const embedLines = [];
  for (const embed of targetMessage.embeds || []) {
    embedLines.push(`  - type=${embed?.type || '?'} title=${(embed?.title || '').slice(0, 80)}`);
  }

  const componentSummary = [];
  for (const row of targetMessage.components || []) {
    for (const button of row?.components || []) {
      const cid = String(button?.customId || '');
      const label = String(button?.label || '');
      if (cid || label) componentSummary.push(`  - ${label || '(no label)'} customId=${cid || '(link button)'}`);
    }
  }

  // Try to recover SeekDeep image state if this message was generated by the bot.
  let seekdeepState = null;
  for (const row of targetMessage.components || []) {
    for (const button of row?.components || []) {
      const cid = String(button?.customId || '');
      const match = cid.match(/^seekdeep:(?:archive|sharedarchive|shared-archive|shared_archive|regen):(?:original:|refined:|both:)?(.+)$/i);
      if (match && match[1]) {
        const actionId = match[1];
        try {
          seekdeepState = seekdeepTempImageStateIndex?.get?.(actionId) || null;
        } catch {}
        if (!seekdeepState && typeof seekdeepLoadTempImageState === 'function') {
          try { seekdeepState = seekdeepLoadTempImageState(actionId); } catch {}
        }
        if (seekdeepState) seekdeepState.__actionId = actionId;
        break;
      }
    }
    if (seekdeepState) break;
  }

  const replyRef = targetMessage.reference?.messageId
    ? `${targetMessage.reference.guildId || '?'}/${targetMessage.reference.channelId || '?'}/${targetMessage.reference.messageId}`
    : 'none';

  const lines = [
    'SeekDeep Message Inspect',
    '',
    `Message ID: ${targetMessage.id}`,
    `Author: ${author?.tag || author?.username || 'unknown'} (${author?.id || '?'})${author?.bot ? ' [bot]' : ''}`,
    `Channel: ${targetMessage.channelId || '?'}`,
    `Timestamp: ${ts}`,
    `Content length: ${content.length} chars (${cleanedContent.length} after mention strip)`,
    `Reply to: ${replyRef}`,
    `Attachments: ${attachmentLines.length}`,
    ...attachmentLines,
    `Embeds: ${embedLines.length}`,
    ...embedLines,
    `Buttons / components: ${componentSummary.length}`,
    ...componentSummary,
  ];

  if (seekdeepState) {
    lines.push('', 'SeekDeep image state (cached):');
    if (seekdeepState.__actionId) lines.push(`  actionId: ${seekdeepState.__actionId}`);
    if (seekdeepState.prompt) lines.push(`  prompt: ${String(seekdeepState.prompt).slice(0, 240)}`);
    if (seekdeepState.refinedPrompt && seekdeepState.refinedPrompt !== seekdeepState.prompt) {
      lines.push(`  refinedPrompt: ${String(seekdeepState.refinedPrompt).slice(0, 240)}`);
    }
    if (seekdeepState.width && seekdeepState.height) {
      lines.push(`  size: ${seekdeepState.width}x${seekdeepState.height}`);
    }
    if (seekdeepState.seed !== undefined && seekdeepState.seed !== null) {
      lines.push(`  seed: ${seekdeepState.seed}`);
    }
    if (seekdeepState.jobId) lines.push(`  jobId: ${seekdeepState.jobId}`);
  }

  const body = lines.join('\n').slice(0, 1900);
  await interaction.editReply({ content: '```\n' + body + '\n```' });
}

async function seekdeepHandleContextMenuGenerateImage(interaction, targetMessage) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const prompt = seekdeepExtractContextMenuPromptText(targetMessage);
  if (!prompt) {
    await interaction.editReply({
      content: 'That message has no text I can use as an image prompt (only attachments/embeds). Pick a message with text.',
    });
    return;
  }

  if (typeof seekdeepIsFrustrationPrompt === 'function' && seekdeepIsFrustrationPrompt(prompt)) {
    await interaction.editReply({
      content: 'That message looks like frustration/curse text, not a prompt. Pick a message with the actual visual subject.',
    });
    return;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('context-menu-generate-image', prompt);
  }

  await interaction.editReply({
    content: 'Queued: original (no refinement)\nPrompt: ' + prompt.slice(0, 1500),
  });

  // Build a proxy message so we can reuse seekdeepSendImageWithButtonsMessage exactly
  // like the regular natural-language path. The proxy replies into the original channel.
  const proxy = {
    author: { id: interaction.user?.id || 'unknown' },
    channel: interaction.channel || null,
    guild: interaction.guild || null,
    client: interaction.client || client,
    id: `ctx:${interaction.id}`,
    content: prompt,
    reply: async (payload) => {
      if (interaction.channel && typeof interaction.channel.send === 'function') {
        return await interaction.channel.send(payload);
      }
      return null;
    },
  };

  try {
    await seekdeepSendImageWithButtonsMessage(proxy, prompt, 1024, 1024, null, {
      refine: false,
      ground: true,
      cleanPrompt: prompt,
      skipCooldown: false,
      silentAck: true,
    });
  } catch (err) {
    console.error('Context menu Generate Image failed:', err?.stack || err?.message || err);
    try {
      await interaction.followUp({
        content: 'Image generation failed: ' + (err?.message || 'unknown error').slice(0, 500),
        flags: MessageFlags.Ephemeral,
      });
    } catch {}
  }
}

async function seekdeepHandleContextMenuRefine(interaction, targetMessage) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const prompt = seekdeepExtractContextMenuPromptText(targetMessage);
  if (!prompt) {
    await interaction.editReply({
      content: 'That message has no text I can refine.',
    });
    return;
  }

  // Apply the same image-intent gate as /refine so we don't waste a chat call on
  // non-image text and produce something like "dogwater".
  const looksLikeImagePrompt =
    (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(prompt)) ||
    (typeof seekdeepHasExplicitImageRequest === 'function' && seekdeepHasExplicitImageRequest(prompt)) ||
    (typeof seekdeepHasVisualSubjectWords === 'function' && seekdeepHasVisualSubjectWords(prompt)) ||
    (typeof seekdeepHasVisualStyleWords === 'function' && seekdeepHasVisualStyleWords(prompt));
  const looksLikeFrustration = typeof seekdeepIsFrustrationPrompt === 'function' && seekdeepIsFrustrationPrompt(prompt);

  if (looksLikeFrustration || !looksLikeImagePrompt) {
    await interaction.editReply({
      content: looksLikeFrustration
        ? 'That message looks like frustration, not an image prompt.'
        : 'That message doesn\'t look like an image prompt. Refine is for visual subjects (e.g. "a red glass apple on a wooden table, cinematic lighting"). Use Inspect or Generate Image from this if you want different behavior.',
    });
    return;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('context-menu-refine', prompt);
  }

  const key = typeof seekdeepMemoryKeyFromSafeV13 === 'function' ? seekdeepMemoryKeyFromSafeV13(interaction) : null;
  const refineInput = buildRefineUserPrompt(prompt, key);
  const maxNewTokens = maxTokensForRefine(prompt);
  const temperature = Number(process.env.REFINE_TEMPERATURE || 0.72);

  let answer = await askChat(refineInput, {
    web: 'off',
    system: REFINE_SYSTEM_PROMPT,
    maxNewTokens,
    temperature,
    memoryKey: null,
  });
  answer = cleanupRefinedPrompt(answer);

  if (hasRefineRepetitionIssue(answer)) {
    answer = await askChat([refineInput, '', 'The previous draft repeated itself. Regenerate once. Every sentence must add new information.'].join('\n'), {
      web: 'off',
      system: REFINE_SYSTEM_PROMPT,
      maxNewTokens,
      temperature: Math.max(temperature, 0.8),
      memoryKey: null,
    });
    answer = cleanupRefinedPrompt(answer);
  }

  const body = ('Refined prompt:\n' + answer).slice(0, 1900);
  await interaction.editReply({ content: body });
}
// SEEKDEEP_CONTEXT_MENU_HANDLERS_END

client.on('interactionCreate', async (interaction) => {
  if (typeof seekdeepHandleSharedArchiveButtonInteractionV4 === 'function' && await seekdeepHandleSharedArchiveButtonInteractionV4(interaction)) return;

  // Right-click message context menu commands. Dispatch before the chat-input
  // gate so these don't fall through to slash-command logic.
  try {
    if (interaction?.isMessageContextMenuCommand && interaction.isMessageContextMenuCommand()) {
      if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce(`interaction:${interaction.id}`)) {
        console.warn(`Duplicate Discord interaction suppressed: ${interaction.id}`);
        return;
      }
      await seekdeepHandleMessageContextMenu(interaction);
      return;
    }
  } catch (err) {
    console.error('Context menu interaction failed:', err?.stack || err?.message || err);
    try {
      const payload = { content: 'Context menu command failed: ' + (err?.message || 'unknown error'), flags: MessageFlags.Ephemeral };
      if (interaction?.deferred || interaction?.replied) await interaction.editReply(payload);
      else await interaction.reply(payload);
    } catch {}
    return;
  }

  try {
    if (!(interaction?.isChatInputCommand && interaction.isChatInputCommand())) return;

    if (typeof seekdeepMarkRequestStart === 'function') {
      seekdeepMarkRequestStart(interaction);
    }

    if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce(`interaction:${interaction.id}`)) {
      console.warn(`Duplicate Discord interaction suppressed: ${interaction.id}`);
      return;
    }

    const commandName = String(interaction.commandName || '').toLowerCase();

    if (['help', 'cachestatus', 'archivestatus', 'recent'].includes(commandName)) {
      if (!(await safeDefer(interaction))) return;
      const key = seekdeepMemoryKeyFromSafeV13(interaction);
      let kind = commandName;

      if (commandName === 'cachestatus') kind = 'cache';
      if (commandName === 'archivestatus') kind = 'archive';
      if (commandName === 'recent') {
        const requested = interaction.options.getString('kind') || 'images';
        kind = requested === 'prompts' ? 'recent-prompts' : 'recent-images';
      }

      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());

      if (kind === 'recent-images') {
        await seekdeepPostRecentImagesFromInteraction(interaction, 5);
        return;
      }

      if (kind === 'archive' && typeof seekdeepBuildArchiveStatusReportV2 === 'function') {
        const content = await seekdeepBuildArchiveStatusReportV2(interaction);
        await sendLongInteractionReply(interaction, asTextBlock(content));
        return;
      }

      const content = seekdeepUtilityText(kind, interaction, key);
      await sendLongInteractionReply(interaction, asTextBlock(content));
      return;
    }

    if (commandName === 'postarchive') {
      if (!(await safeDefer(interaction))) return;
      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
      await seekdeepPostArchiveFromInteraction(interaction);
      return;
    }

    if (commandName === 'status') {
      if (!(await safeDefer(interaction))) return;
      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
      await sendLongInteractionReply(interaction, asTextBlock(await statusText()));
      return;
    }

    if (commandName === 'ask') {
      if (!(await safeDefer(interaction))) return;
      const prompt = normalizeUserText(interaction.options.getString('prompt', true));
      const web = interaction.options.getString('web') || 'auto';
      const key = seekdeepMemoryKeyFromSafeV13(interaction);
      const answer = await askChat(prompt, { web, memoryKey: key });
      seekdeepSetResponseModel(interaction, seekdeepChatModelLabel());
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      await sendLongInteractionReply(interaction, answer);
      return;
    }

    if (commandName === 'refine') {
      if (!(await safeDefer(interaction))) return;

      const prompt = normalizeUserText(interaction.options.getString('prompt', true));
      const key = seekdeepMemoryKeyFromSafeV13(interaction);

      // /refine is for image prompts. If the input doesn't look like an image prompt
      // (no visual intent, no subject), refuse with guidance so we don't waste a chat
      // call producing nonsense ("dogwater") on chat/frustration input.
      const looksLikeImagePrompt =
        (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(prompt)) ||
        (typeof seekdeepHasExplicitImageRequest === 'function' && seekdeepHasExplicitImageRequest(prompt)) ||
        (typeof seekdeepHasVisualSubjectWords === 'function' && seekdeepHasVisualSubjectWords(prompt)) ||
        (typeof seekdeepHasVisualStyleWords === 'function' && seekdeepHasVisualStyleWords(prompt));
      const looksLikeFrustration =
        typeof seekdeepIsFrustrationPrompt === 'function' && seekdeepIsFrustrationPrompt(prompt);

      if (looksLikeFrustration || !looksLikeImagePrompt) {
        const guidance = looksLikeFrustration
          ? 'That looks like frustration, not an image prompt. Send the actual visual subject you want refined, like "a red glass apple on a wooden table".'
          : [
              "`/refine` is for rewriting image prompts. The input doesn't look like an image subject.",
              'Try something like: `/refine prompt:a red glass apple on a wooden table, cinematic lighting`.',
              'For chat or questions use `/ask` instead.',
            ].join('\n');

        seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
        await sendLongInteractionReply(interaction, guidance);
        return;
      }

      const refineInput = buildRefineUserPrompt(prompt, key);
      const web = refineExplicitlyRequestsWeb(prompt) ? 'always' : 'off';
      const maxNewTokens = maxTokensForRefine(prompt);
      const temperature = Number(process.env.REFINE_TEMPERATURE || 0.72);

      let answer = await askChat(refineInput, {
        web,
        system: REFINE_SYSTEM_PROMPT,
        maxNewTokens,
        temperature,
        memoryKey: null,
      });

      answer = cleanupRefinedPrompt(answer);

      if (hasRefineRepetitionIssue(answer)) {
        const retryInput = [
          refineInput,
          '',
          'The previous draft repeated itself. Regenerate once. Every sentence must add new information. Do not reuse paragraph structures or repeated filler phrasing.',
        ].join('\n');

        answer = await askChat(retryInput, {
          web: 'off',
          system: REFINE_SYSTEM_PROMPT,
          maxNewTokens,
          temperature: Math.max(temperature, 0.8),
          memoryKey: null,
        });

        answer = cleanupRefinedPrompt(answer);
      }

      seekdeepSetResponseModel(interaction, seekdeepChatModelLabel());
      seekdeepRememberSafeV13(key, 'user', prompt);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      await sendLongInteractionReply(interaction, answer);
      return;
    }

    if (commandName === 'image') {
      if (!(await safeDefer(interaction))) return;
      const prompt = normalizeUserText(interaction.options.getString('prompt', true));
      const key = seekdeepMemoryKeyFromSafeV13(interaction);
      const width = interaction.options.getInteger('width') || 1024;
      const height = interaction.options.getInteger('height') || 1024;
      const seed = interaction.options.getInteger('seed');
      const seekdeepImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const cleanImagePrompt = seekdeepImageModeOptions.cleanPrompt || prompt;

      seekdeepRememberSafeV13(key, 'user', `/image ${prompt}`);

      if (seekdeepShouldUsePromptChoicePreview(seekdeepImageModeOptions)) {
        seekdeepRememberSafeV13(key, 'assistant', `Prepared image prompt choices for: ${cleanImagePrompt}`);
        await seekdeepSendImagePromptChoiceInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
      } else {
        seekdeepRememberSafeV13(key, 'assistant', `Generated image locally for: ${cleanImagePrompt}`);
        await seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
      }
      return;
    }

    if (commandName === 'vision') {
      if (!(await safeDefer(interaction))) return;
      const attachment = interaction.options.getAttachment('file', true);
      const prompt = normalizeUserText(interaction.options.getString('prompt') || 'Describe this media clearly.');
      const key = seekdeepMemoryKeyFromSafeV13(interaction);
      const answer = await askVision(attachment, seekdeepBuildPromptWithMemorySafeV14(prompt, key));
      seekdeepSetResponseModel(interaction, seekdeepVisionModelLabel());
      seekdeepRememberSafeV13(key, 'user', `/vision ${prompt}`);
      seekdeepRememberSafeV13(key, 'assistant', answer);
      await sendLongInteractionReply(interaction, answer);
      return;
    }
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      console.warn('Slash interaction closed before completion.');
      return;
    }
    console.error(err);
    try {
      const configuredChatModel = process.env.LOCAL_CHAT_MODEL_ID || 'Qwen/Qwen3-8B';
      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
      await sendLongInteractionReply(interaction, [
        'SeekDeep request failed.',
        '',
        'Configured chat provider: Local NVIDIA model server',
        `Configured chat model: ${configuredChatModel}`,
        '',
        'Error:',
        err?.message || String(err),
      ].join('\n'));
    } catch (replyErr) {
      console.error('Slash command failure notice also failed:', replyErr?.message || replyErr);
    }
  }
});
// SEEKDEEP_SLASH_ROUTER_RESTORE_V1_END

client.login(TOKEN);

// SEEKDEEP_PROMPT_CHOICE_EMERGENCY_START
const SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN = globalThis.__SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN || new Set();
globalThis.__SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN = SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN;

async function seekdeepEmergencyHandlePromptChoiceButton(interaction) {
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:prompt:(original|refined|both):(.+)$/);
  if (!match) return false;

  
  // SEEKDEEP_PROMPT_CHOICE_GLOBAL_CLAIM_V1
  if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce(`interaction:${interaction.id}`)) {
    return true;
  }
if (interaction?.id && SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN.has(interaction.id)) {
    return true;
  }
  if (interaction?.id) {
    SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN.add(interaction.id);
    setTimeout(() => {
      try { SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN.delete(interaction.id); } catch {}
    }, 300000).unref?.();
  }

  const action = match[1];
  const id = match[2];
  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      return true;
    }
    console.warn('Emergency prompt-choice deferUpdate failed:', err?.message || err);
  }

  if (typeof seekdeepSweepPendingImagePrompts === 'function') {
    try { seekdeepSweepPendingImagePrompts(); } catch {}
  }

  const pendingMap = globalThis.SEEKDEEP_PENDING_IMAGE_PROMPTS || SEEKDEEP_PENDING_IMAGE_PROMPTS;
  const state = pendingMap?.get?.(id) || null;

  const editChoiceMessage = async (payload) => {
    try {
      if (interaction?.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit(payload);
        return true;
      }
    } catch (err) {
      console.warn('Emergency prompt-choice message edit failed:', err?.message || err);
    }

    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(payload);
        return true;
      }
    } catch (err) {
      console.warn('Emergency prompt-choice editReply fallback failed:', err?.message || err);
    }

    return false;
  };

  const privateNotice = async (content) => {
    try {
      await interaction.followUp(seekdeepEphemeralPayload({ content }));
    } catch (err) {
      console.warn('Emergency prompt-choice followUp failed:', err?.message || err);
    }
  };

  if (!state) {
    const expiredText = [
      'Prompt choice expired before a version was selected.',
      'Run the image request again to reopen Original / Refined / Both.',
    ].join('\n');

    await editChoiceMessage({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(expiredText, {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          })
        : expiredText,
      components: [],
    });

    return true;
  }

  if (state.requesterId && interaction?.user?.id !== state.requesterId) {
    await privateNotice('Only the requester can use these image prompt buttons.');
    return true;
  }

  const basePrompt = state.originalPrompt || state.rawPrompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const groundingOn = state.ground !== false;
  const groundingLine = groundingOn ? 'Grounding: on' : 'Grounding: off';

  const needsOriginal = (action === 'original' || action === 'both') && !state.originalQueued;
  const needsRefined = (action === 'refined' || action === 'both') && !state.refinedQueued;

  if (!needsOriginal && !needsRefined) {
    await privateNotice('That version has already been queued for this prompt.');
    return true;
  }

  state.originalQueued = Boolean(state.originalQueued || needsOriginal);
  state.refinedQueued = Boolean(state.refinedQueued || needsRefined);
  state.lastSelectedAt = Date.now();
  pendingMap.set(id, state);

  const allQueued = Boolean(state.originalQueued && state.refinedQueued);
  if (allQueued) {
    try { pendingMap.delete(id); } catch {}
  }

  const selectionSummary = [
    needsOriginal && needsRefined ? 'Queued both:' : needsOriginal ? 'Queued original.' : 'Queued refined.',
    needsOriginal && needsRefined ? '- Original' : '',
    needsOriginal && needsRefined ? '- Refined' : '',
    '',
    groundingLine,
    needsOriginal && !needsRefined ? 'Refinement: off' : '',
    needsRefined && !needsOriginal ? 'Refinement: on' : '',
    `Queued Jobs: ${[needsOriginal, needsRefined].filter(Boolean).length}`,
    '',
    allQueued ? 'Both versions have now been queued.' : 'You can still choose the remaining version from this prompt.',
  ].filter(Boolean).join('\n');

  const choiceRow = !allQueued && typeof seekdeepPendingPromptChoiceRow === 'function'
    ? [seekdeepPendingPromptChoiceRow(id, state)]
    : [];

  await editChoiceMessage({
    content: typeof seekdeepAppendResponseFooter === 'function'
      ? seekdeepAppendResponseFooter(selectionSummary, {
          startedAt,
          modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
        })
      : selectionSummary,
    components: choiceRow,
  });

  const runQueuedSelection = async (messageProxy, selectionPrompt, selectionOptions, routeName) => {
    try {
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute(routeName, selectionPrompt);
      }

      await seekdeepSendImageWithButtonsMessage(
        messageProxy,
        selectionPrompt,
        width,
        height,
        seed,
        selectionOptions,
      );
    } catch (err) {
      console.warn(`Emergency prompt-choice generation failed (${routeName}):`, err?.stack || err?.message || err);
    }
  };

  if (needsOriginal) {
    const originalProxy = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'original')
      : {
          author: { id: state.requesterId || interaction?.user?.id || 'unknown' },
          channel: interaction?.channel || null,
          id: `${interaction?.id || 'prompt'}:original:${Date.now()}`,
          reply: async () => null,
        };

    void runQueuedSelection(
      originalProxy,
      basePrompt,
      {
        refine: false,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-original'
    );
  }

  if (needsRefined) {
    const refinedProxy = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'refined')
      : {
          author: { id: state.requesterId || interaction?.user?.id || 'unknown' },
          channel: interaction?.channel || null,
          id: `${interaction?.id || 'prompt'}:refined:${Date.now()}`,
          reply: async () => null,
        };

    const refinedPrompt = normalizeUserText(state.refinedPrompt || basePrompt).trim() || basePrompt;
    void runQueuedSelection(
      refinedProxy,
      basePrompt,
      {
        refine: true,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        preRefinedPrompt: refinedPrompt,
        dynamicRefinement: Boolean(state.dynamicRefinement),
        dynamicRefinementAttempted: Boolean(state.dynamicRefinementAttempted || state.dynamicRefinement),
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-refined'
    );
  }

  return true;
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!(interaction?.isButton && interaction.isButton())) return;
    const customId = String(interaction?.customId || '');
    if (!customId.startsWith('seekdeep:prompt:')) return;
    await seekdeepEmergencyHandlePromptChoiceButton(interaction);
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      console.warn('Emergency prompt-choice listener closed before completion.');
      return;
    }
    console.error('Emergency prompt-choice listener failed:', err);
    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(`Image button failed.\n\nError:\n${err?.message || err}`);
      } else {
        await interaction.reply(seekdeepEphemeralPayload({
          content: `Image button failed.\n\nError:\n${err?.message || err}`,
        }));
      }
    } catch {}
  }
});
// SEEKDEEP_PROMPT_CHOICE_EMERGENCY_END

// SEEKDEEP_IMAGE_ACTION_EMERGENCY_START
const SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN = globalThis.__SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN || new Set();
globalThis.__SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN = SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN;

function seekdeepEmergencyIsGeneratedImageActionCustomId(customId = '') {
  const value = String(customId || '').trim();
  if (typeof seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4 === 'function' && seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(value)) {
    return false;
  }

  return (
    /^seekdeep:regen:(original|refined|both):(.+)$/i.test(value) ||
    /^seekdeep:(regenerate|download|archive|save):(.+)$/i.test(value) ||
    /^seekdeep:image:(regen|archive|save):(.+)$/i.test(value)
  );
}

async function seekdeepEmergencyHandleGeneratedImageButton(interaction) {
  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();
  const customId = String(interaction?.customId || '').trim();

  if (!seekdeepEmergencyIsGeneratedImageActionCustomId(customId)) {
    return false;
  }

  
  // SEEKDEEP_IMAGE_ACTION_GLOBAL_CLAIM_V1
  if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce(`interaction:${interaction.id}`)) {
    return true;
  }
if (interaction?.id && SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN.has(interaction.id)) {
    return true;
  }
  if (interaction?.id) {
    SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN.add(interaction.id);
    setTimeout(() => {
      try { SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN.delete(interaction.id); } catch {}
    }, 300000).unref?.();
  }

  try {
    if (!interaction?.deferred && !interaction?.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      return true;
    }
    console.warn('Emergency generated-image button deferReply failed:', err?.message || err);
  }

  try {
    if (/^seekdeep:(?:image:)?(?:regen|regenerate)(?::|$)/i.test(customId)) {
      const regenUserId = typeof seekdeepRegenerateCooldownUserId === 'function'
        ? seekdeepRegenerateCooldownUserId(interaction)
        : (interaction?.user?.id || 'unknown');
      const remaining = typeof seekdeepImageCooldownRemaining === 'function'
        ? seekdeepImageCooldownRemaining(regenUserId)
        : 0;

      if (remaining > 0) {
        if (typeof seekdeepLogRoute === 'function') {
          seekdeepLogRoute('regenerate-cooldown', 'button-regenerate');
        }

        if (typeof seekdeepSendRegenerateCooldownNotice === 'function') {
          await seekdeepSendRegenerateCooldownNotice(interaction, remaining);
        } else {
          const payload = {
            content: typeof seekdeepAppendResponseFooter === 'function'
              ? seekdeepAppendResponseFooter(
                  typeof seekdeepImageCooldownText === 'function' ? seekdeepImageCooldownText(remaining) : `Image generation cooldown is active. Try again in ${remaining.toFixed ? remaining.toFixed(1) : remaining} seconds.`,
                  {
                    startedAt,
                    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
                  }
                )
              : `Image generation cooldown is active. Try again in ${remaining} seconds.`,
          };

          if (interaction?.replied || interaction?.deferred) {
            await interaction.editReply(payload);
          } else {
            await interaction.reply(seekdeepEphemeralPayload(payload));
          }
        }
        return true;
      }
    }
  } catch (err) {
    console.warn('Emergency regenerate cooldown check failed:', err?.message || err);
  }

  const parsed =
    customId.match(/^seekdeep:regen:(original|refined|both):(.+)$/i) ||
    customId.match(/^seekdeep:(regenerate|download|archive|sharedarchive|shared-archive|shared_archive|save):(.+)$/i) ||
    customId.match(/^seekdeep:image:(regen|archive|sharedarchive|shared-archive|shared_archive|save):(.+)$/i);

  if (!parsed) {
    return false;
  }

  let action = '';
  let mode = 'submitted';
  let actionId = '';

  if (/^seekdeep:regen:/i.test(customId)) {
    action = 'regenerate';
    mode = String(parsed[1] || 'submitted').toLowerCase();
    actionId = parsed[2] || '';
  } else if (/^seekdeep:image:/i.test(customId)) {
    action = parsed[1] === 'regen' ? 'regenerate' : (parsed[1] === 'save' ? 'archive' : parsed[1]);
    actionId = parsed[2] || '';
  } else {
    action = parsed[1] === 'save' ? 'archive' : parsed[1];
    actionId = parsed[2] || '';
  }

  // SEEKDEEP_SHARED_ARCHIVE_ACTION_NORMALIZE
  action = String(action || '').toLowerCase();
  if (action === 'save') action = 'archive';
  if (/^shared[-_]?archive$/i.test(action)) action = 'sharedarchive';

  let state = seekdeepTempImageStateIndex?.get?.(actionId) || null;
  if (!state && typeof seekdeepLoadTempImageState === 'function') {
    state = seekdeepLoadTempImageState(actionId);
  }

  if (!state) {
    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(
            'That image action expired from the temporary cache. Generate it again if you still want to use its buttons.',
            {
              startedAt,
              modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
            }
          )
        : 'That image action expired from the temporary cache. Generate it again if you still want to use its buttons.',
    });
    return true;
  }
  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_START
  if (action === 'sharedarchive') {
    try {
      const archiveResult = typeof seekdeepArchiveImageStateToSharedDiscordThread === 'function'
        ? await seekdeepArchiveImageStateToSharedDiscordThread(state, interaction)
        : null;
      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              [
                'Archived to shared archive.',
                archiveResult?.threadId ? 'Thread: <#' + archiveResult.threadId + '>' : (archiveResult?.threadName ? 'Thread: ' + archiveResult.threadName : ''),
              ].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Archived to shared archive.',
      });
      return true;
    } catch (err) {
      const reason = String(err?.message || err || 'unknown error').slice(0, 1000);
      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              ['Shared archive failed.', reason ? 'Reason: ' + reason : ''].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Shared archive failed.',
      });
      return true;
    }
  }
  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_END

  if (action === 'archive') {
    try {
      const archiveResult = typeof seekdeepArchiveImageStateToDiscordThread === 'function'
        ? await seekdeepArchiveImageStateToDiscordThread(state, interaction)
        : null;

      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              [
                'Archived to this server.',
                archiveResult?.threadName ? `Thread: ${archiveResult.threadName}` : '',
              ].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Archived to this server.',
      });
      return true;
    } catch (err) {
      if (err?.code === 'SEEKDEEP_ARCHIVE_NOT_CONFIGURED' || err?.code === 'SEEKDEEP_ARCHIVE_PERMISSIONS_MISSING') {
        const setupText = String(err?.message || 'Archive channel is not ready for this server.').slice(0, 1800);
        await interaction.editReply({
          content: typeof seekdeepAppendResponseFooter === 'function'
            ? seekdeepAppendResponseFooter(setupText, {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              })
            : setupText,
        });
        return true;
      }
      console.warn('Emergency Discord thread archive failed:', err?.message || err);

      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              [
                'Discord thread archive failed.',
                err?.message ? `Reason: ${String(err.message).slice(0, 500)}` : '',
              ].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Discord thread archive failed.',
      });
      return true;
    }
  }

  if (action === 'download') {
    const downloadText = state?.downloadUrl || state?.url || state?.proxyURL || state?.attachmentUrl
      ? `Download URL:\n${state.downloadUrl || state.url || state.proxyURL || state.attachmentUrl}`
      : 'Use the image attachment in the channel to download this image.';

    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(downloadText, {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          })
        : downloadText,
    });
    return true;
  }

  if (action !== 'regenerate') {
    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter('Unknown image action.', {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          })
        : 'Unknown image action.',
    });
    return true;
  }

  const basePrompt = state.originalPrompt || state.rawPrompt || state.prompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const grounded = state.ground !== false && state.imageModeOptions?.ground !== false;

  const queueOne = async (regenMode, routeName, suffix) => {
    const proxy = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', suffix)
      : {
          author: { id: interaction?.user?.id || 'unknown' },
          channel: interaction?.channel || null,
          id: `${interaction?.id || 'regen'}:${suffix}:${Date.now().toString(36)}`,
          reply: async (payload) => {
            if (interaction?.channel && typeof interaction.channel.send === 'function') {
              return await interaction.channel.send(payload);
            }
            return null;
          },
        };

    if (typeof seekdeepLogRoute === 'function') {
      seekdeepLogRoute(routeName, basePrompt);
    }

    const modeOptions = typeof seekdeepRegenerateModeOptions === 'function'
      ? seekdeepRegenerateModeOptions(regenMode, {
          ...state,
          originalPrompt: basePrompt,
          ground: grounded,
        })
      : {
          ...(state?.imageModeOptions || {}),
          refine: regenMode !== 'original',
          ground: grounded,
          cleanPrompt: basePrompt,
          skipCooldown: true,
        };

    return await seekdeepSendImageWithButtonsMessage(
      proxy,
      basePrompt,
      width,
      height,
      seed,
      modeOptions,
    );
  };

  if (mode === 'both') {
    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(
            [
              'Queued both regenerate versions.',
              '',
              grounded ? 'Grounding: on' : 'Grounding: off',
              'Jobs queued:',
              '- Original prompt',
              '- Refined prompt',
            ].join('\n'),
            {
              startedAt,
              modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
            }
          )
        : 'Queued both regenerate versions.',
    });

    void queueOne('original', 'image-choice-original', 'regen-original');
    void queueOne('refined', 'image-choice-refined', 'regen-refined');
    return true;
  }

  const responseMode = String(mode || 'submitted').toLowerCase();
  const resolvedMode = responseMode === 'original' || responseMode === 'raw'
    ? 'original'
    : responseMode === 'refined'
      ? 'refined'
      : ((state.refine === false || state.imageModeOptions?.refine === false) ? 'original' : 'refined');

  await interaction.editReply({
    content: typeof seekdeepAppendResponseFooter === 'function'
      ? seekdeepAppendResponseFooter(
          [
            resolvedMode === 'original' ? 'Queued original regenerate.' : 'Queued refined regenerate.',
            '',
            grounded ? 'Grounding: on' : 'Grounding: off',
            resolvedMode === 'original' ? 'Refinement: off' : 'Refinement: on',
            'Queued Jobs: 1',
          ].join('\n'),
          {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          }
        )
      : 'Queued regenerate.',
  });

  void queueOne(
    resolvedMode,
    resolvedMode === 'original' ? 'image-choice-original' : 'image-choice-refined',
    `regen-${resolvedMode}`
  );
  return true;
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!(interaction?.isButton && interaction.isButton())) return;
    const customId = String(interaction?.customId || '');
    if (!seekdeepEmergencyIsGeneratedImageActionCustomId(customId)) return;
    await seekdeepEmergencyHandleGeneratedImageButton(interaction);
  } catch (err) {
    if (seekdeepIsDiscordInteractionTerminalError(err)) {
      console.warn('Emergency generated-image listener closed before completion.');
      return;
    }
    console.error('Emergency generated-image button listener failed:', err);
    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(`Image button failed.\n\nError:\n${err?.message || err}`);
      } else {
        await interaction.reply(seekdeepEphemeralPayload({
          content: `Image button failed.\n\nError:\n${err?.message || err}`,
        }));
      }
    } catch {}
  }
});
// SEEKDEEP_IMAGE_ACTION_EMERGENCY_END

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction?.isButton?.()) return;
    if (!String(interaction?.customId || '').startsWith('seekdeep:archivedelete:')) return;
    await seekdeepHandleArchiveDeleteButton(interaction);
  } catch (err) {
    console.error('[SeekDeep] archive delete button failed:', err);
    try {
      const payload = { content: 'Failed to delete archive entry: ' + (err?.message || 'unknown error') };
      if (interaction?.deferred || interaction?.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, ephemeral: true });
    } catch {}
  }
});
