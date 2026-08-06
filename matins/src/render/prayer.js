// Lineated text — prayers, and anything else meant to be said rather than
// skimmed. Content stores the received wording with our line breaks in it
// (see content/prayers.js); this turns that into stanzas of lines so each
// renderer can lay it out in its own way without re-deciding where the breaks
// go.
//
// Blank line -> new stanza. Single newline -> new line inside a stanza.

export function stanzas(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
    .filter((block) => block.length);
}

// Plain text: keep the lines, and indent continuations so a stanza reads as one
// unit in a monospace mail client.
export function stanzasToText(text, { indent = '  ' } = {}) {
  return stanzas(text)
    .map((block) => block.map((line) => indent + line).join('\n'))
    .join('\n\n');
}
