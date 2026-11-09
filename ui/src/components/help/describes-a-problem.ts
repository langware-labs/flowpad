/** A request of one word ("hi9", "test") describes no problem: the diagnosis it triggers has nothing to look into. */
const MIN_DESCRIPTION_WORDS = 2;

export function describesAProblem(text: string): boolean {
  return (text.match(/[\p{L}\p{N}_]+/gu) ?? []).length >= MIN_DESCRIPTION_WORDS;
}
