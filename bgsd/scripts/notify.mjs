#!/usr/bin/env node
/**
 * notify.mjs — Pure notification logic for bgsd escalation events.
 *
 * shouldNotify(config, event)
 *   Returns true when OS notifications are enabled (config.notifications.os is
 *   not explicitly false) AND the event requires human input.
 *
 * composeNotification(event, conductor)
 *   Returns { title, body } for a macOS notification. Uses the conductor's
 *   name and emoji (defaults: Kiwi / 🥝).
 *
 * Dependency-injected and fully unit-testable: no I/O, no process calls.
 */

/** Events that require human input (the only ones that should notify). */
const HUMAN_INPUT_EVENTS = new Set(["needs_input", "escalation"]);

/**
 * Decide whether to fire an OS notification for the given event.
 *
 * Enabled unless config.notifications.os is explicitly false.
 * Only fires for events that require human input.
 *
 * @param {object|null|undefined} config  The bgsd config object (may be absent)
 * @param {string} event                  Event type string
 * @returns {boolean}
 */
export function shouldNotify(config, event) {
  if (config?.notifications?.os === false) return false;
  return HUMAN_INPUT_EVENTS.has(event);
}

/**
 * Compose a { title, body } object for a macOS display notification.
 *
 * @param {object} event
 * @param {string}  event.type       "needs_input" | "escalation"
 * @param {string}  [event.agentId]  Which agent hit the blocker
 * @param {string}  [event.question] The question needing human input
 * @param {object}  [conductor]      { name?: string, emoji?: string }
 * @returns {{ title: string, body: string }}
 */
export function composeNotification(event, conductor) {
  const name  = conductor?.name  || "Kiwi";
  const emoji = conductor?.emoji || "🥝";

  const title = `${emoji} ${name} needs your input`;

  const parts = [];
  if (event?.agentId) {
    parts.push(`Agent: ${event.agentId}`);
  }
  if (event?.question) {
    const q = String(event.question);
    parts.push(q.length > 120 ? q.slice(0, 117) + "..." : q);
  } else {
    parts.push("A pipeline agent is waiting for your decision.");
  }

  return { title, body: parts.join(" — ") };
}
