import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

/** Every file below `dir`, as a `/`-separated path relative to the repo root. */
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(relativePath) : [relativePath];
  });

const sorted = (values: string[]): string[] => [...values].sort();

const srcModules = walk("src").filter((file) => file.endsWith(".ts"));
const testSuites = walk("tests").filter((file) => file.endsWith(".test.ts"));

// The three lists these check are hand-written prose, so nothing but a check keeps them
// honest: the module table and the project tree have each been a file behind the module
// they describe (f26d160, 55943ee), and the test list was six suites short before 6e056c8.
// Only membership is compared -- what a row says about its module cannot be read off the
// tree -- and a docs edit that adds or removes a row has to carry its list along.
describe("hand-written inventories match the files they describe", () => {
  it("docs/contributing.md lists every test suite", () => {
    const listed = [...read("docs/contributing.md").matchAll(/^- `(tests\/[^`]+)`/gm)].map(
      (match) => match[1],
    );

    expect(sorted(listed)).toEqual(sorted(testSuites));
  });

  it("docs/architecture.md's module table lists every source module", () => {
    const listed = [...read("docs/architecture.md").matchAll(/^\| `([^`]+\.ts)` \| /gm)].map(
      (match) => match[1],
    );

    expect(sorted(listed)).toEqual(sorted(srcModules.map((file) => file.slice("src/".length))));
  });

  it("docs/contributing.md's project tree lists every source file", () => {
    const section = read("docs/contributing.md").split(/^## Project Structure$/m)[1] ?? "";
    const tree = /```[^\n]*\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    const listed = [...tree.matchAll(/^\s*[│├└─\s]*([\w.-]+\.ts)\s+#/gm)].map((match) => match[1]);

    expect(sorted(listed)).toEqual(sorted(srcModules.map((file) => path.basename(file))));
  });
});
