import { commandExists, run } from "./process.ts";

const CANDIDATES: { command: string[]; when: () => boolean }[] = [
  { command: ["pbcopy"], when: () => process.platform === "darwin" },
  { command: ["wl-copy"], when: () => Boolean(process.env.WAYLAND_DISPLAY) },
  { command: ["xclip", "-selection", "clipboard"], when: () => Boolean(process.env.DISPLAY) },
  { command: ["xsel", "--clipboard", "--input"], when: () => Boolean(process.env.DISPLAY) },
  { command: ["clip.exe"], when: () => true },
];

/**
 * Copies text to the system clipboard with the first available platform tool.
 * Returns the tool name, or `null` when no tool is available or every attempt fails.
 */
export async function copyToClipboard(text: string): Promise<string | null> {
  for (const candidate of CANDIDATES) {
    const name = candidate.command[0]!;
    if (!candidate.when() || !commandExists(name)) continue;
    // clip.exe reads UTF-16LE with a byte order mark; other tools read UTF-8.
    const stdin = name === "clip.exe" ? utf16le(text) : text;
    const result = await run(candidate.command, { stdin });
    if (result.exitCode === 0) return name;
  }
  return null;
}

function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  return bytes;
}
