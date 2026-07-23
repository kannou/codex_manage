export function extractFencedCodeBlocks(source: string): readonly string[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^```[^`]*$/u.test(lines[index] ?? '')) continue;
    const code: string[] = [];
    index += 1;
    while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? '')) {
      code.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(code.join('\n'));
  }
  return blocks;
}
