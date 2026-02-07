import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC = path.resolve(__dirname, '../../llm-streams-examples');
const DEST = path.resolve(__dirname, '../static/llm-streams-examples');

async function main() {
  await fs.mkdir(DEST, { recursive: true });
  const files = await fs.readdir(SRC);
  for (const file of files) {
    await fs.copyFile(path.join(SRC, file), path.join(DEST, file));
  }
  console.log(`Copied ${files.length} files to ${DEST}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
