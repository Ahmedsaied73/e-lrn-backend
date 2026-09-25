'use strict';

/**
 * conversationService.js — the persistence boundary for agent conversations.
 *
 * Every read and write of a transcript goes through here because two rules are
 * easy to get wrong when Prisma calls are sprinkled through the graph:
 *
 *  OWNERSHIP  a conversationId is never trusted on its own. The row's adminId is
 *             compared to the caller's, and every follow-up query repeats the
 *             admin predicate, so a stale or forged id cannot reach another
 *             admin's transcript.
 *  PAYLOAD    transcript reads return only the columns a UI may render. toolArgs,
 *             toolResult and metadata are operational internals; turn metadata
 *             additionally travels through a whitelist so a tool payload can
 *             never be smuggled into the stored history.
 *
 * Everything returned is plain JSON (Dates become ISO strings) because callers
 * feed these shapes straight into HTTP responses and model contexts.
 */

const ROLES = Object.freeze({
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
  TOOL_CALL: 'TOOL_CALL',
  TOOL_RESULT: 'TOOL_RESULT',
  ERROR: 'ERROR',
});

const ROLE_VALUES = Object.freeze(Object.values(ROLES));

/** Roles whose meaning is their text; the others are defined by their tool fields. */
const TEXT_ROLES = new Set([ROLES.USER, ROLES.ASSISTANT]);

const DEFAULT_TITLE = 'محادثة جديدة';
const TITLE_MAX_CHARS = 80;

const LIST_TAKE_DEFAULT = 30;
const LIST_TAKE_MIN = 1;
const LIST_TAKE_MAX = 50;

const MESSAGES_TAKE_DEFAULT = 50;
const MESSAGES_TAKE_MIN = 1;
const MESSAGES_TAKE_MAX = 100;

const METADATA_STRING_MAX = 96;
const TOOL_CALLS_MAX = 20;

// Arabic counts as letters, so a question made only of digits, punctuation or
// emoji is "no letters" and falls back to DEFAULT_TITLE. A Unicode property escape
// keeps that correct for any script instead of hand-listing character ranges.
const LETTER = /\p{L}/u;

/** Typed failure; `code` is what the HTTP layer and the graph map to behaviour. */
class AgentConversationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentConversationError';
    this.code = code;
  }
}

/**
 * The label for a conversation: first line only, whitespace collapsed, cut at 80
 * characters with no ellipsis, so the stored value is exactly a prefix of what the
 * admin typed.
 */
function buildTitle(text) {
  if (typeof text !== 'string') return DEFAULT_TITLE;

  const firstLine = text.split(/\r?\n/, 1)[0];
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (!LETTER.test(collapsed)) return DEFAULT_TITLE;

  // Cut by code point: slice() could split a surrogate pair and store half of it.
  return Array.from(collapsed).slice(0, TITLE_MAX_CHARS).join('');
}

/** Dates cross this boundary as ISO strings (a mock or caller may already hand one over). */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return value === undefined ? null : value;
}

function assertAdminId(adminId) {
  if (!Number.isSafeInteger(adminId) || adminId <= 0) {
    throw new AgentConversationError('INVALID_INPUT', 'adminId must be a positive integer');
  }
}

function assertConversationId(conversationId) {
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
    throw new AgentConversationError('INVALID_INPUT', 'conversationId must be a positive integer');
  }
}

/** Requested page size, forced into [min, max]; anything unusable falls back. */
function clampTake(take, fallback, min, max) {
  const n = Number(take);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * The single ownership gate. It looks the row up by id — not by { id, adminId } —
 * on purpose: a filtered query returns null for both "no such conversation" and
 * "not yours", and callers must be able to tell those apart (404 vs 403). Nothing
 * from a non-owned row ever leaves this function; it throws instead.
 */
async function requireOwnedConversation(prisma, adminId, conversationId) {
  assertAdminId(adminId);
  assertConversationId(conversationId);

  const conversation = await prisma.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, adminId: true, title: true, createdAt: true, updatedAt: true },
  });

  if (!conversation) {
    throw new AgentConversationError('NOT_FOUND', `conversation ${conversationId} does not exist`);
  }
  if (conversation.adminId !== adminId) {
    throw new AgentConversationError('NOT_OWNED', `conversation ${conversationId} belongs to another admin`);
  }

  return conversation;
}

function normalizeContent(role, content) {
  if (TEXT_ROLES.has(role)) {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new AgentConversationError('EMPTY_MESSAGE', `a ${role} message requires non-empty content`);
    }
    return content;
  }
  // TOOL_CALL / TOOL_RESULT / ERROR carry tool fields, so text is optional there.
  if (content === undefined || content === null) return null;
  if (typeof content !== 'string') {
    throw new AgentConversationError('INVALID_INPUT', `content of a ${role} message must be a string`);
  }
  return content;
}

function normalizeToolName(toolName) {
  if (typeof toolName !== 'string') return null;
  return toolName.trim() === '' ? null : toolName;
}

/**
 * Builds the row for one message; shared by appendMessage and recordTurn so both
 * public paths write identical rows. Role and text are validated here, i.e. before
 * the insert, and toolArgs/toolResult are stored exactly as handed over: callers
 * already cap them, and truncating again here would silently hide that a payload
 * was huge.
 */
function buildMessageData({ conversationId, role, content, toolName, toolArgs, toolResult, metadata }) {
  if (!ROLE_VALUES.includes(role)) {
    throw new AgentConversationError('INVALID_INPUT', `unknown message role "${String(role)}"`);
  }

  const data = {
    conversationId,
    role,
    content: normalizeContent(role, content),
  };

  const name = normalizeToolName(toolName);
  if (name !== null) data.toolName = name;
  if (toolArgs !== undefined) data.toolArgs = toolArgs;
  if (toolResult !== undefined) data.toolResult = toolResult;
  if (metadata !== undefined && metadata !== null) data.metadata = metadata;

  return data;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Tool names only: a bare count collapses to a number, anything richer is dropped. */
function sanitizeToolCalls(toolCalls) {
  if (typeof toolCalls === 'number') {
    return Number.isFinite(toolCalls) && toolCalls >= 0 ? Math.trunc(toolCalls) : undefined;
  }
  if (!Array.isArray(toolCalls)) return undefined;

  const names = [];
  for (const entry of toolCalls.slice(0, TOOL_CALLS_MAX)) {
    if (typeof entry === 'string' && entry.trim() !== '') names.push(entry.slice(0, METADATA_STRING_MAX));
    else if (entry && typeof entry.name === 'string' && entry.name.trim() !== '') {
      names.push(entry.name.slice(0, METADATA_STRING_MAX));
    }
  }
  return names;
}

/**
 * recordTurn's metadata lands in the transcript, so it is rebuilt key by key from
 * the whitelist of operational facts instead of being forwarded. Tool payloads
 * (args, results, row samples) must never be copied in: the assistant message
 * already carries the rendered answer, and internals belong to the tool rows.
 */
function sanitizeTurnMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;

  const safe = {};
  if (isNonEmptyString(metadata.provider)) safe.provider = metadata.provider.slice(0, METADATA_STRING_MAX);
  if (isNonEmptyString(metadata.model)) safe.model = metadata.model.slice(0, METADATA_STRING_MAX);
  if (Number.isFinite(metadata.latencyMs) && metadata.latencyMs >= 0) {
    safe.latencyMs = Math.trunc(metadata.latencyMs);
  }

  const toolCalls = sanitizeToolCalls(metadata.toolCalls);
  // Checked against undefined explicitly: toolCalls: 0 is a fact ("no tool ran"),
  // and a falsy check would silently drop it.
  if (toolCalls !== undefined) safe.toolCalls = toolCalls;

  if (metadata.deterministic !== undefined && metadata.deterministic !== null) {
    safe.deterministic = Boolean(metadata.deterministic);
  }
  if (metadata.llm !== undefined && metadata.llm !== null) safe.llm = Boolean(metadata.llm);

  // An empty object would claim "something was recorded"; undefined stores null.
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/**
 * Resolves the conversation a turn belongs to. A supplied id is verified, never
 * trusted; without one a fresh conversation starts untitled (the first question
 * names it through recordTurn).
 *
 * @returns {Promise<{ id: number, title: string|null, createdAt: string, updatedAt: string }>}
 */
async function getOrCreateConversation({ prisma, adminId, conversationId } = {}) {
  assertAdminId(adminId);

  if (conversationId !== undefined && conversationId !== null) {
    const conversation = await requireOwnedConversation(prisma, adminId, conversationId);
    return {
      id: conversation.id,
      title: conversation.title ?? null,
      createdAt: toIso(conversation.createdAt),
      updatedAt: toIso(conversation.updatedAt),
    };
  }

  const created = await prisma.agentConversation.create({
    data: { adminId, title: null },
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });

  return {
    id: created.id,
    title: created.title ?? null,
    createdAt: toIso(created.createdAt),
    updatedAt: toIso(created.updatedAt),
  };
}

/**
 * Appends one row to a transcript. Ownership is checked before anything is written,
 * so a wrong id never reaches the insert.
 *
 * @returns {Promise<{ id: number, role: string, createdAt: string }>}
 */
async function appendMessage({
  prisma,
  adminId,
  conversationId,
  role,
  content,
  toolName,
  toolArgs,
  toolResult,
  metadata,
} = {}) {
  assertAdminId(adminId);
  assertConversationId(conversationId);

  await requireOwnedConversation(prisma, adminId, conversationId);

  const data = buildMessageData({ conversationId, role, content, toolName, toolArgs, toolResult, metadata });
  const created = await prisma.agentMessage.create({ data });

  return {
    id: created.id,
    role: created.role === undefined || created.role === null ? data.role : created.role,
    createdAt: toIso(created.createdAt),
  };
}

/**
 * One question/answer pair. The two rows are written in order and the title is set
 * last, from the first question only: a conversation that already has a title keeps
 * it, so a later question cannot rename the sidebar entry.
 *
 * The writes are sequential rather than wrapped in $transaction: messages are
 * append-only and the caller owns retry policy, while the title lives on the
 * conversation row and stays consistent either way.
 *
 * @returns {Promise<{ conversationId: number, title: string, userMessageId: number, assistantMessageId: number }>}
 */
async function recordTurn({ prisma, adminId, conversationId, question, answer, metadata } = {}) {
  const conversation = await requireOwnedConversation(prisma, adminId, conversationId);

  const userMessage = await prisma.agentMessage.create({
    data: buildMessageData({ conversationId, role: ROLES.USER, content: question }),
  });

  const assistantMessage = await prisma.agentMessage.create({
    data: buildMessageData({
      conversationId,
      role: ROLES.ASSISTANT,
      content: answer,
      metadata: sanitizeTurnMetadata(metadata),
    }),
  });

  const existing = typeof conversation.title === 'string' ? conversation.title.trim() : '';
  let title = existing === '' ? null : conversation.title;
  if (title === null) {
    title = buildTitle(question);
    // updateMany instead of update: Prisma accepts a unique WHERE only on update,
    // so this is the form that keeps the admin predicate inside the statement. It
    // also bumps updatedAt, which is what the conversation list is ordered by.
    await prisma.agentConversation.updateMany({ where: { id: conversationId, adminId }, data: { title } });
  }

  return {
    conversationId,
    title,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  };
}

/**
 * Sidebar list, newest activity first. The counted relation plus a single newest
 * message row answers "when did this last change" — no message body is ever loaded
 * for a list view.
 *
 * @returns {Promise<Array<{ id: number, title: string|null, updatedAt: string, lastMessageAt: string|null, messageCount: number }>>}
 */
async function listConversations({ prisma, adminId, take = LIST_TAKE_DEFAULT } = {}) {
  assertAdminId(adminId);
  const size = clampTake(take, LIST_TAKE_DEFAULT, LIST_TAKE_MIN, LIST_TAKE_MAX);

  const conversations = await prisma.agentConversation.findMany({
    where: { adminId },
    orderBy: { updatedAt: 'desc' },
    take: size,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { messages: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
    },
  });

  return conversations.map((row) => {
    const newest = Array.isArray(row.messages) && row.messages.length > 0 ? row.messages[0] : null;
    return {
      id: row.id,
      title: row.title ?? null,
      updatedAt: toIso(row.updatedAt),
      lastMessageAt: newest ? toIso(newest.createdAt) : null,
      messageCount: row._count && typeof row._count.messages === 'number' ? row._count.messages : 0,
    };
  });
}

/**
 * Transcript, oldest first, capped at 100 rows. The select is deliberately narrow:
 * toolArgs, toolResult and metadata are operational internals that the chat UI must
 * never render, so they are not fetched in the first place.
 *
 * @returns {Promise<Array<{ id: number, role: string, content: string|null, toolName: string|null, createdAt: string }>>}
 */
async function getMessages({ prisma, adminId, conversationId, take = MESSAGES_TAKE_DEFAULT } = {}) {
  await requireOwnedConversation(prisma, adminId, conversationId);
  const size = clampTake(take, MESSAGES_TAKE_DEFAULT, MESSAGES_TAKE_MIN, MESSAGES_TAKE_MAX);

  const messages = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: size,
    select: { id: true, role: true, content: true, toolName: true, createdAt: true },
  });

  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content ?? null,
    toolName: message.toolName ?? null,
    createdAt: toIso(message.createdAt),
  }));
}

module.exports = {
  AgentConversationError,
  buildTitle,
  getOrCreateConversation,
  appendMessage,
  recordTurn,
  listConversations,
  getMessages,
};
