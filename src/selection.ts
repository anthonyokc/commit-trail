export const MAX_RANGE_SIZE = 1000;

/**
 * Converts selection arguments to pull request numbers in first-seen order.
 * Accepts `12`, `#12`, inclusive ranges `1:12` and `1-12`, and comma-separated lists of these forms.
 * Throws an error that names the first invalid argument.
 */
export function parseSelection(args: string[]): number[] {
  const numbers: number[] = [];
  const seen = new Set<number>();
  const add = (n: number) => {
    if (!seen.has(n)) {
      seen.add(n);
      numbers.push(n);
    }
  };

  for (const arg of args.flatMap((value) => value.split(",")).map((value) => value.trim())) {
    if (arg === "") continue;
    const single = /^#?(\d+)$/.exec(arg);
    if (single) {
      add(positive(Number(single[1]), arg));
      continue;
    }
    const range = /^#?(\d+)[:-]#?(\d+)$/.exec(arg);
    if (range) {
      const start = positive(Number(range[1]), arg);
      const end = positive(Number(range[2]), arg);
      if (end < start) throw new Error(`Invalid range "${arg}": the end (${end}) is smaller than the start (${start}).`);
      if (end - start + 1 > MAX_RANGE_SIZE) throw new Error(`Invalid range "${arg}": a range can contain at most ${MAX_RANGE_SIZE} numbers.`);
      for (let n = start; n <= end; n++) add(n);
      continue;
    }
    throw new Error(`Invalid pull request selection "${arg}". Use a number (12), a range (1:12 or 1-12), or a list (1 2 3).`);
  }
  return numbers;
}

function positive(n: number, arg: string): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid pull request number in "${arg}". Numbers start at 1.`);
  return n;
}

/** Formats numbers as a compact list, for example `#1–#4, #8, #10`. */
export function formatNumbers(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; ) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    const first = sorted[index]!;
    const last = sorted[end]!;
    if (end - index >= 2) parts.push(`#${first}–#${last}`);
    else for (let k = index; k <= end; k++) parts.push(`#${sorted[k]}`);
    index = end + 1;
  }
  return parts.join(", ");
}
