/** Minimal ANSI helpers. Colors are disabled for non-TTYs and NO_COLOR. */
const useColor = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

function wrap(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const color = {
  bold: (t: string) => wrap("1", t),
  dim: (t: string) => wrap("2", t),
  red: (t: string) => wrap("31", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  cyan: (t: string) => wrap("36", t),
};

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${color.yellow("warning:")} ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${color.red("error:")} ${message}\n`);
}
