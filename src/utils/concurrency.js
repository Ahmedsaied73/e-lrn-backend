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
    // Ownership transfer: when a slot frees, the release path increments on
    // behalf of the woken waiter (which does NOT increment itself). A fresh
    // arrival therefore never sneaks in between the decrement and the
    // waiter's resumption — the cap can never be transiently exceeded.
    if (active >= cap) {
      await new Promise((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) {
        active++;
        next();
      }
    }
  }
  return acquire;
}
module.exports = { createSemaphore };
