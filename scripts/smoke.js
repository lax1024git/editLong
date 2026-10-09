const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileSession } = require("../src/main/fileSession");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editlong-"));
  const file = path.join(dir, "sample.txt");
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`line-${i}-hello-${i % 7}`);
  fs.writeFileSync(file, lines.join("\n"), "utf8");

  const session = new FileSession();
  await session.open(file);
  await session.buildIndex();
  const meta = session.meta();
  if (meta.totalLines !== 5000) {
    throw new Error("expected 5000 lines, got " + meta.totalLines);
  }
  const chunk = await session.readLines(100, 3);
  if (!chunk.lines[0].text.startsWith("line-100-")) {
    throw new Error("bad line 100: " + chunk.lines[0].text);
  }
  const found = await session.findNext({
    query: "hello-3",
    isHex: false,
    fromOffset: 0,
    caseSensitive: true,
    reverse: false,
  });
  if (!found.found) throw new Error("text search missed");
  const hex = await session.findNext({
    query: "6C 69 6E 65 2D 32",
    isHex: true,
    fromOffset: 0,
    caseSensitive: true,
    reverse: false,
  });
  if (!hex.found) throw new Error("hex search missed");
  const bytes = await session.readBytes(0, 16);
  if (bytes.toString("utf8") !== "line-0-hello-0\nl".slice(0, 16) &&
      !bytes.toString("utf8").startsWith("line-0-hello-0")) {
    throw new Error("bytes read mismatch: " + bytes.toString("utf8"));
  }
  const big = path.join(dir, "big.bin");
  const fd = fs.openSync(big, "w");
  const block = Buffer.alloc(1024 * 1024, 0x41);
  block[0] = 0xff;
  block[1] = 0xd8;
  block[2] = 0xff;
  for (let i = 0; i < 17; i++) fs.writeSync(fd, block);
  fs.closeSync(fd);
  await session.open(big);
  if (session.meta().editable) throw new Error("17MB file should be view-only");
  await session.buildIndex();
  const jpeg = await session.findNext({
    query: "FF D8 FF",
    isHex: true,
    fromOffset: 0,
    caseSensitive: true,
    reverse: false,
  });
  if (!jpeg.found || jpeg.offset !== 0) throw new Error("jpeg magic not found");
  const windowBytes = await session.readBytes(0, 16);
  if (windowBytes[0] !== 0xff || windowBytes[3] !== 0x41) {
    throw new Error("hex window bytes mismatch");
  }

  const named = path.join(dir, "saved.txt");
  await session.close();
  session.encoding = "utf8";
  await session.saveText(named, "hello-save");
  if (!fs.readFileSync(named, "utf8").includes("hello-save")) {
    throw new Error("saveText did not write");
  }

  await session.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("smoke ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
