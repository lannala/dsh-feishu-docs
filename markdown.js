const HEADING_KEYS = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'];

function textBlock(blockType, key, content) {
  return {
    block_type: blockType,
    [key]: {
      elements: [{ text_run: { content } }],
    },
  };
}

/** Convert a deliberately small Markdown subset into Docx child blocks. */
export function markdownToBlocks(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const blocks = [];
  let inCode = false;
  let codeLines = [];

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        blocks.push(textBlock(14, 'code', codeLines.join('\n')));
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (line.trim().length === 0) continue;

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(textBlock(level + 2, HEADING_KEYS[level - 1], heading[2].trim()));
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      blocks.push(textBlock(12, 'bullet', bullet[1]));
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      blocks.push(textBlock(13, 'ordered', ordered[1]));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(textBlock(15, 'quote', quote[1]));
      continue;
    }
    blocks.push(textBlock(2, 'text', line));
  }

  if (inCode) blocks.push(textBlock(14, 'code', codeLines.join('\n')));
  return blocks;
}
