/** Exact string slices; offsets count JavaScript string characters, including UTF-16 code units. */
export function originalPage(text: string, id: string, offset = 0, limit = 6000, maxChars = 8000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('offset must be an integer within the original');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('page budget must be a positive integer');
  const page = (length: number) => ({ id, offset, text: text.slice(offset, offset + length), next_offset: offset + length < text.length ? offset + length : null, total_chars: text.length });
  let low = 0, high = Math.min(limit, text.length - offset, maxChars);
  if (JSON.stringify(page(0)).length > maxChars) throw new Error('page metadata exceeds its budget');
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(page(mid)).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  if (!low && offset < text.length) throw new Error('page budget cannot fit the next character');
  return page(low);
}
