const INLINE_TOKEN = /(`[^`\n]+`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/u;

export function renderMarkdown(target: HTMLElement, source: string): void {
  if (target.dataset.markdownSource === source) {
    return;
  }
  delete target.dataset.plainTextSource;
  target.dataset.markdownSource = source;
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```([^`]*)$/u.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const language = fence[1]?.trim();
      if (language && /^[\w+-]+$/u.test(language)) code.className = `language-${language}`;
      code.textContent = codeLines.join('\n');
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1]?.length ?? 1}`);
      appendInline(element, heading[2] ?? '');
      fragment.append(element);
      index += 1;
      continue;
    }

    if (/^>\s?/u.test(line)) {
      const quote = document.createElement('blockquote');
      const values: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index] ?? '')) {
        values.push((lines[index] ?? '').replace(/^>\s?/u, ''));
        index += 1;
      }
      appendInline(quote, values.join('\n'));
      fragment.append(quote);
      continue;
    }

    if (parseListLine(line)) {
      const rendered = renderList(lines, index);
      fragment.append(rendered.list);
      index = rendered.nextIndex;
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && isParagraphContinuation(lines[index] ?? '')) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    const paragraph = document.createElement('p');
    appendInline(paragraph, paragraphLines.join('\n'));
    fragment.append(paragraph);
  }

  target.replaceChildren(fragment);
}

export function renderPlainText(target: HTMLElement, source: string): void {
  if (target.dataset.plainTextSource === source) {
    return;
  }
  delete target.dataset.markdownSource;
  target.dataset.plainTextSource = source;
  target.textContent = source;
}

interface ParsedListLine {
  readonly indent: number;
  readonly ordered: boolean;
  readonly text: string;
}

interface ListFrame {
  readonly indent: number;
  readonly ordered: boolean;
  readonly list: HTMLElement;
  readonly parentItem: HTMLElement | null;
  lastItem: HTMLElement | null;
}

function renderList(
  lines: readonly string[],
  startIndex: number
): { readonly list: HTMLElement; readonly nextIndex: number } {
  const first = parseListLine(lines[startIndex] ?? '');
  if (!first) {
    throw new Error('Expected a Markdown list item.');
  }
  const root = document.createElement(first.ordered ? 'ol' : 'ul');
  const stack: ListFrame[] = [{
    indent: first.indent,
    ordered: first.ordered,
    list: root,
    parentItem: null,
    lastItem: null
  }];
  let index = startIndex;

  while (index < lines.length) {
    const parsed = parseListLine(lines[index] ?? '');
    if (!parsed || parsed.indent < first.indent) break;
    while (stack.length > 1 && parsed.indent < (stack.at(-1)?.indent ?? 0)) {
      stack.pop();
    }

    let frame = stack.at(-1);
    if (!frame) break;
    if (parsed.indent > frame.indent) {
      if (!frame.lastItem) break;
      const nested = document.createElement(parsed.ordered ? 'ol' : 'ul');
      frame.lastItem.append(nested);
      frame = {
        indent: parsed.indent,
        ordered: parsed.ordered,
        list: nested,
        parentItem: frame.lastItem,
        lastItem: null
      };
      stack.push(frame);
    } else if (parsed.indent !== frame.indent) {
      break;
    } else if (parsed.ordered !== frame.ordered) {
      if (!frame.parentItem) break;
      const sibling = document.createElement(parsed.ordered ? 'ol' : 'ul');
      frame.parentItem.append(sibling);
      frame = {
        indent: parsed.indent,
        ordered: parsed.ordered,
        list: sibling,
        parentItem: frame.parentItem,
        lastItem: null
      };
      stack[stack.length - 1] = frame;
    }

    const item = document.createElement('li');
    appendInline(item, parsed.text);
    frame.list.append(item);
    frame.lastItem = item;
    index += 1;
  }

  return { list: root, nextIndex: index };
}

function parseListLine(line: string): ParsedListLine | null {
  const match = /^([ \t]*)(?:([-+*])|(\d+)\.)\s+(.+)$/u.exec(line);
  if (!match) return null;
  return {
    indent: [...(match[1] ?? '')].reduce(
      (width, character) => width + (character === '\t' ? 4 : 1),
      0
    ),
    ordered: match[3] !== undefined,
    text: match[4] ?? ''
  };
}

function isParagraphContinuation(line: string): boolean {
  return Boolean(
    line.trim() &&
    !/^```/u.test(line) &&
    !/^(#{1,6})\s+/u.test(line) &&
    !/^>\s?/u.test(line) &&
    !/^\s*(?:[-+*]|\d+\.)\s+/u.test(line)
  );
}

function appendInline(parent: HTMLElement, value: string): void {
  let remaining = value;
  while (remaining) {
    const match = INLINE_TOKEN.exec(remaining);
    if (!match || match.index === undefined) {
      appendText(parent, remaining);
      return;
    }
    appendText(parent, remaining.slice(0, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const url = safeLink(match[3]);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        appendInline(link, match[2]);
        parent.append(link);
      } else {
        appendText(parent, match[2]);
      }
    } else {
      const strong = match[4] ?? match[5];
      const emphasis = match[6] ?? match[7];
      const element = document.createElement(strong !== undefined ? 'strong' : 'em');
      appendInline(element, strong ?? emphasis ?? '');
      parent.append(element);
    }
    remaining = remaining.slice(match.index + token.length);
  }
}

function appendText(parent: HTMLElement, value: string): void {
  const parts = value.split('\n');
  parts.forEach((part, index) => {
    if (index > 0) parent.append(document.createElement('br'));
    if (part) parent.append(document.createTextNode(part));
  });
}

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
