/** Preserve decimal model identities before JSON.parse can round unsafe integers.
 * Only identity number tokens change; quoted strings and other numeric fields do not.
 */
export function parseModelIdentityJson(text: string): unknown {
  const parts: string[] = [];
  let copied = 0;
  let property = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index++;
      // Skip the complete JSON string, including escaped quotes and backslashes.
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index++] === '"') break;
      }
      let next = index;
      while (next < text.length && ' \t\r\n'.includes(text[next])) next += 1;
      property = text[next] === ':' ? JSON.parse(text.slice(start, index)) as string : '';
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      const start = index++;
      while (index < text.length && '0123456789eE+.-'.includes(text[index])) index += 1;
      const number = text.slice(start, index);
      if ((property === 'generation' || property === 'model_generation') &&
          /^-?(?:0|[1-9]\d*)$/.test(number) && !Number.isSafeInteger(Number(number))) {
        parts.push(text.slice(copied, start), JSON.stringify(number));
        copied = index;
      }
      property = '';
    } else {
      if (char !== ':' && !' \t\r\n'.includes(char)) property = '';
      index += 1;
    }
  }

  parts.push(text.slice(copied));
  return JSON.parse(parts.join('')) as unknown;
}
