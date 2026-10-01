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

// ── Phase 9 (conversation features) ───────────────────────────────────────────
// Search: a 1-character query matches almost every message and is not a search, so
// the floor is 2. The ceiling is a guard against a client pasting a whole document
// into a `contains`, which would scan forever for a match that cannot exist.
const SEARCH_QUERY_MIN = 2;
const SEARCH_QUERY_MAX = 100;
const SEARCH_TAKE_DEFAULT = 20;
const SEARCH_TAKE_MIN = 1;
const SEARCH_TAKE_MAX = 50;

/** Chars of context returned per hit. Enough to place the match, not the message. */
const SNIPPET_MAX = 120;
/** How much text precedes the match inside the snippet. */
const SNIPPET_LEAD = 40;

/**
 * A renamed title is the admin's own words, so it gets a wider budget than an
 * auto-derived one (TITLE_MAX_CHARS = 80, a prefix of the first question). Both are
 * single-line values; 120 is the ceiling the route validates against.
 */
const TITLE_INPUT_MIN = 1;
const TITLE_INPUT_MAX = 120;

/**
 * The regenerate/edit cap. Same number the /ask route enforces, restated here because
 * regenerate rewrites a stored question and must not be able to widen it.
 */
const QUESTION_MAX = 2000;

const METADATA_STRING_MAX = 96;
const TOOL_CALLS_MAX = 20;
// Phase 4: the grounding check no longer discards an answer — it names the figures
// it could not trace, and those names are stored on the turn. Same doctrine as the
// other metadata caps: keep the fact, drop the volume.
const UNVERIFIED_FIGURES_MAX = 20;
const UNVERIFIED_FIGURE_MAX = 32;

// Cap on one prune statement. Conversations are small (a transcript, not a blob),
// so a few hundred per tick is plenty to keep up with organic growth while keeping
// the DELETE's lock footprint bounded.
const MAX_PRUNE_BATCH = 200;

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

  // Phase 4: the advisory grounding check's findings. Sanitized like tool names —
  // a short list of short figure strings, or nothing at all — because the stored
  // metadata answers "was this turn flagged?" without smuggling answer content
  // into the transcript.
  if (Array.isArray(metadata.unverifiedFigures)) {
    const figures = [];
    for (const figure of metadata.unverifiedFigures.slice(0, UNVERIFIED_FIGURES_MAX)) {
      const text = typeof figure === 'string' ? figure : figure !== null && figure !== undefined ? String(figure) : '';
      if (text.trim() !== '') figures.push(text.slice(0, UNVERIFIED_FIGURE_MAX));
      if (figures.length >= UNVERIFIED_FIGURES_MAX) break;
    }
    if (figures.length > 0) safe.unverifiedFigures = figures;
  }

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
      // `adminId` is returned so a caller that already passed the ownership gate can
      // hand the row straight back to recordTurn() as `validated` and save a second
      // round trip — the check is then done against the row in hand, not a fresh read.
      adminId: conversation.adminId,
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
    adminId,
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
 * The FIRST turn of a conversation — the row and its two messages in ONE round trip.
 *
 * WHY THIS EXISTS (measured): a new conversation used to cost 4–5 sequential round
 * trips (create the row, then re-read it, then insert the question, then the answer,
 * then set the title). One round trip to this deployment's database pooler is ~355ms,
 * so that sequence alone was ~2.2s of a ~2.6s request. The fix is not a faster
 * database, it is writing the whole turn as one statement.
 *
 * It also removes a class of bug rather than just latency: the conversation row is
 * created TOGETHER WITH the turn that gives it meaning, so a turn that never
 * produces an answer (grounding failure, provider outage) can no longer leave a
 * message-less row in the admin's sidebar. In one diagnostic session 25 of 70 rows
 * were exactly that: titless, empty, and impossible to explain to an admin.
 *
 * The admin predicate is carried by the parent create, so a nested write can never
 * attach a transcript to somebody else's account.
 *
 * @returns {Promise<{ id: number, title: string, createdAt: string, updatedAt: string, userMessageId: number, assistantMessageId: number }>}
 */
async function createConversationWithTurn({ prisma, adminId, question, answer, metadata } = {}) {
  assertAdminId(adminId);

  const userRow = buildMessageData({ role: ROLES.USER, content: question });
  const assistantRow = buildMessageData({
    role: ROLES.ASSISTANT,
    content: answer,
    metadata: sanitizeTurnMetadata(metadata),
  });
  // A NESTED create must not carry a conversationId: the parent supplies it, and
  // setting it here would be a second, contradictory owner of the same rows.
  delete userRow.conversationId;
  delete assistantRow.conversationId;

  const created = await prisma.agentConversation.create({
    data: {
      adminId,
      // The title comes from the first question and is written once, here — there is
      // no later "fix the title" update to make, so the row is never briefly wrong.
      title: buildTitle(question),
      messages: { create: [userRow, assistantRow] },
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      messages: { select: { id: true, role: true } },
    },
  });

  const messages = Array.isArray(created.messages) ? created.messages : [];
  const userMessageId = (messages.find((m) => m.role === ROLES.USER) || {}).id || null;
  const assistantMessageId = (messages.find((m) => m.role === ROLES.ASSISTANT) || {}).id || null;

  return {
    id: created.id,
    title: created.title ?? null,
    createdAt: toIso(created.createdAt),
    updatedAt: toIso(created.updatedAt),
    userMessageId,
    assistantMessageId,
  };
}

/**
 * A follow-up turn inside an existing conversation.
 *
 * The title is set from the first question only: a conversation that already has a
 * title keeps it, so a later question can never rename the sidebar entry.
 *
 * ROUND-TRIP BUDGET: 2 — or 1 when the caller passes `validated` (see below).
 * One read for ownership, then ONE batched transaction for the two inserts and the
 * conditional title update — Prisma sends an array of operations as a single request,
 * so this costs what one insert used to. It is also atomic: the pre-4.5 sequential
 * version could leave a question with no answer (or a title with no question) if the
 * process died mid-turn, and the REST contract promises that an ok:true turn is
 * immediately readable as ['USER','ASSISTANT']. Do not "optimise" this back into
 * separate awaits.
 *
 * `validated` is the row THIS request already read through the ownership gate. It
 * saves one round trip on a follow-up turn (measured: ~355ms of a ~1.7s turn), and it
 * does NOT skip the check: the row in hand is still matched against the id and the
 * admin, so a caller cannot use it to write into somebody else's transcript. Every
 * caller that does not have a validated row — including every direct caller and test —
 * still pays the full read.
 *
 * @returns {Promise<{ conversationId: number, title: string, userMessageId: number, assistantMessageId: number }>}
 */
async function recordTurn({ prisma, adminId, conversationId, question, answer, metadata, validated = null } = {}) {
  let conversation = validated;
  if (conversation) {
    // Same refusal the read path would produce, without the read: a row that is not
    // this conversation, or not this admin's, is treated as not owned.
    if (conversation.id !== conversationId || conversation.adminId !== adminId) {
      throw new AgentConversationError('NOT_OWNED', `conversation ${conversationId} belongs to another admin`);
    }
  } else {
    conversation = await requireOwnedConversation(prisma, adminId, conversationId);
  }

  const userRow = buildMessageData({ conversationId, role: ROLES.USER, content: question });
  const assistantRow = buildMessageData({
    conversationId,
    role: ROLES.ASSISTANT,
    content: answer,
    metadata: sanitizeTurnMetadata(metadata),
  });

  const existing = typeof conversation.title === 'string' ? conversation.title.trim() : '';
  const needsTitle = existing === '';
  const title = needsTitle ? buildTitle(question) : conversation.title;

  const operations = [
    prisma.agentMessage.create({ data: userRow }),
    prisma.agentMessage.create({ data: assistantRow }),
    // ALWAYS touch the conversation row, not just when the title is first derived.
    // `updatedAt` is what retention ages on and what the sidebar orders by, and
    // Prisma's @updatedAt only fires when the row is actually written. Previously
    // this ran only on the first turn, so a conversation's updatedAt froze at that
    // moment: a transcript in daily use would eventually be pruned as "expired"
    // while its owner was still talking to it, and it would sort as stale in the
    // sidebar. `title` is already the correct final value in both branches, so
    // re-asserting it is idempotent — and it rides the existing $transaction, so
    // this costs no extra round trip.
    prisma.agentConversation.updateMany({ where: { id: conversationId, adminId }, data: { title } }),
  ];

  const [userMessage, assistantMessage] = await prisma.$transaction(operations);

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

/** Collapse whitespace and cut at a code-point boundary (never split a surrogate). */
function toSnippet(content) {
  return Array.from(String(content == null ? '' : content).replace(/\s+/g, ' ').trim());
}

/**
 * A short window of the message AROUND the match, so the admin can tell two hits
 * apart. Returns code points, not UTF-16 units — Arabic and emoji are both multi-unit
 * and a naive slice would emit half a character.
 */
function buildSnippet(content, query) {
  const chars = toSnippet(content);
  const flat = chars.join('');
  const at = flat.toLowerCase().indexOf(String(query).toLowerCase());
  if (at < 0) return chars.slice(0, SNIPPET_MAX).join('');

  const codePointIndex = Array.from(flat.slice(0, at)).length;
  const start = Math.max(0, codePointIndex - SNIPPET_LEAD);
  return chars.slice(start, start + SNIPPET_MAX).join('');
}

/**
 * Search this admin's conversations over their MESSAGE text (Phase 9, §9.1).
 *
 * Scoping is by the owning conversation's adminId, applied INSIDE the query — a
 * post-filter would still have read another admin's rows into the process, and the
 * whole point of the ownership doctrine in this file is that they never get that far.
 *
 * Pagination is by message id (newest first) rather than an offset: a new turn
 * arriving between two requests cannot make the second page skip or repeat a hit, and
 * `id` is already the unique, monotonic column the index gives us. No new index is
 * added in this phase — one admin, a 30-day window, and a `contains` over a few
 * thousand short rows is a plain scan the planner handles; see PHASE_9_REPORT §4.
 *
 * @returns {Promise<{ rows: Array<object>, nextCursor: number|null, truncated: boolean }>}
 */
async function searchConversations({ prisma, adminId, q, take = SEARCH_TAKE_DEFAULT, cursor = null } = {}) {
  assertAdminId(adminId);

  const query = typeof q === 'string' ? q.trim() : '';
  const length = Array.from(query).length;
  if (length < SEARCH_QUERY_MIN || length > SEARCH_QUERY_MAX) {
    throw new AgentConversationError(
      'INVALID_QUERY',
      `q must be between ${SEARCH_QUERY_MIN} and ${SEARCH_QUERY_MAX} characters`
    );
  }

  const size = clampTake(take, SEARCH_TAKE_DEFAULT, SEARCH_TAKE_MIN, SEARCH_TAKE_MAX);
  const cursorId = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;

  // take + 1 is what makes `truncated` provable instead of a guess.
  const messages = await prisma.agentMessage.findMany({
    where: {
      content: { contains: query, mode: 'insensitive' },
      conversation: { adminId },
      ...(cursorId === null ? {} : { id: { lt: cursorId } }),
    },
    orderBy: { id: 'desc' },
    take: size + 1,
    select: {
      id: true,
      content: true,
      conversationId: true,
      createdAt: true,
      conversation: { select: { id: true, title: true, updatedAt: true } },
    },
  });

  const truncated = messages.length > size;
  const page = truncated ? messages.slice(0, size) : messages;

  return {
    rows: page.map((message) => ({
      conversationId: message.conversationId,
      title: message.conversation ? message.conversation.title ?? null : null,
      messageId: message.id,
      snippet: buildSnippet(message.content, query),
      matchedAt: toIso(message.createdAt),
      updatedAt: message.conversation ? toIso(message.conversation.updatedAt) : null,
    })),
    nextCursor: truncated && page.length > 0 ? page[page.length - 1].id : null,
    truncated,
  };
}

/**
 * Rename a conversation (Phase 9, §9.1). Ownership first, so a foreign id is a
 * NOT_FOUND from requireOwnedConversation — never a 403 and never a silent no-op.
 */
async function renameConversation({ prisma, adminId, conversationId, title } = {}) {
  await requireOwnedConversation(prisma, adminId, conversationId);

  const value = typeof title === 'string' ? title.trim() : '';
  const length = Array.from(value).length;
  if (length < TITLE_INPUT_MIN || length > TITLE_INPUT_MAX) {
    throw new AgentConversationError(
      'INVALID_TITLE',
      `title must be between ${TITLE_INPUT_MIN} and ${TITLE_INPUT_MAX} characters`
    );
  }

  const updated = await prisma.agentConversation.update({
    where: { id: conversationId },
    data: { title: value },
    select: { id: true, title: true, updatedAt: true },
  });

  return { id: updated.id, title: updated.title, updatedAt: toIso(updated.updatedAt) };
}

/**
 * Delete a conversation and its transcript (Phase 9, §9.1).
 *
 * The memories learned in it SURVIVE by construction: `AgentMemory.sourceConversation`
 * is `onDelete: SetNull`, so the fact stays and only its provenance is cleared. That
 * is deliberate — deleting a chat must not silently un-teach the agent something the
 * admin confirmed.
 */
async function deleteConversation({ prisma, adminId, conversationId } = {}) {
  await requireOwnedConversation(prisma, adminId, conversationId);

  // AgentMessage and AgentApproval both cascade from the parent, so this one
  // statement removes the transcript and any bound confirmation rows with it.
  await prisma.agentConversation.delete({ where: { id: conversationId } });

  return { id: conversationId, deleted: true };
}

/**
 * Rewind a conversation to its last question, optionally replacing that question's
 * text (Phase 9, §9.1 — the transactional half of regenerate/edit).
 *
 * Returns the question to re-run; the CALLER then drives `answerQuestion` so a
 * regenerated turn goes through the normal path (limits, budget, guard, audit, memory)
 * rather than a parallel implementation of it.
 *
 * One transaction, in this order, because each step invalidates the next if done out
 * of order:
 *   1. find the last USER message — no USER message means there is nothing to
 *      regenerate, which is a typed refusal rather than an empty re-run;
 *   2. optionally rewrite that message's text, validated against the same 2000-char
 *      cap the /ask route applies, so editing cannot widen the question;
 *   3. drop everything AFTER it — by id, which is monotonic, so the drop set is
 *      exactly "the answer being regenerated";
 *   4. expire the PENDING confirmation tokens that belonged to the dropped turn.
 *      This is the security-relevant step: a preview issued by the answer we just
 *      deleted must not stay spendable, or a regenerated turn could inherit a live
 *      token for a destructive action the admin never re-confirmed.
 */
async function rewindToLastUserMessage({ prisma, adminId, conversationId, content = null } = {}) {
  await requireOwnedConversation(prisma, adminId, conversationId);

  return prisma.$transaction(async (tx) => {
    const lastUser = await tx.agentMessage.findFirst({
      where: { conversationId, role: ROLES.USER },
      orderBy: { id: 'desc' },
      select: { id: true, content: true, createdAt: true },
    });
    if (!lastUser) {
      throw new AgentConversationError('NO_USER_MESSAGE', 'this conversation has no question to regenerate');
    }

    let question = lastUser.content;
    if (content !== null && content !== undefined) {
      const next = typeof content === 'string' ? content.trim() : '';
      if (next === '') {
        throw new AgentConversationError('EMPTY_MESSAGE', 'a regenerated question cannot be empty');
      }
      if (Array.from(next).length > QUESTION_MAX) {
        throw new AgentConversationError('INVALID_INPUT', `question is too long (max ${QUESTION_MAX} characters)`);
      }
      await tx.agentMessage.update({ where: { id: lastUser.id }, data: { content: next } });
      question = next;
    }

    const dropped = await tx.agentMessage.deleteMany({
      where: { conversationId, id: { gt: lastUser.id } },
    });

    const expired = await tx.agentApproval.updateMany({
      where: { conversationId, status: 'PENDING', requestedAt: { gte: lastUser.createdAt } },
      data: { status: 'EXPIRED', decidedAt: new Date() },
    });

    return {
      conversationId,
      question,
      userMessageId: lastUser.id,
      droppedMessages: dropped.count,
      expiredApprovals: expired.count,
    };
  });
}

/**
 * Delete conversations whose LAST ACTIVITY is older than the retention window.
 *
 * Why `updatedAt` and not `createdAt`: retention is about how long a transcript is
 * kept, and an admin who opens a 60-day-old conversation and adds a turn has just
 * made it live again. Ageing on createdAt would delete a conversation out from
 * under them mid-use. `updatedAt` is also the column the sidebar orders by, so the
 * pruned set is exactly "conversations the admin has not touched in N days".
 *
 * CASCADE: AgentMessage and AgentApproval both declare onDelete: Cascade, so the
 * transcript and any bound approval rows go with the parent in the same statement.
 * Nothing is orphaned and there is no second pass to keep in sync.
 *
 * Bounded: a single DELETE is capped at MAX_PRUNE_BATCH. A retention job that
 * takes a table-wide lock while it chews through thousands of rows is exactly the
 * kind of job that takes the admin console down with it; the next tick continues
 * where this one stopped.
 *
 * @param {number} retentionDays  Window in days. 0 (or less) disables pruning.
 * @param {Date}   [now]         Injectable clock, for deterministic tests.
 * @returns {Promise<{ deleted: number, remaining: number|null, disabled: boolean }>}
 *   `remaining` is the count still past the cutoff after this batch, or null when
 *   the count query failed (pruning itself must not be reported as "all done").
 */
async function pruneExpiredConversations({ prisma, retentionDays, now = new Date() } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    return { deleted: 0, remaining: null, disabled: true };
  }

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Select-then-delete, not a single unbounded deleteMany: Postgres has no
  // DELETE ... LIMIT, so a bare deleteMany would lock and scan the whole expired
  // set in one statement. Taking ids first caps the DELETE at MAX_PRUNE_BATCH.
  // Ordering by updatedAt means a partial run still removes the least-recently-
  // used history first rather than an arbitrary set.
  const victims = await prisma.agentConversation.findMany({
    where: { updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: MAX_PRUNE_BATCH,
    select: { id: true },
  });

  if (victims.length === 0) {
    return { deleted: 0, remaining: 0, disabled: false };
  }

  const { count } = await prisma.agentConversation.deleteMany({
    where: { id: { in: victims.map((row) => row.id) } },
  });

  // Best-effort: a failure here must not misreport the run as complete, and must
  // not roll back the deletes that already succeeded.
  let remaining = null;
  try {
    remaining = await prisma.agentConversation.count({ where: { updatedAt: { lt: cutoff } } });
  } catch {
    remaining = null;
  }

  return { deleted: count, remaining, disabled: false };
}

module.exports = {
  AgentConversationError,
  buildTitle,
  getOrCreateConversation,
  createConversationWithTurn,
  appendMessage,
  recordTurn,
  listConversations,
  getMessages,
  // Phase 9
  searchConversations,
  renameConversation,
  deleteConversation,
  rewindToLastUserMessage,
  pruneExpiredConversations,
};
