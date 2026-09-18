// src/utils/concurrency.js
'use strict';
/**
 * Minimal promise semaphore — bounds concurrent execution of a critical
 * section (login handler: caps simultaneous bcrypt+DB checks). No dependency:
 * ~20 lines, single use-site (YAGNI over p-limit).
 * FIFO queue; the slot is released in `finally`, so throwing callers can't leak it.
 */
function createSemaphore(max) {
  const cap = Math.max(1, Number(max) || 1);
  let active = 0;
  const queue = [];
  async function acquire(fn) {
    if (active >= cap) await new Promise((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  }
  return acquire;
}
module.exports = { createSemaphore };
