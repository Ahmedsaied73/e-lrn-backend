'use strict';

const defaultPrisma = require('../../config/db');
const defaultLlmProvider = require('../agent/llmProvider');
const config = require('../../config/env');
const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages');
const { buildSystemPrompt } = require('./systemPrompt');

/**
 * Sends a message in a student AI chat session and returns the assistant's reply.
 *
 * Rules:
 * - Scoped strictly to (userId, sessionId)
 * - Loads last 20 messages from DB in chronological order (oldest to newest)
 * - Reuses Admin Agent Gemini client/key with failover
 * - Saves user and assistant messages ONLY after Gemini succeeds
 *
 * @param {Object} params
 * @param {number} params.userId
 * @param {string} params.sessionId
 * @param {string} params.message
 * @param {Object} [deps] - Optional test injection seams
 * @param {Object} [deps.prisma]
 * @param {Object} [deps.llmProvider]
 * @returns {Promise<{ reply: string }>}
 */
async function sendMessage({ userId, sessionId, message }, deps = {}) {
  const db = deps.prisma || defaultPrisma;
  const llm = deps.llmProvider || defaultLlmProvider;

  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    const err = new Error('Invalid userId');
    err.status = 400;
    throw err;
  }

  const cleanSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!cleanSessionId) {
    const err = new Error('Invalid sessionId');
    err.status = 400;
    throw err;
  }

  const cleanMessage = typeof message === 'string' ? message.trim() : '';
  if (!cleanMessage || cleanMessage.length > 500) {
    const err = new Error('Message must be between 1 and 500 characters');
    err.status = 400;
    throw err;
  }

  const maxHistory = (config.aiStudent && config.aiStudent.maxHistoryMessages) || 20;

  // Query last N messages scoped strictly to (userId, sessionId)
  const historyRows = await db.aiStudentMessage.findMany({
    where: {
      userId: numericUserId,
      sessionId: cleanSessionId,
    },
    orderBy: { createdAt: 'desc' },
    take: maxHistory,
  });

  // Reverse to put in chronological order (oldest to newest)
  const chronologicalHistory = [...historyRows].reverse();

  // Build message sequence for LangChain
  const systemPromptText = buildSystemPrompt();
  const langChainMessages = [new SystemMessage(systemPromptText)];

  for (const row of chronologicalHistory) {
    if (row.role === 'USER') {
      langChainMessages.push(new HumanMessage(row.content));
    } else if (row.role === 'ASSISTANT') {
      langChainMessages.push(new AIMessage(row.content));
    }
  }

  langChainMessages.push(new HumanMessage(cleanMessage));

  const options = {
    model: config.aiStudent && config.aiStudent.model,
    fallbackModel: config.aiAgent && config.aiAgent.fallbackModel,
    temperature: (config.aiStudent && typeof config.aiStudent.temperature === 'number') ? config.aiStudent.temperature : 0.3,
    maxOutputTokens: (config.aiStudent && config.aiStudent.maxOutputTokens) || 800,
  };

  // Invoke Gemini with failover
  const { result } = await llm.invokeWithFailover(async (model) => {
    const response = await model.invoke(langChainMessages);
    return typeof response.content === 'string'
      ? response.content
      : (Array.isArray(response.content)
        ? response.content.map((c) => (c && c.text) || c).join('')
        : String(response.content || ''));
  }, options);

  const replyText = (result || '').trim();

  // Save both user and assistant messages in DB ONLY after Gemini succeeds
  await db.$transaction([
    db.aiStudentMessage.create({
      data: {
        userId: numericUserId,
        sessionId: cleanSessionId,
        role: 'USER',
        content: cleanMessage,
      },
    }),
    db.aiStudentMessage.create({
      data: {
        userId: numericUserId,
        sessionId: cleanSessionId,
        role: 'ASSISTANT',
        content: replyText,
      },
    }),
  ]);

  return { reply: replyText };
}

module.exports = {
  sendMessage,
};
