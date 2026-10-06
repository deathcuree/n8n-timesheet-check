// Prepares what is sent to the language model and checks what comes back.
// The model never sees a name, email address, hours or clock time: each
// person becomes a placeholder such as "Person 1", and the real names are
// put back afterwards.
//
// This file has no imports so the same text can be pasted into an n8n Code
// node unchanged.

const MAX_REPLY_LENGTH = 1500;
const PLACEHOLDER_PATTERN = /Person (\d+)/g;

/**
 * @param exceptions  the list returned by findExceptions.
 * @returns           { items, names }. `items` is what goes to the model:
 *                    { placeholder, type, day } only. `names` maps each
 *                    placeholder to the real name and stays in the workflow.
 */
function buildLlmPayload(exceptions) {
  const placeholderByUser = new Map();
  const names = {};

  const items = exceptions.map((exception) => {
    let placeholder = null;
    if (exception.userId) {
      if (!placeholderByUser.has(exception.userId)) {
        const created = `Person ${placeholderByUser.size + 1}`;
        placeholderByUser.set(exception.userId, created);
        names[created] = exception.person;
      }
      placeholder = placeholderByUser.get(exception.userId);
    }
    return { placeholder, type: exception.type, day: exception.day };
  });

  return { items, names };
}

/**
 * Decides whether the model's reply can go in the email.
 * @returns  { ok: true } or { ok: false, reason }.
 */
function checkLlmReply(reply, names) {
  if (typeof reply !== 'string' || reply.trim() === '') {
    return { ok: false, reason: 'The reply is empty' };
  }
  if (reply.length > MAX_REPLY_LENGTH) {
    return { ok: false, reason: `The reply is longer than ${MAX_REPLY_LENGTH} characters` };
  }
  const unknown = (reply.match(PLACEHOLDER_PATTERN) ?? []).find((placeholder) => !(placeholder in names));
  if (unknown) {
    return { ok: false, reason: `The reply mentions ${unknown}, which was not sent` };
  }
  return { ok: true };
}

// Swaps each placeholder in an accepted reply for the real name.
function restoreNames(reply, names) {
  return reply.replace(PLACEHOLDER_PATTERN, (placeholder) => names[placeholder] ?? placeholder);
}

// Lets the tests load this file; has no effect inside an n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildLlmPayload, checkLlmReply, restoreNames, MAX_REPLY_LENGTH };
}
